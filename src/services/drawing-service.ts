import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";

import type { FastifyBaseLogger } from "fastify";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";

import { AppEnv } from "../config/env";
import { AppError } from "../core/errors";
import { createId, createOpaqueToken } from "../core/ids";
import {
  AuthPrincipal,
  DrawingControlRequest,
  DrawingLease,
  DrawingParticipant,
  DrawingPointerState,
  DrawingScene,
  DrawingSceneSnapshot,
  FileEntry
} from "../domain/types";
import { MemoryState, StoredWorkspace } from "./memory-state";
import { StorageService } from "./storage-service";

interface DrawingTokenRecord {
  token: string;
  entryId: string;
  workspaceId: string;
  userId: string;
  deviceId: string;
  expiresAt: string;
}

interface DrawingConnection {
  socket: WebSocket;
  token: DrawingTokenRecord;
}

interface DrawingSession {
  entryId: string;
  workspaceId: string;
  lease: DrawingLease | null;
  pendingControlRequest: DrawingControlRequest | null;
  sceneSnapshot: DrawingSceneSnapshot | null;
  pointer: DrawingPointerState | null;
  loaded: boolean;
  loadPromise: Promise<void> | undefined;
  persistTimer: NodeJS.Timeout | undefined;
  persistPromise: Promise<void> | undefined;
  connections: Set<DrawingConnection>;
}

interface DrawingStateSummary {
  lease: DrawingLease | null;
  pendingControlRequest: DrawingControlRequest | null;
  latestScene: Pick<DrawingSceneSnapshot, "revision" | "updatedAt"> | null;
  pointerActive: boolean;
}

interface DrawingTokenResponse {
  entryId: string;
  workspaceId: string;
  provider: "rolay-excalidraw-live";
  wsUrl: string;
  token: string;
  expiresAt: string;
  state: DrawingStateSummary;
}

interface DrawingLeaseResponse {
  lease: DrawingLease | null;
}

interface DrawingControlRequestResponse {
  request: DrawingControlRequest;
}

interface DrawingControlResolutionResponse {
  requestId: string;
  status: "approved" | "denied" | "canceled";
  lease: DrawingLease | null;
}

type UpgradeHandler = (
  request: IncomingMessage,
  socket: Socket,
  head: Buffer
) => void;

type DrawingClientMessage =
  | { type: "lease.heartbeat" }
  | { type: "scene.publish"; scene: DrawingScene }
  | { type: "pointer.publish"; pointer: { x: number; y: number; color?: string } };

type DrawingServerMessage =
  | {
      type: "drawing.ready";
      entryId: string;
      workspaceId: string;
      lease: DrawingLease | null;
      pendingControlRequest: DrawingControlRequest | null;
      sceneSnapshot: DrawingSceneSnapshot | null;
      pointer: DrawingPointerState | null;
    }
  | {
      type: "lease.updated";
      lease: DrawingLease | null;
    }
  | {
      type: "control.requested";
      request: DrawingControlRequest;
    }
  | {
      type: "control.resolved";
      requestId: string;
      status: "approved" | "denied" | "canceled";
      lease: DrawingLease | null;
    }
  | {
      type: "scene.updated";
      snapshot: DrawingSceneSnapshot;
    }
  | {
      type: "pointer.updated";
      pointer: DrawingPointerState;
    }
  | {
      type: "pointer.cleared";
      reason: "released" | "expired" | "disconnect" | "takeover" | "stale";
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(400, "invalid_request", `Field "${fieldName}" must be a finite number.`);
  }

  return value;
}

function asOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(400, "invalid_request", `Field "${fieldName}" must be a string.`);
  }

  return value;
}

