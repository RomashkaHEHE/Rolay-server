import { AppEnv } from "../config/env";
import { AppError } from "../core/errors";
import { createOpaqueToken } from "../core/ids";
import {
  BlobDownloadTicketRecord,
  BlobObject,
  BlobUploadTicketRecord,
  CrdtTokenRecord,
  FileEntry,
  Membership,
  User,
  WorkspaceRole
} from "../domain/types";
import { MemoryState, StoredWorkspace } from "./memory-state";
import { StateStore } from "./state-store";
import { StorageService } from "./storage-service";

interface EntryAccessContext {
  workspace: StoredWorkspace;
  membership: Membership;
  entry: FileEntry;
}

interface CrdtTokenResponse {
  entryId: string;
  docId: string;
  provider: string;
  wsUrl: string;
  token: string;
  expiresAt: string;
}

interface BlobUploadResponse {
  alreadyExists: boolean;
  upload?: {
    method: "PUT";
    url: string;
    headers: Record<string, string>;
  };
}

interface BlobDownloadResponse {
  hash: string;
  url: string;
}

export class FileService {
  constructor(
    private readonly state: MemoryState,
    private readonly env: AppEnv,
    private readonly storage: StorageService,
    private readonly stateStore: StateStore
  ) {}

  async createCrdtToken(actor: User, entryId: string): Promise<CrdtTokenResponse> {
    const context = this.requireEntryAccess(actor.id, entryId);
    if (context.entry.deleted || context.entry.kind !== "markdown" || !context.entry.docId) {
      throw new AppError(404, "entry_not_found", "Markdown entry not found.");
    }

    const record: CrdtTokenRecord = {
      token: createOpaqueToken(),
      workspaceId: context.workspace.workspace.id,
      entryId: context.entry.id,
      docId: context.entry.docId,
      userId: actor.id,
      role: context.membership.role,
      expiresAt: this.createExpiry(this.env.crdtTokenTtlSeconds)
    };

    this.state.crdtTokens.set(record.token, record);
    await this.stateStore.saveState(this.state);
    return {
      entryId: record.entryId,
      docId: record.docId,
      provider: this.env.crdtProvider,
      wsUrl: this.env.crdtWsUrl,
      token: record.token,
      expiresAt: record.expiresAt
    };
  }

  async createBlobUploadTicket(
    actor: User,
    entryId: string,
    hash: string,
    sizeBytes: number,
    mimeType: string
  ): Promise<BlobUploadResponse> {
    const context = this.requireEntryAccess(actor.id, entryId);
    this.assertCanWrite(context.membership.role);
    this.assertBinaryEntry(context.entry);
    this.assertSha256Hash(hash);

    if (
      context.entry.blob?.hash === hash ||
      this.state.blobObjects.has(hash) ||
      await this.storage.hasBlob(hash)
    ) {
      return {
        alreadyExists: true
      };
    }

    const ticket: BlobUploadTicketRecord = {
      ticketId: createOpaqueToken(),
      workspaceId: context.workspace.workspace.id,
      entryId: context.entry.id,
      userId: actor.id,
      hash,
      sizeBytes,
      mimeType,
      expiresAt: this.createExpiry(this.env.blobTicketTtlSeconds)
    };

    this.state.blobUploadTickets.set(ticket.ticketId, ticket);
    await this.stateStore.saveState(this.state);
    return {
      alreadyExists: false,
      upload: {
        method: "PUT",
        url: `${this.env.blobUploadBaseUrl}/${ticket.ticketId}`,
        headers: {
          "content-type": mimeType
        }
      }
    };
  }

  async createBlobDownloadTicket(
    actor: User,
    entryId: string
  ): Promise<BlobDownloadResponse> {
    const context = this.requireEntryAccess(actor.id, entryId);
    this.assertBinaryEntry(context.entry);
    if (!context.entry.blob) {
      throw new AppError(404, "entry_not_found", "Binary blob revision not found.");
    }

    const ticket: BlobDownloadTicketRecord = {
      ticketId: createOpaqueToken(),
      workspaceId: context.workspace.workspace.id,
      entryId: context.entry.id,
      userId: actor.id,
      hash: context.entry.blob.hash,
      expiresAt: this.createExpiry(this.env.blobTicketTtlSeconds)
    };

    this.state.blobDownloadTickets.set(ticket.ticketId, ticket);
    await this.stateStore.saveState(this.state);
    return {
      hash: ticket.hash,
      url: `${this.env.blobDownloadBaseUrl}/${ticket.ticketId}`
    };
  }

  private requireEntryAccess(userId: string, entryId: string): EntryAccessContext {
    for (const workspace of this.state.workspaces.values()) {
      const entry = workspace.entries.get(entryId);
      if (!entry) {
        continue;
      }

      const membership = workspace.memberships.get(userId);
      if (!membership) {
        throw new AppError(403, "forbidden", "User is not a workspace member.");
      }

      return {
        workspace,
        membership,
        entry
      };
    }

    throw new AppError(404, "entry_not_found", "Entry not found.");
  }

  private assertBinaryEntry(entry: FileEntry): void {
    if (entry.deleted || entry.kind !== "binary") {
      throw new AppError(404, "entry_not_found", "Binary entry not found.");
    }
  }

  private assertCanWrite(role: WorkspaceRole): void {
    if (role === "viewer") {
      throw new AppError(403, "forbidden", "Editor access is required.");
    }
  }

  private assertSha256Hash(hash: string): void {
    if (!/^sha256:[A-Za-z0-9+/=_-]{6,}$/.test(hash)) {
      throw new AppError(
        400,
        "invalid_request",
        'Field "hash" must use the "sha256:<digest>" format.'
      );
    }
  }

  private createExpiry(ttlSeconds: number): string {
    return new Date(Date.now() + ttlSeconds * 1000).toISOString();
  }
}
