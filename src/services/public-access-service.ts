import { Readable } from "node:stream";

import { AppEnv } from "../config/env";
import { cloneValue } from "../core/clone";
import { AppError } from "../core/errors";
import { normalizeSha256Hash } from "../core/hashes";
import { createOpaqueToken } from "../core/ids";
import {
  BlobRevision,
  FileEntry,
  PublicCrdtTokenRecord,
  Workspace,
  WorkspaceEvent,
  WorkspacePublication
} from "../domain/types";
import { MemoryState, StoredWorkspace, WorkspaceEventListener } from "./memory-state";
import { StorageService } from "./storage-service";

export interface PublicRoomSummary {
  workspace: Workspace;
  publication: WorkspacePublication;
}

export interface PublicManifestEntry {
  id: string;
  path: string;
  kind: "folder" | "markdown" | "excalidraw";
  contentMode: FileEntry["contentMode"];
  entryVersion: number;
  docId?: string;
  blob?: BlobRevision;
  updatedAt: string;
}

export interface PublicAsset {
  entryId: string;
  path: string;
  hash: string;
  sizeBytes: number;
  mimeType: string;
  contentUrl: string;
}

export interface PublicRoomManifest {
  workspace: Workspace;
  publication: WorkspacePublication;
  cursor: number;
  entries: PublicManifestEntry[];
  assets: Record<string, PublicAsset>;
}

export interface PublicCrdtTokenResponse {
  entryId: string;
  docId: string;
  provider: string;
  wsUrl: string;
  token: string;
  expiresAt: string;
  readOnly: true;
}

export interface PublicBlobContentResponse {
  hash: string;
  sizeBytes: number;
  mimeType: string;
  startOffset: number;
  endOffset: number;
  contentLength: number;
  partial: boolean;
  stream: Readable;
}

export interface PublicEventStreamHandle {
  initialEvents: WorkspaceEvent[];
  unsubscribe: () => void;
}

const PUBLIC_EVENT_TYPES = new Set([
  "tree.entry.created",
  "tree.entry.updated",
  "tree.entry.deleted",
  "tree.entry.restored",
  "blob.revision.committed",
  "room.publication.updated"
]);

function isImageEntry(entry: FileEntry): boolean {
  const mimeType = entry.blob?.mimeType ?? entry.mimeType ?? "";
  return entry.kind === "binary" && mimeType.toLowerCase().startsWith("image/");
}

function basename(filePath: string): string {
  const segments = filePath.split("/");
  return segments.at(-1) ?? filePath;
}

export class PublicAccessService {
  constructor(
    private readonly state: MemoryState,
    private readonly env: AppEnv,
    private readonly storage: StorageService
  ) {}

  listPublicRooms(): PublicRoomSummary[] {
    return [...this.state.workspaces.values()]
      .filter((workspace) => workspace.publication.enabled)
      .map((workspace) => ({
        workspace: cloneValue(workspace.workspace),
        publication: cloneValue(workspace.publication)
      }))
      .sort((left, right) => left.workspace.name.localeCompare(right.workspace.name));
  }

  getManifest(workspaceId: string): PublicRoomManifest {
    const workspace = this.requirePublicWorkspace(workspaceId);
    const entries = [...workspace.entries.values()]
      .filter((entry) => !entry.deleted)
      .sort((left, right) => left.path.localeCompare(right.path));

    return {
      workspace: cloneValue(workspace.workspace),
      publication: cloneValue(workspace.publication),
      cursor: this.currentCursor(workspace),
      entries: entries
        .filter(
          (entry): entry is FileEntry & { kind: "folder" | "markdown" | "excalidraw" } =>
            entry.kind === "folder" ||
            entry.kind === "markdown" ||
            entry.kind === "excalidraw"
        )
        .map((entry) => this.toManifestEntry(entry)),
      assets: this.buildAssetMap(workspace, entries)
    };
  }

  async createPublicCrdtToken(
    workspaceId: string,
    entryId: string
  ): Promise<PublicCrdtTokenResponse> {
    const workspace = this.requirePublicWorkspace(workspaceId);
    const entry = this.requirePublicMarkdownEntry(workspace, entryId);
    const record: PublicCrdtTokenRecord = {
      token: createOpaqueToken(),
      workspaceId: workspace.workspace.id,
      entryId: entry.id,
      docId: entry.docId,
      expiresAt: this.createExpiry(Math.min(this.env.crdtTokenTtlSeconds, 300))
    };

    this.state.publicCrdtTokens.set(record.token, record);
    return {
      entryId: record.entryId,
      docId: record.docId,
      provider: this.env.crdtProvider,
      wsUrl: this.env.crdtWsUrl,
      token: record.token,
      expiresAt: record.expiresAt,
      readOnly: true
    };
  }