function normalizeScene(scene: unknown): DrawingScene {
  if (!isObject(scene)) {
    throw new AppError(400, "invalid_request", 'Field "scene" must be an object.');
  }
  if (!Array.isArray(scene.elements)) {
    throw new AppError(400, "invalid_request", 'Field "scene.elements" must be an array.');
  }
  if (scene.appState !== undefined && !isObject(scene.appState)) {
    throw new AppError(400, "invalid_request", 'Field "scene.appState" must be an object.');
  }
  if (scene.files !== undefined && !isObject(scene.files)) {
    throw new AppError(400, "invalid_request", 'Field "scene.files" must be an object.');
  }

  return {
    elements: scene.elements,
    ...(scene.appState !== undefined
      ? { appState: scene.appState as Record<string, unknown> }
      : {}),
    ...(scene.files !== undefined
      ? { files: scene.files as Record<string, unknown> }
      : {})
  };
}

function createSession(entryId: string, workspaceId: string): DrawingSession {
  return {
    entryId,
    workspaceId,
    lease: null,
    pendingControlRequest: null,
    sceneSnapshot: null,
    pointer: null,
    loaded: false,
    loadPromise: undefined,
    persistTimer: undefined,
    persistPromise: undefined,
    connections: new Set()
  };
}

export class DrawingService {
  private readonly tokens = new Map<string, DrawingTokenRecord>();
  private readonly sessions = new Map<string, DrawingSession>();
  private websocketServer: WebSocketServer | undefined;
  private upgradeHandler: UpgradeHandler | undefined;
  private maintenanceInterval: NodeJS.Timeout | undefined;

  constructor(
    private readonly state: MemoryState,
    private readonly env: AppEnv,
    private readonly storage: StorageService,
    private readonly logger?: FastifyBaseLogger
  ) {}

  async attach(server: HttpServer): Promise<void> {
    if (this.websocketServer) {
      return;
    }

    await this.storage.ensureReady();
    this.websocketServer = new WebSocketServer({ noServer: true });
    this.upgradeHandler = (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (requestUrl.pathname !== "/v1/drawings") {
        return;
      }

      this.websocketServer?.handleUpgrade(request, socket, head, (connection: WebSocket) => {
        void this.handleConnection(connection, request);
      });
    };

    server.on("upgrade", this.upgradeHandler);
    this.maintenanceInterval = setInterval(() => {
      void this.runMaintenance();
    }, 1_000);

    this.logger?.info({ path: "/v1/drawings" }, "Drawing realtime service attached");
  }

  async close(server?: HttpServer): Promise<void> {
    if (server && this.upgradeHandler) {
      server.off("upgrade", this.upgradeHandler);
    }
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = undefined;
    }

    for (const session of this.sessions.values()) {
      await this.flushSnapshot(session);
      for (const connection of session.connections) {
        connection.socket.close();
      }
      session.connections.clear();
    }

