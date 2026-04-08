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
  User
} from "../domain/types";
import { MemoryState, StoredWorkspace } from "./memory-state";
import { StateStore } from "./state-store";
import { StorageService } from "./storage-service";
import * as Y from "yjs";

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
  uploadId?: string;
  hash?: string;
  sizeBytes?: number;
  mimeType?: string;
  expiresAt?: string;
  upload?: {
    method: "PUT";
    url: string;
    headers: Record<string, string>;
  };
  cancel?: {
    method: "DELETE";
    url: string;
  };
}

interface CancelBlobUploadResponse {
  ok: true;
  uploadId: string;
  wasActive: boolean;
}

interface BlobDownloadResponse {
  hash: string;
  sizeBytes: number;
  mimeType: string;
  url: string;
}

interface CrdtBootstrapDocument {
  entryId: string;
  docId: string;
  stateBytes: number;
  encodedBytes: number;
  state?: string;
}

interface CrdtBootstrapResponse {
  workspaceId: string;
  encoding: "base64";
  includesState: boolean;
  documentCount: number;
  totalStateBytes: number;
  totalEncodedBytes: number;
  documents: CrdtBootstrapDocument[];
}

const EMPTY_CRDT_STATE = Y.encodeStateAsUpdate(new Y.Doc());

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

  async bootstrapMarkdownDocuments(
    actor: User,
    workspaceId: string,
    entryIds?: string[],
    options: { includeState?: boolean } = {}
  ): Promise<CrdtBootstrapResponse> {
    const workspace = this.requireWorkspaceAccess(actor.id, workspaceId);
    const entries = this.resolveBootstrapEntries(workspace, entryIds);
    const includeState = options.includeState !== false;
    const documents = await Promise.all(
      entries.map(async (entry) => {
        const storedState = await this.storage.loadDocument(entry.docId!);
        const state = storedState ?? EMPTY_CRDT_STATE;
        const encodedState = Buffer.from(state).toString("base64");

        return {
          entryId: entry.id,
          docId: entry.docId!,
          stateBytes: state.byteLength,
          encodedBytes: Buffer.byteLength(encodedState, "utf8"),
          ...(includeState ? { state: encodedState } : {})
        };
      })
    );
    const totalStateBytes = documents.reduce((sum, document) => sum + document.stateBytes, 0);
    const totalEncodedBytes = documents.reduce((sum, document) => sum + document.encodedBytes, 0);

    return {
      workspaceId: workspace.workspace.id,
      encoding: "base64",
      includesState: includeState,
      documentCount: documents.length,
      totalStateBytes,
      totalEncodedBytes,
      documents
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
    this.assertBinaryEntry(context.entry);
    this.assertSha256Hash(hash);

    if (
      context.entry.blob?.hash === hash ||
      this.state.blobObjects.has(hash) ||
      await this.storage.hasBlob(hash)
    ) {
      return {
        alreadyExists: true,
        hash,
        sizeBytes,
        mimeType
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
      uploadId: ticket.ticketId,
      hash,
      sizeBytes,
      mimeType,
      expiresAt: ticket.expiresAt,
      upload: {
        method: "PUT",
        url: `${this.env.blobUploadBaseUrl}/${ticket.ticketId}`,
        headers: {
          "content-type": mimeType
        }
      },
      cancel: {
        method: "DELETE",
        url: `${this.env.publicBaseUrl}/v1/files/${context.entry.id}/blob/uploads/${ticket.ticketId}`
      }
    };
  }

  async cancelBlobUpload(
    actor: User,
    entryId: string,
    uploadId: string
  ): Promise<CancelBlobUploadResponse> {
    const context = this.requireEntryAccess(actor.id, entryId);
    this.assertBinaryEntry(context.entry);

    const ticket = this.state.blobUploadTickets.get(uploadId);
    if (!ticket || ticket.entryId !== context.entry.id) {
      throw new AppError(404, "upload_ticket_not_found", "Upload ticket not found.");
    }
    if (ticket.userId !== actor.id && !actor.isAdmin) {
      throw new AppError(403, "forbidden", "Only the uploader or admin can cancel uploads.");
    }

    this.state.blobUploadTickets.delete(uploadId);
    const wasActive = await this.storage.cancelActiveUpload(uploadId);
    await this.stateStore.saveState(this.state);

    return {
      ok: true,
      uploadId,
      wasActive
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
      sizeBytes: context.entry.blob.sizeBytes,
      mimeType: context.entry.blob.mimeType,
      url: `${this.env.blobDownloadBaseUrl}/${ticket.ticketId}`
    };
  }

  private requireWorkspaceAccess(userId: string, workspaceId: string): StoredWorkspace {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace) {
      throw new AppError(404, "workspace_not_found", "Workspace not found.");
    }

    if (!workspace.memberships.has(userId)) {
      throw new AppError(403, "forbidden", "User is not a workspace member.");
    }

    return workspace;
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

  private resolveBootstrapEntries(
    workspace: StoredWorkspace,
    entryIds?: string[]
  ): FileEntry[] {
    if (!entryIds) {
      return [...workspace.entries.values()]
        .filter(
          (entry) =>
            !entry.deleted &&
            entry.kind === "markdown" &&
            entry.contentMode === "crdt" &&
            !!entry.docId
        )
        .sort((left, right) => left.path.localeCompare(right.path));
    }

    const resolved: FileEntry[] = [];
    const seen = new Set<string>();
    for (const entryId of entryIds) {
      if (seen.has(entryId)) {
        continue;
      }
      seen.add(entryId);

      const entry = workspace.entries.get(entryId);
      if (!entry || entry.deleted || entry.kind !== "markdown" || !entry.docId) {
        throw new AppError(404, "entry_not_found", "Markdown entry not found.");
      }

      resolved.push(entry);
    }

    return resolved;
  }

  private assertBinaryEntry(entry: FileEntry): void {
    if (entry.deleted || entry.kind !== "binary") {
      throw new AppError(404, "entry_not_found", "Binary entry not found.");
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
