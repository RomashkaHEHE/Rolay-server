import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";

import {
  Hocuspocus,
  afterUnloadDocumentPayload,
  beforeHandleMessagePayload,
  connectedPayload,
  onDisconnectPayload,
  onAwarenessUpdatePayload
} from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import * as Y from "yjs";

import { AppEnv } from "../config/env";
import { FileEntry, Membership } from "../domain/types";
import { MemoryState, StoredWorkspace } from "./memory-state";
import { NotePresenceService } from "./note-presence-service";
import { NoteReadStateService } from "./note-read-state-service";
import { PublicAccessService } from "./public-access-service";
import { PublicViewerPresenceService } from "./public-viewer-presence-service";
import { StorageService } from "./storage-service";

interface RealtimeContext {
  workspaceId: string;
  entryId: string;
  publicAccess: boolean;
  publicPresenceId?: string;
  userId?: string;
  role?: Membership["role"];
}

type UpgradeHandler = (
  request: IncomingMessage,
  socket: Socket,
  head: Buffer
) => void;

function createRealtimeError(reason: string): Error & { reason: string } {
  const error = new Error(reason) as Error & { reason: string };
  error.reason = reason;
  return error;
}

function readVarUint(payload: Uint8Array, offsetRef: { offset: number }): number {
  let number = 0;
  let multiplier = 1;
  while (offsetRef.offset < payload.byteLength) {
    const byte = payload[offsetRef.offset]!;
    offsetRef.offset += 1;
    number += (byte & 0b0111_1111) * multiplier;
    if (byte < 0b1000_0000) {
      return number;
    }
    multiplier *= 128;
  }

  throw createRealtimeError("malformed-message");
}

function readVarString(payload: Uint8Array, offsetRef: { offset: number }): string {
  const length = readVarUint(payload, offsetRef);
  const start = offsetRef.offset;
  const end = start + length;
  if (end > payload.byteLength) {
    throw createRealtimeError("malformed-message");
  }
  offsetRef.offset = end;
  return new TextDecoder().decode(payload.slice(start, end));
}

function parseHocuspocusMessage(payload: Uint8Array): {
  type: number;
  typeOffset: number;
} {
  const offsetRef = { offset: 0 };
  readVarString(payload, offsetRef);
  const typeOffset = offsetRef.offset;
  const type = readVarUint(payload, offsetRef);

  return {
    type,
    typeOffset
  };
}

export class RealtimeService {
  private readonly hocuspocus: Hocuspocus;
  private websocketServer: WebSocketServer | undefined;
  private upgradeHandler: UpgradeHandler | undefined;

  constructor(
    private readonly state: MemoryState,
    private readonly storage: StorageService,
    private readonly notePresence: NotePresenceService,
    private readonly noteReadState: NoteReadStateService,
    private readonly publicAccess: PublicAccessService,
    private readonly publicViewerPresence: PublicViewerPresenceService,
    private readonly env: AppEnv,
    private readonly logger: FastifyBaseLogger
  ) {
    this.hocuspocus = new Hocuspocus({
      debounce: env.crdtStoreDebounceMs,
      maxDebounce: env.crdtStoreMaxDebounceMs,
      onAuthenticate: async (payload) => {
        return this.handleAuthenticate(payload.documentName, payload.token, payload.connectionConfig);
      },
      connected: async (payload) => {
        this.handleConnected(payload);
      },
      onLoadDocument: async (payload) => {
        return this.loadDocument(payload.documentName);
      },
      onAwarenessUpdate: async (payload) => {
        this.handleAwarenessUpdate(payload);
      },
      beforeHandleMessage: async (payload) => {
        this.assertMessageAllowed(payload);
      },
      onDisconnect: async (payload) => {
        this.handleDisconnect(payload);
      },
      onStoreDocument: async (payload) => {
        await this.storeDocument(payload.documentName, payload.document);
      },
      afterUnloadDocument: async (payload) => {
        this.handleAfterUnloadDocument(payload);
      }
    });
  }

  async attach(server: HttpServer): Promise<void> {
    if (this.websocketServer) {
      return;
    }

    await this.storage.ensureReady();
    this.websocketServer = new WebSocketServer({ noServer: true });
    this.upgradeHandler = (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (requestUrl.pathname !== "/v1/crdt") {
        return;
      }

      this.websocketServer?.handleUpgrade(request, socket, head, (connection: WebSocket) => {
        this.hocuspocus.handleConnection(connection, request);
      });
    };

    server.on("upgrade", this.upgradeHandler);
    this.logger.info({ path: "/v1/crdt" }, "Realtime CRDT service attached");
  }

  closeWorkspaceConnections(workspaceId: string): void {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace) {
      return;
    }