    const websocketServer = this.websocketServer;
    if (!websocketServer) {
      return;
    }
    this.websocketServer = undefined;
    this.upgradeHandler = undefined;
    websocketServer.close();
  }

  async createDrawingToken(
    principal: AuthPrincipal,
    entryId: string
  ): Promise<DrawingTokenResponse> {
    const context = await this.requireDrawingAccess(principal.user.id, entryId);
    const session = await this.ensureSessionLoaded(context.entry.id, context.workspace.workspace.id);
    const record: DrawingTokenRecord = {
      token: createOpaqueToken(),
      entryId: context.entry.id,
      workspaceId: context.workspace.workspace.id,
      userId: principal.user.id,
      deviceId: principal.device.id,
      expiresAt: this.createExpiry(this.env.drawingTokenTtlSeconds)
    };

    this.tokens.set(record.token, record);
    return {
      entryId: record.entryId,
      workspaceId: record.workspaceId,
      provider: "rolay-excalidraw-live",
      wsUrl: this.env.drawingWsUrl,
      token: record.token,
      expiresAt: record.expiresAt,
      state: {
        lease: session.lease,
        pendingControlRequest: session.pendingControlRequest,
        latestScene: session.sceneSnapshot
          ? {
              revision: session.sceneSnapshot.revision,
              updatedAt: session.sceneSnapshot.updatedAt
            }
          : null,
        pointerActive: this.pointerIsFresh(session.pointer)
      }
    };
  }

  async acquireLease(principal: AuthPrincipal, entryId: string): Promise<DrawingLeaseResponse> {
    const context = await this.requireDrawingAccess(principal.user.id, entryId);
    const session = await this.ensureSessionLoaded(context.entry.id, context.workspace.workspace.id);
    this.cleanupExpiredLease(session);

    if (session.lease) {
      if (this.isSameParticipant(session.lease.editor, principal)) {
        session.lease.expiresAt = this.createExpiry(this.env.drawingLeaseTtlSeconds);
        this.broadcast(session, {
          type: "lease.updated",
          lease: session.lease
        });
        return { lease: session.lease };
      }

      throw new AppError(409, "lease_unavailable", "Drawing already has an active editor.");
    }

    if (session.pendingControlRequest) {
      this.clearControlRequest(session, "canceled");
    }

    session.lease = this.createLease(context.entry.id, context.workspace.workspace.id, principal);
    this.broadcast(session, {
      type: "lease.updated",
      lease: session.lease
    });

    return {
      lease: session.lease
    };
  }

  async releaseLease(principal: AuthPrincipal, entryId: string): Promise<DrawingLeaseResponse> {
    const context = await this.requireDrawingAccess(principal.user.id, entryId);
    const session = await this.ensureSessionLoaded(context.entry.id, context.workspace.workspace.id);
    this.assertCurrentEditor(session, principal);
    await this.endLease(session, "released");
    return {
      lease: null
    };
  }

  async requestControl(
    principal: AuthPrincipal,
    entryId: string
  ): Promise<DrawingControlRequestResponse> {
    const context = await this.requireDrawingAccess(principal.user.id, entryId);
    const session = await this.ensureSessionLoaded(context.entry.id, context.workspace.workspace.id);
    this.cleanupExpiredLease(session);

    if (!session.lease) {
      throw new AppError(409, "lease_unavailable", "Drawing has no active editor.");
    }
    if (this.isSameParticipant(session.lease.editor, principal)) {
      throw new AppError(409, "already_editor", "Current user already edits this drawing.");
    }

    if (session.pendingControlRequest) {
      if (this.isSameParticipant(session.pendingControlRequest.requestedBy, principal)) {
        return {
          request: session.pendingControlRequest
        };
      }

      throw new AppError(409, "control_request_pending", "Another control request is already pending.");
    }

    const request: DrawingControlRequest = {
      requestId: createId("dreq"),
      entryId: context.entry.id,
      workspaceId: context.workspace.workspace.id,
      requestedBy: this.toParticipant(principal),
      createdAt: new Date().toISOString()
    };
    session.pendingControlRequest = request;
    this.broadcast(session, {
      type: "control.requested",
      request
    });

    return { request };
  }

  async approveControlRequest(
    principal: AuthPrincipal,
    entryId: string,
    requestId: string
  ): Promise<DrawingControlResolutionResponse> {
    const context = await this.requireDrawingAccess(principal.user.id, entryId);
    const session = await this.ensureSessionLoaded(context.entry.id, context.workspace.workspace.id);
    this.assertCurrentEditor(session, principal);
    const request = this.requirePendingControlRequest(session, requestId);

    session.pendingControlRequest = null;
    session.pointer = null;
    session.lease = {
      entryId: context.entry.id,
      workspaceId: context.workspace.workspace.id,
      editor: request.requestedBy,
      acquiredAt: new Date().toISOString(),
      expiresAt: this.createExpiry(this.env.drawingLeaseTtlSeconds)
    };

    this.broadcast(session, {
      type: "control.resolved",
      requestId,
      status: "approved",
      lease: session.lease
    });
    this.broadcast(session, {
      type: "lease.updated",
      lease: session.lease
    });
    this.broadcast(session, {
      type: "pointer.cleared",
      reason: "takeover"
    });

    return {
      requestId,
      status: "approved",
      lease: session.lease
    };
  }

  async denyControlRequest(
    principal: AuthPrincipal,
    entryId: string,
    requestId: string
  ): Promise<DrawingControlResolutionResponse> {
    const context = await this.requireDrawingAccess(principal.user.id, entryId);
    const session = await this.ensureSessionLoaded(context.entry.id, context.workspace.workspace.id);
    this.assertCurrentEditor(session, principal);
    this.requirePendingControlRequest(session, requestId);
    session.pendingControlRequest = null;

    this.broadcast(session, {
      type: "control.resolved",
      requestId,
      status: "denied",
      lease: session.lease
    });

    return {
      requestId,
      status: "denied",
      lease: session.lease
    };
  }

  private async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const tokenValue = requestUrl.searchParams.get("token");
      if (!tokenValue) {
        socket.close(1008, "missing-token");
        return;
      }

      const token = await this.requireDrawingToken(tokenValue);
      await this.requireDrawingAccess(token.userId, token.entryId);
      const session = await this.ensureSessionLoaded(token.entryId, token.workspaceId);
      this.cleanupExpiredLease(session);

      const connection: DrawingConnection = {
        socket,
        token
      };
      session.connections.add(connection);

      socket.on("message", (data) => {
        void this.handleMessage(connection, Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      });
      socket.on("close", () => {
        void this.handleDisconnect(connection);
      });
      socket.on("error", () => {
        void this.handleDisconnect(connection);
      });

      this.send(connection, {
        type: "drawing.ready",
        entryId: session.entryId,
        workspaceId: session.workspaceId,
        lease: session.lease,
        pendingControlRequest: session.pendingControlRequest,
        sceneSnapshot: session.sceneSnapshot,
        pointer: this.pointerIsFresh(session.pointer) ? session.pointer : null
      });
    } catch (error) {
      this.logger?.warn({ err: error }, "Failed to initialize drawing websocket");
      socket.close(1008, "unauthorized");
    }
  }

  private async handleMessage(connection: DrawingConnection, rawMessage: string): Promise<void> {
    const session = this.sessions.get(connection.token.entryId);
    if (!session) {
      this.sendError(connection, "drawing_not_found", "Drawing session is not available.");
      return;
    }

    let message: DrawingClientMessage;
    try {
      const parsed = JSON.parse(rawMessage) as unknown;
      if (!isObject(parsed) || typeof parsed.type !== "string") {
        throw new AppError(400, "invalid_request", 'Field "type" must be provided.');
      }
      message = parsed as DrawingClientMessage;
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError(400, "invalid_request", "Drawing websocket message must be valid JSON.");
      this.sendError(connection, appError.code, appError.message);
      return;
    }

    try {
      switch (message.type) {
        case "lease.heartbeat":
          if (session.lease && this.matchesTokenParticipant(session.lease.editor, connection.token)) {
            session.lease.expiresAt = this.createExpiry(this.env.drawingLeaseTtlSeconds);
            this.broadcast(session, {
              type: "lease.updated",
              lease: session.lease
            });
          }
          return;
        case "scene.publish":
          this.assertTokenIsCurrentEditor(session, connection.token);
          session.sceneSnapshot = {
            entryId: session.entryId,
            workspaceId: session.workspaceId,
            revision: (session.sceneSnapshot?.revision ?? 0) + 1,
            updatedAt: new Date().toISOString(),
            scene: normalizeScene(message.scene)
          };
          this.scheduleSnapshotPersist(session);
          this.broadcast(session, {
            type: "scene.updated",
            snapshot: session.sceneSnapshot
          });
          return;
        case "pointer.publish":
          this.assertTokenIsCurrentEditor(session, connection.token);
          {
            const color = asOptionalString(message.pointer?.color, "pointer.color");
            const pointer: DrawingPointerState = {
            entryId: session.entryId,
            workspaceId: session.workspaceId,
            editor: session.lease!.editor,
            x: asFiniteNumber(message.pointer?.x, "pointer.x"),
            y: asFiniteNumber(message.pointer?.y, "pointer.y"),
            updatedAt: new Date().toISOString()
            };
            if (color !== undefined) {
              pointer.color = color;
            }

            session.pointer = pointer;
            this.broadcast(session, {
              type: "pointer.updated",
              pointer
            });
          }
          return;
        default:
          this.sendError(connection, "unsupported_message_type", "Unsupported drawing websocket message.");
      }
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError(500, "internal_error", "Unexpected drawing websocket error.");
      this.sendError(connection, appError.code, appError.message);
    }
  }

  private async handleDisconnect(connection: DrawingConnection): Promise<void> {
    const session = this.sessions.get(connection.token.entryId);
    if (!session) {
      return;
    }

    session.connections.delete(connection);
    if (
      session.lease &&
      this.matchesTokenParticipant(session.lease.editor, connection.token) &&
      !this.hasActiveParticipantConnection(session, connection.token.userId, connection.token.deviceId)
    ) {
      await this.endLease(session, "disconnect");
    }
  }

  private async runMaintenance(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.cleanupExpiredLease(session);
      this.cleanupStalePointer(session);
    }
  }

  private cleanupExpiredLease(session: DrawingSession): void {
    if (!session.lease) {
      return;
    }
    if (Date.parse(session.lease.expiresAt) > Date.now()) {
      return;
    }

    void this.endLease(session, "expired");
  }

  private cleanupStalePointer(session: DrawingSession): void {
    if (!session.pointer) {
      return;
    }
    if (this.pointerIsFresh(session.pointer)) {
      return;
    }

    session.pointer = null;
    this.broadcast(session, {
      type: "pointer.cleared",
      reason: "stale"
    });
  }

  private async endLease(
    session: DrawingSession,
    reason: "released" | "expired" | "disconnect"
  ): Promise<void> {
    if (!session.lease && !session.pendingControlRequest && !session.pointer) {
      return;
    }

    session.lease = null;
    if (session.pendingControlRequest) {
      this.clearControlRequest(session, "canceled");
    }
    const hadPointer = session.pointer !== null;
    session.pointer = null;

    this.broadcast(session, {
      type: "lease.updated",
      lease: null
    });
    if (hadPointer) {
      this.broadcast(session, {
        type: "pointer.cleared",
        reason
      });
    }

    await this.flushSnapshot(session);
  }

  private clearControlRequest(
    session: DrawingSession,
    status: "canceled" | "denied"
  ): void {
    const requestId = session.pendingControlRequest?.requestId;
    session.pendingControlRequest = null;
    if (!requestId) {
      return;
    }

    this.broadcast(session, {
      type: "control.resolved",
      requestId,
      status,
      lease: session.lease
    });
  }

  private async ensureSessionLoaded(entryId: string, workspaceId: string): Promise<DrawingSession> {
    let session = this.sessions.get(entryId);
    if (!session) {
      session = createSession(entryId, workspaceId);
      this.sessions.set(entryId, session);
    }

    if (session.loaded) {
      return session;
    }

    if (!session.loadPromise) {
      session.loadPromise = (async () => {
        session!.sceneSnapshot = await this.storage.loadDrawingSnapshot(entryId);
        session!.loaded = true;
      })();
    }

    await session.loadPromise;
    session.loadPromise = undefined;
    return session;
  }

  private scheduleSnapshotPersist(session: DrawingSession): void {
    if (session.persistTimer) {
      clearTimeout(session.persistTimer);
    }

    session.persistTimer = setTimeout(() => {
      void this.flushSnapshot(session);
    }, this.env.drawingSnapshotStoreDebounceMs);
  }

  private async flushSnapshot(session: DrawingSession): Promise<void> {
    if (session.persistTimer) {
      clearTimeout(session.persistTimer);
      session.persistTimer = undefined;
    }
    if (!session.sceneSnapshot) {
      return;
    }

    if (!session.persistPromise) {
      session.persistPromise = this.storage
        .storeDrawingSnapshot(session.entryId, session.sceneSnapshot)
        .finally(() => {
          session.persistPromise = undefined;
        });
    }

    await session.persistPromise;
  }

  private async requireDrawingToken(token: string): Promise<DrawingTokenRecord> {
    const record = this.tokens.get(token);
    if (!record || Date.parse(record.expiresAt) <= Date.now()) {
      this.tokens.delete(token);
      throw new AppError(401, "invalid_drawing_token", "Drawing token is invalid or expired.");
    }

    return record;
  }

  private async requireDrawingAccess(
    userId: string,
    entryId: string
  ): Promise<{ workspace: StoredWorkspace; entry: FileEntry }> {
    for (const workspace of this.state.workspaces.values()) {
      const entry = workspace.entries.get(entryId);
      if (!entry) {
        continue;
      }
      if (!workspace.memberships.has(userId)) {
        throw new AppError(403, "forbidden", "User is not a workspace member.");
      }
      if (entry.deleted) {
        throw new AppError(404, "entry_not_found", "Drawing entry not found.");
      }
      if (entry.kind !== "excalidraw") {
        throw new AppError(
          400,
          "unsupported_entry_kind",
          "Only Excalidraw drawing entries can use this endpoint.",
          {
            entryKind: entry.kind
          }
        );
      }

      return {
        workspace,
        entry
      };
    }

    throw new AppError(404, "entry_not_found", "Drawing entry not found.");
  }

  private assertCurrentEditor(session: DrawingSession, principal: AuthPrincipal): void {
    if (!session.lease || !this.isSameParticipant(session.lease.editor, principal)) {
      throw new AppError(403, "not_current_editor", "Current user is not the active drawing editor.");
    }
  }

  private assertTokenIsCurrentEditor(session: DrawingSession, token: DrawingTokenRecord): void {
    if (!session.lease || !this.matchesTokenParticipant(session.lease.editor, token)) {
      throw new AppError(403, "not_current_editor", "Current connection is not the active drawing editor.");
    }
  }

  private requirePendingControlRequest(
    session: DrawingSession,
    requestId: string
  ): DrawingControlRequest {
    if (!session.pendingControlRequest || session.pendingControlRequest.requestId !== requestId) {
      throw new AppError(404, "control_request_not_found", "Control request was not found.");
    }

    return session.pendingControlRequest;
  }

  private broadcast(session: DrawingSession, message: DrawingServerMessage): void {
    for (const connection of session.connections) {
      this.send(connection, message);
    }
  }

  private send(connection: DrawingConnection, message: DrawingServerMessage): void {
    if (connection.socket.readyState !== connection.socket.OPEN) {
      return;
    }

    connection.socket.send(JSON.stringify(message));
  }

  private sendError(connection: DrawingConnection, code: string, message: string): void {
    this.send(connection, {
      type: "error",
      code,
      message
    });
  }

  private pointerIsFresh(pointer: DrawingPointerState | null): boolean {
    if (!pointer) {
      return false;
    }

    return Date.parse(pointer.updatedAt) + this.env.drawingPointerStaleMs > Date.now();
  }

  private hasActiveParticipantConnection(
    session: DrawingSession,
    userId: string,
    deviceId: string
  ): boolean {
    for (const connection of session.connections) {
      if (connection.token.userId === userId && connection.token.deviceId === deviceId) {
        return true;
      }
    }

    return false;
  }

  private toParticipant(principal: AuthPrincipal): DrawingParticipant {
    return {
      userId: principal.user.id,
      deviceId: principal.device.id,
      username: principal.user.username,
      displayName: principal.user.displayName
    };
  }

  private createLease(
    entryId: string,
    workspaceId: string,
    principal: AuthPrincipal
  ): DrawingLease {
    return {
      entryId,
      workspaceId,
      editor: this.toParticipant(principal),
      acquiredAt: new Date().toISOString(),
      expiresAt: this.createExpiry(this.env.drawingLeaseTtlSeconds)
    };
  }

  private isSameParticipant(participant: DrawingParticipant, principal: AuthPrincipal): boolean {
    return participant.userId === principal.user.id && participant.deviceId === principal.device.id;
  }

  private matchesTokenParticipant(participant: DrawingParticipant, token: DrawingTokenRecord): boolean {
    return participant.userId === token.userId && participant.deviceId === token.deviceId;
  }

  private createExpiry(ttlSeconds: number): string {
    return new Date(Date.now() + ttlSeconds * 1000).toISOString();
  }
}
