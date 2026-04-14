import { Readable } from "node:stream";

import { AppEnv } from "../config/env";
import { AppError } from "../core/errors";
import { definedTraceFields } from "../core/blob-trace";
import { normalizeSha256Hash as normalizeSha256Digest } from "../core/hashes";
import { createOpaqueToken } from "../core/ids";
import {
  BlobDownloadTicketRecord,
  BlobObject,
  BlobRevision,
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
  uploadedBytes?: number;
  status?: "pending" | "uploading" | "ready" | "expired";
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

interface BlobUploadContentResponse {
  ok: true;
  uploadId: string;
  receivedBytes: number;
  uploadedBytes: number;
  sizeBytes: number;
  complete: boolean;
  hash?: string;
}

interface BlobDownloadResponse {
  hash: string;
  sizeBytes: number;
  mimeType: string;
  url: string;
  contentUrl: string;
  rangeSupported: true;
}

interface BlobContentResponse {
  hash: string;
  sizeBytes: number;
  mimeType: string;
  startOffset: number;
  endOffset: number;
  contentLength: number;
  partial: boolean;
  stream: Readable;
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

interface BlobEntryTraceContext {
  workspaceId: string;
  entryId: string;
  hash?: string;
  sizeBytes?: number;
  mimeType?: string;
}

interface BlobUploadTraceContext extends BlobEntryTraceContext {
  uploadId: string;
  uploadedBytes: number;
}

interface BlobDownloadTicketTraceContext extends BlobEntryTraceContext {
  ticketId: string;
}

const EMPTY_CRDT_STATE = Y.encodeStateAsUpdate(new Y.Doc());

export class FileService {
  constructor(
    private readonly state: MemoryState,
    private readonly env: AppEnv,
    private readonly storage: StorageService,
    private readonly stateStore: StateStore
  ) {}

  getBlobEntryTraceContext(actor: User, entryId: string): BlobEntryTraceContext {
    const context = this.requireEntryAccess(actor.id, entryId);
    this.assertBlobBackedEntry(context.entry);

    return {
      workspaceId: context.workspace.workspace.id,
      entryId: context.entry.id,
      ...definedTraceFields({
        hash: context.entry.blob?.hash,
        sizeBytes: context.entry.blob?.sizeBytes,
        mimeType: context.entry.blob?.mimeType ?? context.entry.mimeType
      })
    };
  }

  getBlobUploadTraceContext(uploadId: string): BlobUploadTraceContext {
    const ticket = this.requireBlobUploadTicket(uploadId);

    return {
      workspaceId: ticket.workspaceId,
      entryId: ticket.entryId,
      uploadId: ticket.ticketId,
      hash: ticket.hash,
      sizeBytes: ticket.sizeBytes,
      mimeType: ticket.mimeType,
      uploadedBytes: ticket.uploadedBytes
    };
  }

  async getBlobDownloadTicketTraceContext(
    ticketId: string
  ): Promise<BlobDownloadTicketTraceContext> {
    const ticket = await this.requireBlobDownloadTicket(ticketId);

    return {
      workspaceId: ticket.workspaceId,
      entryId: ticket.entryId,
      ticketId: ticket.ticketId,
      hash: ticket.hash
    };
  }

  async createCrdtToken(actor: User, entryId: string): Promise<CrdtTokenResponse> {
    const context = this.requireEntryAccess(actor.id, entryId);
    if (context.entry.deleted) {
      throw new AppError(404, "entry_not_found", "Markdown entry not found.");
    }
    if (context.entry.kind !== "markdown" || !context.entry.docId) {
      throw new AppError(
        400,
        "unsupported_entry_kind",
        "Only markdown entries can create CRDT sessions.",
        {
          entryKind: context.entry.kind
        }
      );
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
    // Bootstrap preloads persisted Yjs state so a client can hydrate local cache and work safely
    // offline. Live collaboration still happens over the CRDT websocket, not through this endpoint.
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
    this.assertBlobBackedEntry(context.entry);
    const normalizedHash = this.normalizeSha256Hash(hash);

    if (
      context.entry.blob?.hash === normalizedHash ||
      this.state.blobObjects.has(normalizedHash) ||
      await this.storage.hasBlob(normalizedHash)
    ) {
      // Blob storage is content-addressed, so identical payloads can skip the byte transfer and
      // only publish a new tree revision.
      return {
        alreadyExists: true,
        hash: normalizedHash,
        sizeBytes,
        mimeType,
        uploadedBytes: sizeBytes,
        status: "ready"
      };
    }

    const resumedTicket = await this.findReusableUploadTicket(
      actor.id,
      context.entry.id,
      normalizedHash,
      sizeBytes,
      mimeType
    );
    if (resumedTicket) {
      return this.toBlobUploadResponse(context.entry.id, resumedTicket);
    }

    const ticket: BlobUploadTicketRecord = {
      ticketId: createOpaqueToken(),
      workspaceId: context.workspace.workspace.id,
      entryId: context.entry.id,
      userId: actor.id,
      hash: normalizedHash,
      sizeBytes,
      mimeType,
      uploadedBytes: 0,
      expiresAt: this.createExpiry(this.env.blobTicketTtlSeconds)
    };

    this.state.blobUploadTickets.set(ticket.ticketId, ticket);
    await this.stateStore.saveState(this.state);
    return this.toBlobUploadResponse(context.entry.id, ticket);
  }

  async cancelBlobUpload(
    actor: User,
    entryId: string,
    uploadId: string
  ): Promise<CancelBlobUploadResponse> {
    const context = this.requireEntryAccess(actor.id, entryId);
    this.assertBlobBackedEntry(context.entry);

    const ticket = this.state.blobUploadTickets.get(uploadId);
    if (!ticket || ticket.entryId !== context.entry.id) {
      throw new AppError(404, "upload_ticket_not_found", "Upload ticket not found.");
    }
    if (ticket.userId !== actor.id && !actor.isAdmin) {
      throw new AppError(403, "forbidden", "Only the uploader or admin can cancel uploads.");
    }

    this.state.blobUploadTickets.delete(uploadId);
    // Removing the ticket prevents a later commit path from treating this upload as valid.
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
    this.assertBlobBackedEntry(context.entry);
    if (!context.entry.blob) {
      throw new AppError(404, "entry_not_found", "Blob revision not found.");
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
      url: `${this.env.blobDownloadBaseUrl}/${ticket.ticketId}`,
      contentUrl: `${this.env.publicBaseUrl}/v1/files/${context.entry.id}/blob/content`,
      rangeSupported: true
    };
  }

  async uploadBlobContent(
    actor: User,
    entryId: string,
    uploadId: string,
    payload: Readable,
    requestContentType?: string,
    contentRangeHeader?: string
  ): Promise<BlobUploadContentResponse> {
    const context = this.requireEntryAccess(actor.id, entryId);
    this.assertBlobBackedEntry(context.entry);

    const ticket = this.requireBlobUploadTicket(uploadId);
    if (ticket.entryId !== context.entry.id) {
      throw new AppError(404, "upload_ticket_not_found", "Upload ticket not found.");
    }
    if (ticket.userId !== actor.id && !actor.isAdmin) {
      throw new AppError(403, "forbidden", "Only the uploader or admin can upload blob content.");
    }

    return this.finishBlobUpload(ticket, payload, requestContentType, contentRangeHeader);
  }

  async uploadBlobContentByTicket(
    uploadId: string,
    payload: Readable,
    requestContentType?: string,
    contentRangeHeader?: string
  ): Promise<BlobUploadContentResponse> {
    const ticket = this.requireBlobUploadTicket(uploadId);
    return this.finishBlobUpload(ticket, payload, requestContentType, contentRangeHeader);
  }

  async getBlobContent(
    actor: User,
    entryId: string,
    rangeHeader?: string
  ): Promise<BlobContentResponse> {
    const context = this.requireEntryAccess(actor.id, entryId);
    this.assertBlobBackedEntry(context.entry);
    if (!context.entry.blob) {
      throw new AppError(404, "entry_not_found", "Blob revision not found.");
    }

    return this.readBlobContent(context.entry.blob, rangeHeader);
  }

  async getBlobContentByDownloadTicket(
    ticketId: string,
    rangeHeader?: string
  ): Promise<BlobContentResponse> {
    const ticket = await this.requireBlobDownloadTicket(ticketId);

    const blob =
      this.state.blobObjects.get(ticket.hash) ??
      (() => {
        const context = this.requireEntryById(ticket.entryId);
        this.assertBlobBackedEntry(context.entry);
        if (!context.entry.blob || context.entry.blob.hash !== ticket.hash) {
          throw new AppError(404, "entry_not_found", "Blob revision not found.");
        }

        return {
          ...context.entry.blob,
          createdAt: context.entry.updatedAt
        };
      })();

    return this.readBlobContent(blob, rangeHeader);
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

  private requireEntryById(entryId: string): EntryAccessContext {
    for (const workspace of this.state.workspaces.values()) {
      const entry = workspace.entries.get(entryId);
      if (!entry) {
        continue;
      }

      const membership = workspace.memberships.get(workspace.createdBy);
      return {
        workspace,
        membership: membership ?? {
          userId: workspace.createdBy,
          role: "owner",
          joinedAt: workspace.createdAt
        },
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
      if (!entry || entry.deleted) {
        throw new AppError(404, "entry_not_found", "Markdown entry not found.");
      }
      if (entry.kind !== "markdown" || !entry.docId) {
        throw new AppError(
          400,
          "unsupported_entry_kind",
          "Only markdown entries can use markdown bootstrap.",
          {
            entryKind: entry.kind
          }
        );
      }

      resolved.push(entry);
    }

    return resolved;
  }

  private assertBlobBackedEntry(entry: FileEntry): void {
    if (entry.deleted || (entry.kind !== "binary" && entry.kind !== "excalidraw")) {
      throw new AppError(404, "entry_not_found", "Blob-backed entry not found.");
    }
  }

  private assertSha256Hash(hash: string): void {
    try {
      normalizeSha256Digest(hash);
    } catch {
      throw new AppError(
        400,
        "invalid_request",
        'Field "hash" must use the "sha256:<digest>" format with a valid hex or base64 SHA-256 digest.'
      );
    }
  }

  private normalizeSha256Hash(hash: string): string {
    this.assertSha256Hash(hash);
    return normalizeSha256Digest(hash);
  }

  private createExpiry(ttlSeconds: number): string {
    return new Date(Date.now() + ttlSeconds * 1000).toISOString();
  }

  private requireBlobUploadTicket(uploadId: string): BlobUploadTicketRecord {
    const ticket = this.state.blobUploadTickets.get(uploadId);
    if (!ticket) {
      throw new AppError(404, "upload_ticket_not_found", "Upload ticket not found.");
    }
    if (Date.parse(ticket.expiresAt) <= Date.now()) {
      this.state.blobUploadTickets.delete(uploadId);
      throw new AppError(404, "upload_ticket_not_found", "Upload ticket not found.");
    }

    return ticket;
  }

  private async requireBlobDownloadTicket(
    ticketId: string
  ): Promise<BlobDownloadTicketRecord> {
    const ticket = this.state.blobDownloadTickets.get(ticketId);
    if (!ticket || Date.parse(ticket.expiresAt) <= Date.now()) {
      if (ticket) {
        this.state.blobDownloadTickets.delete(ticketId);
        await this.stateStore.saveState(this.state);
      }
      throw new AppError(404, "download_ticket_not_found", "Download ticket not found.");
    }

    return ticket;
  }

  private async finishBlobUpload(
    ticket: BlobUploadTicketRecord,
    payload: Readable,
    requestContentType?: string,
    contentRangeHeader?: string
  ): Promise<BlobUploadContentResponse> {
    this.assertBlobTransportContentType(ticket.mimeType, requestContentType);
    await this.syncUploadTicketProgress(ticket);
    const chunk = this.parseUploadContentRange(ticket, contentRangeHeader);

    try {
      const uploadResult = await this.storage.storeBlobUploadChunk(
        ticket.ticketId,
        ticket.hash,
        payload,
        ticket.mimeType,
        ticket.sizeBytes,
        chunk.startOffset,
        chunk.expectedChunkBytes
      );

      ticket.uploadedBytes = uploadResult.uploadedBytes;

      if (uploadResult.complete) {
        this.state.blobObjects.set(ticket.hash, {
          hash: ticket.hash,
          sizeBytes: ticket.sizeBytes,
          mimeType: ticket.mimeType,
          createdAt: new Date().toISOString()
        });
        this.state.blobUploadTickets.delete(ticket.ticketId);
      }

      await this.stateStore.saveState(this.state);
      return {
        ok: true,
        uploadId: ticket.ticketId,
        receivedBytes: uploadResult.uploadedBytes,
        uploadedBytes: uploadResult.uploadedBytes,
        sizeBytes: uploadResult.sizeBytes,
        complete: uploadResult.complete,
        ...(uploadResult.hash ? { hash: uploadResult.hash } : {})
      };
    } catch (error) {
      if (error instanceof AppError) {
        await this.syncUploadTicketProgress(ticket);
        await this.stateStore.saveState(this.state);
      }
      throw error;
    }
  }

  private assertBlobTransportContentType(
    ticketMimeType: string,
    requestContentType: string | undefined
  ): void {
    if (!requestContentType || requestContentType.trim() === "") {
      return;
    }

    const normalized = requestContentType.split(";")[0]?.trim().toLowerCase();
    if (!normalized) {
      return;
    }

    if (
      normalized === "application/octet-stream" ||
      normalized === ticketMimeType.toLowerCase()
    ) {
      return;
    }

    throw new AppError(
      400,
      "invalid_request",
      "Blob transport content-type is not allowed for this upload ticket.",
      {
        allowedContentTypes: [
          "application/octet-stream",
          ticketMimeType
        ]
      }
    );
  }

  private async findReusableUploadTicket(
    userId: string,
    entryId: string,
    hash: string,
    sizeBytes: number,
    mimeType: string
  ): Promise<BlobUploadTicketRecord | null> {
    for (const ticket of this.state.blobUploadTickets.values()) {
      if (
        ticket.userId !== userId ||
        ticket.entryId !== entryId ||
        ticket.hash !== hash ||
        ticket.sizeBytes !== sizeBytes ||
        ticket.mimeType !== mimeType
      ) {
        continue;
      }

      if (Date.parse(ticket.expiresAt) <= Date.now()) {
        this.state.blobUploadTickets.delete(ticket.ticketId);
        await this.storage.cancelActiveUpload(ticket.ticketId);
        continue;
      }

      await this.syncUploadTicketProgress(ticket);
      await this.stateStore.saveState(this.state);
      return ticket;
    }

    return null;
  }

  private async syncUploadTicketProgress(ticket: BlobUploadTicketRecord): Promise<void> {
    const progress = await this.storage.getUploadProgress(ticket.ticketId);
    if (progress.uploadedBytes > ticket.sizeBytes) {
      await this.storage.cancelActiveUpload(ticket.ticketId);
      ticket.uploadedBytes = 0;
      return;
    }

    ticket.uploadedBytes = progress.uploadedBytes;
  }

  private toBlobUploadResponse(entryId: string, ticket: BlobUploadTicketRecord): BlobUploadResponse {
    return {
      alreadyExists: false,
      uploadId: ticket.ticketId,
      hash: ticket.hash,
      sizeBytes: ticket.sizeBytes,
      mimeType: ticket.mimeType,
      uploadedBytes: ticket.uploadedBytes,
      status: ticket.uploadedBytes > 0 ? "uploading" : "pending",
      expiresAt: ticket.expiresAt,
      upload: {
        method: "PUT",
        url: `${this.env.blobUploadBaseUrl}/${ticket.ticketId}`,
        headers: {
          "content-type": ticket.mimeType
        }
      },
      cancel: {
        method: "DELETE",
        url: `${this.env.publicBaseUrl}/v1/files/${entryId}/blob/uploads/${ticket.ticketId}`
      }
    };
  }

  private parseUploadContentRange(
    ticket: BlobUploadTicketRecord,
    headerValue: string | undefined
  ): {
    startOffset: number;
    expectedChunkBytes?: number;
  } {
    if (!headerValue || headerValue.trim() === "") {
      // Legacy single-shot uploads can omit Content-Range, but resumable callers must declare the
      // append offset once a staged upload already has bytes on disk.
      if (ticket.uploadedBytes > 0) {
        throw new AppError(409, "blob_offset_mismatch", "Upload offset does not match server state.", {
          expectedOffset: ticket.uploadedBytes,
          receivedOffset: 0,
          sizeBytes: ticket.sizeBytes
        });
      }

      return {
        startOffset: 0
      };
    }

    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(headerValue.trim());
    if (!match) {
      throw new AppError(400, "invalid_request", "Content-Range must use the form bytes start-end/total.");
    }

    const startOffset = Number.parseInt(match[1]!, 10);
    const endOffset = Number.parseInt(match[2]!, 10);
    const totalSize = Number.parseInt(match[3]!, 10);
    if (totalSize !== ticket.sizeBytes || endOffset < startOffset) {
      throw new AppError(400, "invalid_request", "Content-Range does not match upload ticket size.");
    }
    if (startOffset !== ticket.uploadedBytes) {
      throw new AppError(409, "blob_offset_mismatch", "Upload offset does not match server state.", {
        expectedOffset: ticket.uploadedBytes,
        receivedOffset: startOffset,
        sizeBytes: ticket.sizeBytes
      });
    }

    return {
      startOffset,
      expectedChunkBytes: endOffset - startOffset + 1
    };
  }

  private async readBlobContent(
    blob: BlobRevision,
    rangeHeader?: string
  ): Promise<BlobContentResponse> {
    const range = this.parseDownloadRange(rangeHeader, blob.sizeBytes);
    // Binary resume is intentionally implemented as plain HTTP byte ranges so desktop clients can
    // keep partial `.part` files and continue from the last confirmed offset after restart.
    const blobStream = await this.storage.loadBlobStream(blob.hash, range);
    if (!blobStream) {
      throw new AppError(404, "entry_not_found", "Blob payload not found.");
    }

    return {
      hash: blobStream.metadata.hash,
      sizeBytes: blobStream.metadata.sizeBytes,
      mimeType: blobStream.metadata.mimeType,
      startOffset: blobStream.startOffset,
      endOffset: blobStream.endOffset,
      contentLength: blobStream.contentLength,
      partial: blobStream.contentLength !== blobStream.metadata.sizeBytes,
      stream: blobStream.stream
    };
  }

  private parseDownloadRange(
    headerValue: string | undefined,
    sizeBytes: number
  ): {
    startOffset?: number;
    endOffset?: number;
  } | undefined {
    if (!headerValue || headerValue.trim() === "") {
      return undefined;
    }

    const match = /^bytes=(\d+)-(\d*)$/.exec(headerValue.trim());
    if (!match) {
      throw new AppError(416, "invalid_range", "Range must use the form bytes=start-end.", {
        sizeBytes
      });
    }

    const startOffset = Number.parseInt(match[1]!, 10);
    const endOffset =
      match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : undefined;
    if (
      Number.isNaN(startOffset) ||
      (endOffset !== undefined && Number.isNaN(endOffset))
    ) {
      throw new AppError(416, "invalid_range", "Range must use numeric byte offsets.", {
        sizeBytes
      });
    }

    return {
      startOffset,
      ...(endOffset !== undefined ? { endOffset } : {})
    };
  }
}