    for (const entry of workspace.entries.values()) {
      if (entry.kind === "markdown" && entry.docId) {
        this.hocuspocus.closeConnections(entry.docId);
      }
    }
  }

  async close(server?: HttpServer): Promise<void> {
    if (server && this.upgradeHandler) {
      server.off("upgrade", this.upgradeHandler);
    }
    this.hocuspocus.closeConnections();

    if (!this.websocketServer) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.websocketServer?.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.websocketServer = undefined;
    this.upgradeHandler = undefined;
  }

  private handleAuthenticate(
    documentName: string,
    token: string,
    connectionConfig: { readOnly: boolean }
  ): RealtimeContext {
    const publicTokenRecord = this.state.publicCrdtTokens.get(token);
    if (publicTokenRecord) {
      if (Date.parse(publicTokenRecord.expiresAt) <= Date.now()) {
        this.state.publicCrdtTokens.delete(token);
        throw createRealtimeError("invalid-crdt-token");
      }
      if (documentName !== publicTokenRecord.docId) {
        throw createRealtimeError("document-token-mismatch");
      }
      if (
        !this.publicAccess.isPublicMarkdownEntry(
          publicTokenRecord.workspaceId,
          publicTokenRecord.entryId,
          publicTokenRecord.docId
        )
      ) {
        this.state.publicCrdtTokens.delete(token);
        throw createRealtimeError("public-room-not-available");
      }

      connectionConfig.readOnly = true;
      return {
        workspaceId: publicTokenRecord.workspaceId,
        entryId: publicTokenRecord.entryId,
        publicAccess: true
      };
    }

    const tokenRecord = this.state.crdtTokens.get(token);
    if (!tokenRecord || Date.parse(tokenRecord.expiresAt) <= Date.now()) {
      this.state.crdtTokens.delete(token);
      throw createRealtimeError("invalid-crdt-token");
    }
    if (documentName !== tokenRecord.docId) {
      throw createRealtimeError("document-token-mismatch");
    }

    const context = this.findMarkdownAccess(
      tokenRecord.workspaceId,
      tokenRecord.entryId,
      tokenRecord.userId
    );

    connectionConfig.readOnly = false;
    return {
      userId: tokenRecord.userId,
      workspaceId: context.workspace.workspace.id,
      entryId: context.entry.id,
      role: context.membership.role,
      publicAccess: false
    };
  }

  private handleConnected(payload: connectedPayload): void {
    const context = payload.context as RealtimeContext | undefined;
    if (!context?.publicAccess) {
      return;
    }

    const presenceId = `public:${context.workspaceId}:${context.entryId}:${payload.socketId}`;
    context.publicPresenceId = presenceId;
    this.publicViewerPresence.registerViewer({
      presenceId,
      workspaceId: context.workspaceId,
      entryId: context.entryId
    });
  }

  private handleDisconnect(payload: onDisconnectPayload): void {
    const context = payload.context as RealtimeContext | undefined;
    if (!context?.publicAccess) {
      return;
    }

    this.publicViewerPresence.unregisterViewer(
      context.publicPresenceId ?? `public:${context.workspaceId}:${context.entryId}:${payload.socketId}`
    );
  }

  private async loadDocument(documentName: string): Promise<Y.Doc | undefined> {
    // Only Markdown entries use this CRDT channel. Tree metadata and binary files are synchronized
    // through separate protocols and should never be loaded here.
    const state = await this.storage.loadDocument(documentName);
    if (!state) {
      return undefined;
    }

    const document = new Y.Doc();
    Y.applyUpdate(document, state);
    return document;
  }

  private async storeDocument(documentName: string, document: Y.Doc): Promise<void> {
    const nextState = Y.encodeStateAsUpdate(document);
    const previousState = await this.storage.loadDocument(documentName);
    if (
      previousState &&
      Buffer.from(previousState).equals(Buffer.from(nextState))
    ) {
      return;
    }

    await this.storage.storeDocument(documentName, nextState);
    const context = this.findDocumentContext(documentName);
    if (!context) {
      return;
    }

    // Unread/read-state is tied to the durable document state that was just stored. This keeps the
    // contract stable across reconnects and devices instead of trying to count transient editor ops.
    await this.noteReadState.handleMarkdownContentChanged(
      context.workspaceId,
      context.entryId
    );
  }

  private handleAwarenessUpdate(payload: onAwarenessUpdatePayload): void {
    const context = payload.context as RealtimeContext | undefined;
    if (!context || context.publicAccess) {
      return;
    }

    // Note presence intentionally stays separate from caret rendering: anyone with a live viewer
    // state in the markdown document counts as present even if they haven't published a selection.
    this.notePresence.reconcileAwareness(
      context,
      payload.states as Array<Record<string | number, unknown>>
    );
  }

  private handleAfterUnloadDocument(payload: afterUnloadDocumentPayload): void {
    this.notePresence.clearDocumentPresence(payload.documentName);
  }

  private assertMessageAllowed(payload: beforeHandleMessagePayload): void {
    const context = payload.context as RealtimeContext | undefined;
    if (!context?.publicAccess) {
      return;
    }

    const message = parseHocuspocusMessage(payload.update);
    if (message.type === 5 || message.type === 6) {
      throw createRealtimeError("public-readonly-message");
    }
    if (message.type === 1) {
      // Public viewers need to receive collaborator awareness for read-only cursors, but they must
      // never contribute their own presence. Hocuspocus has no "drop only this awareness update"
      // hook, so we turn inbound public awareness into a harmless query-awareness request. The
      // server replies with the current authenticated collaborators' awareness and does not apply
      // the public client's state to the shared document.
      payload.update[message.typeOffset] = 3;
    }
  }

  private findMarkdownAccess(
    workspaceId: string,
    entryId: string,
    userId: string
  ): {
    workspace: StoredWorkspace;
    membership: Membership;
    entry: FileEntry;
  } {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace) {
      throw createRealtimeError("workspace-not-found");
    }

    const membership = workspace.memberships.get(userId);
    if (!membership) {
      throw createRealtimeError("forbidden");
    }

    const entry = workspace.entries.get(entryId);
    if (
      !entry ||
      entry.deleted ||
      entry.kind !== "markdown" ||
      !entry.docId
    ) {
      throw createRealtimeError("entry-not-found");
    }

    return {
      workspace,
      membership,
      entry
    };
  }

  private findDocumentContext(
    documentName: string
  ): {
    workspaceId: string;
    entryId: string;
  } | null {
    for (const workspace of this.state.workspaces.values()) {
      for (const entry of workspace.entries.values()) {
        if (
          entry.docId === documentName &&
          entry.kind === "markdown" &&
          !entry.deleted
        ) {
          return {
            workspaceId: workspace.workspace.id,
            entryId: entry.id
          };
        }
      }
    }

    return null;
  }
}