  async getBlobContent(
    workspaceId: string,
    entryId: string,
    hash: string,
    rangeHeader?: string
  ): Promise<PublicBlobContentResponse> {
    const workspace = this.requirePublicWorkspace(workspaceId);
    const entry = workspace.entries.get(entryId);
    if (!entry || entry.deleted || !entry.blob) {
      throw new AppError(404, "entry_not_found", "Public file was not found.");
    }

    if (entry.kind !== "excalidraw" && !isImageEntry(entry)) {
      throw new AppError(404, "entry_not_found", "Public file was not found.");
    }

    const normalizedHash = normalizeSha256Hash(hash);
    if (entry.blob.hash !== normalizedHash) {
      throw new AppError(404, "entry_not_found", "Public file revision was not found.");
    }

    const blobStream = await this.storage.loadBlobStream(
      normalizedHash,
      this.parseDownloadRange(rangeHeader, entry.blob.sizeBytes)
    );
    if (!blobStream) {
      throw new AppError(404, "entry_not_found", "Blob payload was not found.");
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

  openEventStream(
    workspaceId: string,
    cursor: number,
    listener: WorkspaceEventListener
  ): PublicEventStreamHandle {
    const workspace = this.requirePublicWorkspace(workspaceId);
    const wrappedListener: WorkspaceEventListener = (event) => {
      if (PUBLIC_EVENT_TYPES.has(event.eventType)) {
        listener(event);
      }
    };
    workspace.listeners.add(wrappedListener);
    return {
      initialEvents: workspace.events
        .filter((event) => event.seq > cursor)
        .filter((event) => PUBLIC_EVENT_TYPES.has(event.eventType))
        .map((event) => cloneValue(event)),
      unsubscribe: () => {
        workspace.listeners.delete(wrappedListener);
      }
    };
  }

  isPublicMarkdownEntry(workspaceId: string, entryId: string, docId: string): boolean {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace || !workspace.publication.enabled) {
      return false;
    }

    const entry = workspace.entries.get(entryId);
    return Boolean(
      entry &&
        !entry.deleted &&
        entry.kind === "markdown" &&
        entry.docId === docId
    );
  }

  private requirePublicWorkspace(workspaceId: string): StoredWorkspace {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace || !workspace.publication.enabled) {
      throw new AppError(404, "workspace_not_found", "Published room was not found.");
    }

    return workspace;
  }

  private requirePublicMarkdownEntry(
    workspace: StoredWorkspace,
    entryId: string
  ): FileEntry & { kind: "markdown"; docId: string } {
    const entry = workspace.entries.get(entryId);
    if (!entry || entry.deleted || entry.kind !== "markdown" || !entry.docId) {
      throw new AppError(404, "entry_not_found", "Published markdown note was not found.");
    }

    return entry as FileEntry & { kind: "markdown"; docId: string };
  }

  private buildAssetMap(
    workspace: StoredWorkspace,
    entries: FileEntry[]
  ): Record<string, PublicAsset> {
    const assets: Record<string, PublicAsset> = {};
    for (const entry of entries) {
      if (!isImageEntry(entry) || !entry.blob) {
        continue;
      }

      const asset: PublicAsset = {
        entryId: entry.id,
        path: entry.path,
        hash: entry.blob.hash,
        sizeBytes: entry.blob.sizeBytes,
        mimeType: entry.blob.mimeType,
        contentUrl:
          `/public/api/rooms/${encodeURIComponent(workspace.workspace.id)}` +
          `/files/${encodeURIComponent(entry.id)}/blob/content` +
          `?hash=${encodeURIComponent(entry.blob.hash)}`
      };

      assets[entry.path] = asset;
      assets[`/${entry.path}`] = asset;
      assets[basename(entry.path)] ??= asset;
    }

    return assets;
  }

  private toManifestEntry(entry: PublicManifestEntry): PublicManifestEntry {
    return {
      id: entry.id,
      path: entry.path,
      kind: entry.kind,
      contentMode: entry.contentMode,
      entryVersion: entry.entryVersion,
      ...(entry.docId ? { docId: entry.docId } : {}),
      ...(entry.blob ? { blob: cloneValue(entry.blob) } : {}),
      updatedAt: entry.updatedAt
    };
  }

  private currentCursor(workspace: StoredWorkspace): number {
    return workspace.events.at(-1)?.seq ?? 0;
  }

  private createExpiry(ttlSeconds: number): string {
    return new Date(Date.now() + ttlSeconds * 1000).toISOString();
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
