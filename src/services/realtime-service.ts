import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";

import { Hocuspocus } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import * as Y from "yjs";

import { AppEnv } from "../config/env";
import { FileEntry, Membership } from "../domain/types";
import { MemoryState, StoredWorkspace } from "./memory-state";
import { StorageService } from "./storage-service";

interface RealtimeContext {
  userId: string;
  workspaceId: string;
  entryId: string;
  role: Membership["role"];
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

export class RealtimeService {
  private readonly hocuspocus: Hocuspocus;
  private websocketServer: WebSocketServer | undefined;
  private upgradeHandler: UpgradeHandler | undefined;

  constructor(
    private readonly state: MemoryState,
    private readonly storage: StorageService,
    private readonly env: AppEnv,
    private readonly logger: FastifyBaseLogger
  ) {
    this.hocuspocus = new Hocuspocus({
      debounce: env.crdtStoreDebounceMs,
      maxDebounce: env.crdtStoreMaxDebounceMs,
      onAuthenticate: async (payload) => {
        return this.handleAuthenticate(payload.documentName, payload.token, payload.connectionConfig);
      },
      onLoadDocument: async (payload) => {
        return this.loadDocument(payload.documentName);
      },
      onStoreDocument: async (payload) => {
        await this.storeDocument(payload.documentName, payload.document);
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

    connectionConfig.readOnly = context.membership.role === "viewer";
    return {
      userId: tokenRecord.userId,
      workspaceId: context.workspace.workspace.id,
      entryId: context.entry.id,
      role: context.membership.role
    };
  }

  private async loadDocument(documentName: string): Promise<Y.Doc | undefined> {
    const state = await this.storage.loadDocument(documentName);
    if (!state) {
      return undefined;
    }

    const document = new Y.Doc();
    Y.applyUpdate(document, state);
    return document;
  }

  private async storeDocument(documentName: string, document: Y.Doc): Promise<void> {
    const state = Y.encodeStateAsUpdate(document);
    await this.storage.storeDocument(documentName, state);
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
}
