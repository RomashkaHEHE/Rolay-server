import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

import { buildApp } from "../src/app";
import { AppEnv } from "../src/config/env";
import { AuthService } from "../src/services/auth-service";
import { MemoryState } from "../src/services/memory-state";
import { SettingsEventsService } from "../src/services/settings-events-service";
import WebSocket from "ws";

type AppInstance = Awaited<ReturnType<typeof buildApp>>;

function createTestEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  const baseEnv: AppEnv = {
    host: "127.0.0.1",
    port: 3000,
    logLevel: "silent",
    stateDriver: "memory",
    postgresUrl: undefined,
    postgresStateKey: "test",
    devAuthUsername: "alice",
    devAuthPassword: "secret",
    devAuthDisplayName: "Alice",
    publicBaseUrl: "http://localhost:3000",
    crdtProvider: "yjs-hocuspocus",
    crdtWsUrl: "ws://localhost:3000/v1/crdt",
    crdtTokenTtlSeconds: 300,
    blobTicketTtlSeconds: 900,
    blobUploadBaseUrl: "http://localhost:3000/_storage/upload",
    blobDownloadBaseUrl: "http://localhost:3000/_storage/download",
    storageDriver: "local",
    localDataDir: path.join(process.cwd(), ".rolay-data-test", randomUUID()),
    minioEndpoint: "localhost",
    minioPort: 9000,
    minioUseSSL: false,
    minioAccessKey: "minioadmin",
    minioSecretKey: "minioadmin",
    minioBucket: "rolay-test",
    minioRegion: undefined,
    minioPrefix: "rolay-test",
    crdtStoreDebounceMs: 50,
    crdtStoreMaxDebounceMs: 100
  };

  return {
    ...baseEnv,
    ...overrides
  };
}

async function cleanupTestEnv(env: AppEnv): Promise<void> {
  await rm(env.localDataDir, { recursive: true, force: true });
}

function createSha256Hash(payload: Buffer): string {
  return `sha256:${createHash("sha256").update(payload).digest("base64")}`;
}

function createSha256HashHex(payload: Buffer): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function decodeCrdtBootstrapState(state: string): Y.Doc {
  const document = new Y.Doc();
  Y.applyUpdate(document, Buffer.from(state, "base64"));
  return document;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 25
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await sleep(stepMs);
  }
}

interface SseMessage {
  id?: string;
  event?: string;
  data?: string;
}

interface SseStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  buffer: string;
}

async function openSseStream(url: string, accessToken: string): Promise<SseStream> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  assert.equal(response.status, 200);
  assert.ok(response.body);
  return {
    reader: response.body.getReader(),
    decoder: new TextDecoder(),
    buffer: ""
  };
}

async function readNextSseMessage(stream: SseStream, timeoutMs = 2000): Promise<SseMessage> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const normalizedBuffer = stream.buffer.replace(/\r/g, "");
    const delimiterIndex = normalizedBuffer.indexOf("\n\n");
    if (delimiterIndex >= 0) {
      const rawMessage = normalizedBuffer.slice(0, delimiterIndex);
      stream.buffer = normalizedBuffer.slice(delimiterIndex + 2);
      if (rawMessage.startsWith(":") || rawMessage.trim() === "") {
        continue;
      }

      const message: SseMessage = {};
      for (const line of rawMessage.split("\n")) {
        if (line.startsWith("id:")) {
          message.id = line.slice(3).trim();
          continue;
        }
        if (line.startsWith("event:")) {
          message.event = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          message.data = line.slice(5).trim();
        }
      }

      return message;
    }

    const result = await Promise.race([
      stream.reader.read(),
      sleep(25).then(() => "tick" as const)
    ]);
    if (result === "tick") {
      continue;
    }
    if (result.done) {
      throw new Error("SSE stream closed before the next message arrived.");
    }

    stream.buffer += stream.decoder.decode(result.value, { stream: true });
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for SSE message.`);
}

async function waitForSseEvent(
  stream: SseStream,
  eventName: string,
  timeoutMs = 2000
): Promise<SseMessage> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const message = await readNextSseMessage(stream, timeoutMs);
    if (message.event === eventName) {
      return message;
    }
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for SSE event "${eventName}".`);
}

async function waitForSseEventMatching<T>(
  stream: SseStream,
  eventName: string,
  predicate: (payload: T, message: SseMessage) => boolean,
  timeoutMs = 2000
): Promise<{ message: SseMessage; payload: T }> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const message = await waitForSseEvent(stream, eventName, timeoutMs);
    const payload = message.data ? (JSON.parse(message.data) as T) : ({} as T);
    if (predicate(payload, message)) {
      return {
        message,
        payload
      };
    }
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for matching SSE event "${eventName}".`);
}

async function loginAs(
  app: AppInstance,
  username: string,
  password: string,
  deviceName: string
): Promise<{ accessToken: string; refreshToken: string; user: Record<string, unknown> }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      username,
      password,
      deviceName
    }
  });

  assert.equal(response.statusCode, 200);
  return response.json();
}

test("memory state snapshot round-trip preserves persisted records", async () => {
  const state = new MemoryState();
  const user = {
    id: "usr_1",
    username: "alice",
    displayName: "Alice",
    isAdmin: true,
    globalRole: "admin" as const,
    passwordHash: "hash",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  const device = {
    id: "dev_1",
    userId: user.id,
    deviceName: "alice-laptop",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z"
  };
  const entry = {
    id: "fil_1",
    path: "Week-01.md",
    kind: "markdown" as const,
    contentMode: "crdt" as const,
    entryVersion: 2,
    docId: "doc_1",
    deleted: false,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };

  state.users.set(user.id, user);
  state.usersByUsername.set(user.username, user.id);
  state.devices.set(device.id, device);
  state.accessTokens.set("access_1", {
    token: "access_1",
    userId: user.id,
    deviceId: device.id,
    expiresAt: "2026-01-02T00:00:00.000Z"
  });
  state.refreshTokens.set("refresh_1", {
    token: "refresh_1",
    userId: user.id,
    deviceId: device.id,
    expiresAt: "2026-01-03T00:00:00.000Z"
  });
  state.workspaces.set("ws_1", {
    workspace: {
      id: "ws_1",
      name: "Notes"
    },
    createdBy: user.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    invite: {
      code: "invite-code",
      enabled: true,
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    memberships: new Map([
      [
        user.id,
        {
          userId: user.id,
          role: "owner",
          joinedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    ]),
    entries: new Map([[entry.id, entry]]),
    events: [
      {
        seq: 1,
        eventType: "tree.entry.created",
        payload: {
          entryId: entry.id
        },
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    nextEventSeq: 2,
    opResults: new Map([
      [
        "op_1",
        {
          opId: "op_1",
          status: "applied",
          eventSeq: 1,
          entry
        }
      ]
    ]),
    listeners: new Set()
  });
  state.blobObjects.set("sha256:blob", {
    hash: "sha256:blob",
    sizeBytes: 5,
    mimeType: "text/plain",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  state.crdtTokens.set("crdt_1", {
    token: "crdt_1",
    workspaceId: "ws_1",
    entryId: entry.id,
    docId: "doc_1",
    userId: user.id,
    role: "owner",
    expiresAt: "2026-01-01T01:00:00.000Z"
  });
  state.blobUploadTickets.set("upload_1", {
    ticketId: "upload_1",
    workspaceId: "ws_1",
    entryId: entry.id,
    userId: user.id,
    hash: "sha256:blob",
    sizeBytes: 5,
    mimeType: "text/plain",
    uploadedBytes: 0,
    expiresAt: "2026-01-01T01:00:00.000Z"
  });
  state.blobDownloadTickets.set("download_1", {
    ticketId: "download_1",
    workspaceId: "ws_1",
    entryId: entry.id,
    userId: user.id,
    hash: "sha256:blob",
    expiresAt: "2026-01-01T01:00:00.000Z"
  });

  const roundTrip = MemoryState.fromSnapshot(state.toSnapshot());
  assert.deepEqual(roundTrip.toSnapshot(), state.toSnapshot());
});

test("GET /ready returns health payload", async () => {
  const app = await buildApp({ logger: false });

  const response = await app.inject({
    method: "GET",
    url: "/ready"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ok: true,
    service: "rolay-server"
  });

  await app.close();
});

test("auth login and refresh issue opaque bearer tokens with global role", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      username: "alice",
      password: "secret",
      deviceName: "roma-laptop"
    }
  });

  assert.equal(login.statusCode, 200);
  assert.match(login.json().accessToken, /^[A-Za-z0-9_-]{20,}$/);
  assert.match(login.json().refreshToken, /^[A-Za-z0-9_-]{20,}$/);
  assert.deepEqual(login.json().user, {
    id: login.json().user.id,
    username: "alice",
    displayName: "Alice",
    isAdmin: true,
    globalRole: "admin"
  });

  const refresh = await app.inject({
    method: "POST",
    url: "/v1/auth/refresh",
    payload: {
      refreshToken: login.json().refreshToken
    }
  });

  assert.equal(refresh.statusCode, 200);
  assert.notEqual(refresh.json().accessToken, login.json().accessToken);
  assert.notEqual(refresh.json().refreshToken, login.json().refreshToken);

  await app.close();
  await cleanupTestEnv(env);
});

test("users can change password when they know the current one", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  const originalSession = await loginAs(app, "alice", "secret", "alice-laptop");

  const changePasswordResponse = await app.inject({
    method: "PATCH",
    url: "/v1/auth/me/password",
    headers: {
      authorization: `Bearer ${originalSession.accessToken}`
    },
    payload: {
      currentPassword: "secret",
      newPassword: "secret-2"
    }
  });

  assert.equal(changePasswordResponse.statusCode, 200);
  assert.notEqual(changePasswordResponse.json().accessToken, originalSession.accessToken);
  assert.notEqual(changePasswordResponse.json().refreshToken, originalSession.refreshToken);
  assert.equal(changePasswordResponse.json().user.username, "alice");

  const oldRefreshResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/refresh",
    payload: {
      refreshToken: originalSession.refreshToken
    }
  });

  assert.equal(oldRefreshResponse.statusCode, 401);
  assert.equal(oldRefreshResponse.json().error.code, "invalid_refresh_token");

  const oldPasswordLogin = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      username: "alice",
      password: "secret",
      deviceName: "alice-laptop-old"
    }
  });

  assert.equal(oldPasswordLogin.statusCode, 401);

  const newPasswordLogin = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      username: "alice",
      password: "secret-2",
      deviceName: "alice-laptop-new"
    }
  });

  assert.equal(newPasswordLogin.statusCode, 200);

  const unchangedPasswordResponse = await app.inject({
    method: "PATCH",
    url: "/v1/auth/me/password",
    headers: {
      authorization: `Bearer ${changePasswordResponse.json().accessToken}`
    },
    payload: {
      currentPassword: "secret-2",
      newPassword: "secret-2"
    }
  });

  assert.equal(unchangedPasswordResponse.statusCode, 400);
  assert.equal(unchangedPasswordResponse.json().error.code, "password_unchanged");

  await app.close();
  await cleanupTestEnv(env);
});

test("seed admin password is updated when env password changes on startup", async () => {
  const env = createTestEnv({
    devAuthUsername: "roma",
    devAuthPassword: "old-secret",
    devAuthDisplayName: "Roma"
  });
  const state = new MemoryState();
  const stateStore = {
    loadState: async () => state,
    saveState: async (_state: MemoryState) => {},
    close: async () => {}
  };
  const settingsEvents = new SettingsEventsService(state);

  const auth = new AuthService(state, env, stateStore, settingsEvents);
  await auth.ensureReady();
  const oldSession = await auth.login("roma", "old-secret", "seed-device");
  assert.equal(oldSession.user.username, "roma");

  env.devAuthPassword = "new-secret";
  await auth.ensureReady();

  await assert.rejects(
    () => auth.login("roma", "old-secret", "seed-device-old"),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      (error as { statusCode?: unknown }).statusCode === 401
  );

  const newSession = await auth.login("roma", "new-secret", "seed-device-new");
  assert.equal(newSession.user.username, "roma");
});

test("settings events are filtered for regular users and admins", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });
  await app.rolay.auth.upsertUser({
    username: "reader1",
    password: "secret",
    displayName: "Reader One",
    globalRole: "reader"
  });

  const adminSession = await loginAs(app, "alice", "secret", "admin-laptop");
  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");
  const readerSession = await loginAs(app, "reader1", "secret", "reader-laptop");
  const initialCursor = app.rolay.settingsEvents.currentCursor();

  const createRoomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Realtime Settings"
    }
  });

  assert.equal(createRoomResponse.statusCode, 201);
  const roomId = createRoomResponse.json().workspace.id;

  const updateProfileResponse = await app.inject({
    method: "PATCH",
    url: "/v1/auth/me/profile",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      displayName: "Writer Updated"
    }
  });

  assert.equal(updateProfileResponse.statusCode, 200);

  const inviteResponse = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/invite`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(inviteResponse.statusCode, 200);

  const joinResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms/join",
    headers: {
      authorization: `Bearer ${readerSession.accessToken}`
    },
    payload: {
      code: inviteResponse.json().invite.code
    }
  });

  assert.equal(joinResponse.statusCode, 200);

  const createUserResponse = await app.inject({
    method: "POST",
    url: "/v1/admin/users",
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    },
    payload: {
      username: "reader2",
      password: "secret",
      displayName: "Reader Two",
      globalRole: "reader"
    }
  });

  assert.equal(createUserResponse.statusCode, 201);

  const adminUser = app.rolay.auth.authenticateAccessToken(adminSession.accessToken).user;
  const writerUser = app.rolay.auth.authenticateAccessToken(writerSession.accessToken).user;
  const readerUser = app.rolay.auth.authenticateAccessToken(readerSession.accessToken).user;

  const writerEvents = app.rolay.settingsEvents.listEventsSince(writerUser, initialCursor);
  const readerEvents = app.rolay.settingsEvents.listEventsSince(readerUser, initialCursor);
  const adminEvents = app.rolay.settingsEvents.listEventsSince(adminUser, initialCursor);
  const writerMembersUpdated = writerEvents
    .filter((event) => event.type === "room.members.updated" && event.scope === "room.members")
    .at(-1);
  const readerMembersUpdated = readerEvents
    .filter((event) => event.type === "room.members.updated" && event.scope === "room.members")
    .at(-1);

  assert.ok(writerEvents.some((event) => event.type === "room.created" && event.scope === "rooms"));
  assert.ok(
    writerEvents.some((event) => event.type === "auth.me.updated" && event.scope === "auth.me")
  );
  assert.ok(writerEvents.some((event) => event.type === "room.updated" && event.scope === "rooms"));
  assert.ok(
    writerEvents.some(
      (event) => event.type === "room.members.updated" && event.scope === "room.members"
    )
  );
  assert.equal(
    Array.isArray(writerMembersUpdated?.payload.members) &&
      writerMembersUpdated?.payload.members.length,
    2
  );
  assert.ok(writerEvents.every((event) => !event.type.startsWith("admin.user")));

  assert.ok(
    readerEvents.some(
      (event) => event.type === "room.membership.changed" && event.scope === "rooms"
    )
  );
  assert.ok(readerEvents.some((event) => event.type === "room.updated" && event.scope === "rooms"));
  assert.ok(
    readerEvents.some(
      (event) => event.type === "room.members.updated" && event.scope === "room.members"
    )
  );
  assert.equal(
    Array.isArray(readerMembersUpdated?.payload.members) &&
      readerMembersUpdated?.payload.members.length,
    2
  );
  assert.ok(readerEvents.every((event) => event.type !== "room.created"));
  assert.ok(readerEvents.every((event) => !event.type.startsWith("admin.")));

  assert.ok(
    adminEvents.some((event) => event.type === "room.created" && event.scope === "admin.rooms")
  );
  assert.ok(
    adminEvents.some((event) => event.type === "room.updated" && event.scope === "admin.rooms")
  );
  assert.ok(
    adminEvents.some((event) => event.type === "admin.user.created" && event.scope === "admin.users")
  );
  assert.ok(
    adminEvents.some((event) => event.type === "admin.user.updated" && event.scope === "admin.users")
  );
  assert.ok(
    adminEvents.some(
      (event) =>
        event.type === "admin.room.members.updated" && event.scope === "admin.room.members"
    )
  );

  await app.close();
  await cleanupTestEnv(env);
});

test("settings SSE stream sends ready event and supports cursor resume", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });

  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");

  await app.listen({
    host: "127.0.0.1",
    port: 0
  });

  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const firstStream = await openSseStream(`${baseUrl}/v1/events/settings`, writerSession.accessToken);
  const readyMessage = await waitForSseEvent(firstStream, "stream.ready");
  assert.equal(readyMessage.id, "0");
  assert.ok(readyMessage.data);
  assert.equal(JSON.parse(readyMessage.data).scope, "settings.stream");

  const createFirstRoomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "SSE Room One"
    }
  });

  assert.equal(createFirstRoomResponse.statusCode, 201);

  const firstRoomEvent = await waitForSseEvent(firstStream, "room.created");
  assert.ok(firstRoomEvent.id);
  assert.ok(firstRoomEvent.data);
  const firstRoomPayload = JSON.parse(firstRoomEvent.data);
  assert.equal(firstRoomPayload.scope, "rooms");
  assert.equal(firstRoomPayload.payload.room.workspace.name, "SSE Room One");

  await firstStream.reader.cancel();

  const createSecondRoomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "SSE Room Two"
    }
  });

  assert.equal(createSecondRoomResponse.statusCode, 201);

  const resumedStream = await openSseStream(
    `${baseUrl}/v1/events/settings?cursor=${firstRoomEvent.id}`,
    writerSession.accessToken
  );
  const resumedRoomEvent = await waitForSseEvent(resumedStream, "room.created");
  assert.ok(resumedRoomEvent.data);
  const resumedPayload = JSON.parse(resumedRoomEvent.data);
  assert.equal(resumedPayload.payload.room.workspace.name, "SSE Room Two");

  await resumedStream.reader.cancel();
  await app.close();
  await cleanupTestEnv(env);
});

test("writer can create duplicate-named rooms, manage invite key, and members can edit", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });
  await app.rolay.auth.upsertUser({
    username: "reader1",
    password: "secret",
    displayName: "Reader One",
    globalRole: "reader"
  });
  await app.rolay.auth.upsertUser({
    username: "reader2",
    password: "secret",
    displayName: "Reader Two",
    globalRole: "reader"
  });

  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");
  const readerSession = await loginAs(app, "reader1", "secret", "reader-laptop");
  const secondReaderSession = await loginAs(app, "reader2", "secret", "reader2-laptop");

  const firstRoomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Calculus"
    }
  });

  const secondRoomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Calculus"
    }
  });

  assert.equal(firstRoomResponse.statusCode, 201);
  assert.equal(secondRoomResponse.statusCode, 201);
  assert.equal(firstRoomResponse.json().workspace.name, "Calculus");
  assert.equal(secondRoomResponse.json().workspace.name, "Calculus");
  assert.notEqual(firstRoomResponse.json().workspace.id, secondRoomResponse.json().workspace.id);

  const readerCreateAttempt = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${readerSession.accessToken}`
    },
    payload: {
      name: "Should Fail"
    }
  });

  assert.equal(readerCreateAttempt.statusCode, 403);

  const listRoomsResponse = await app.inject({
    method: "GET",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(listRoomsResponse.statusCode, 200);
  assert.equal(listRoomsResponse.json().workspaces.length, 2);

  const roomId = firstRoomResponse.json().workspace.id;
  const inviteResponse = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/invite`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(inviteResponse.statusCode, 200);
  const originalInviteCode = inviteResponse.json().invite.code;
  assert.equal(inviteResponse.json().invite.enabled, true);

  const disableInviteResponse = await app.inject({
    method: "PATCH",
    url: `/v1/rooms/${roomId}/invite`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      enabled: false
    }
  });

  assert.equal(disableInviteResponse.statusCode, 200);
  assert.equal(disableInviteResponse.json().invite.enabled, false);
  assert.equal(disableInviteResponse.json().invite.code, originalInviteCode);

  const disabledJoinResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms/join",
    headers: {
      authorization: `Bearer ${secondReaderSession.accessToken}`
    },
    payload: {
      code: originalInviteCode
    }
  });

  assert.equal(disabledJoinResponse.statusCode, 403);

  const enableInviteResponse = await app.inject({
    method: "PATCH",
    url: `/v1/rooms/${roomId}/invite`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      enabled: true
    }
  });

  assert.equal(enableInviteResponse.statusCode, 200);
  assert.equal(enableInviteResponse.json().invite.code, originalInviteCode);
  assert.equal(enableInviteResponse.json().invite.enabled, true);

  const regenerateInviteResponse = await app.inject({
    method: "POST",
    url: `/v1/rooms/${roomId}/invite/regenerate`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(regenerateInviteResponse.statusCode, 200);
  const regeneratedCode = regenerateInviteResponse.json().invite.code;
  assert.notEqual(regeneratedCode, originalInviteCode);
  assert.equal(regenerateInviteResponse.json().invite.enabled, true);

  const oldCodeJoinResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms/join",
    headers: {
      authorization: `Bearer ${readerSession.accessToken}`
    },
    payload: {
      code: originalInviteCode
    }
  });

  assert.equal(oldCodeJoinResponse.statusCode, 404);

  const joinResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms/join",
    headers: {
      authorization: `Bearer ${readerSession.accessToken}`
    },
    payload: {
      code: regeneratedCode
    }
  });

  assert.equal(joinResponse.statusCode, 200);
  assert.equal(joinResponse.json().workspace.id, roomId);

  const readerRoomsResponse = await app.inject({
    method: "GET",
    url: "/v1/workspaces",
    headers: {
      authorization: `Bearer ${readerSession.accessToken}`
    }
  });

  assert.equal(readerRoomsResponse.statusCode, 200);
  assert.equal(readerRoomsResponse.json().workspaces.length, 1);
  assert.equal(readerRoomsResponse.json().workspaces[0].membershipRole, "member");

  const createBatch = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${readerSession.accessToken}`
    },
    payload: {
      deviceId: "reader-device-1",
      operations: [
        {
          opId: "op_folder",
          type: "create_folder",
          path: "Math"
        },
        {
          opId: "op_note",
          type: "create_markdown",
          path: "Math/Week-01.md"
        }
      ]
    }
  });

  assert.equal(createBatch.statusCode, 200);
  const createdResults = createBatch.json().results;
  assert.equal(createdResults[1].entry.path, "Math/Week-01.md");

  const snapshotResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${roomId}/tree`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(snapshotResponse.statusCode, 200);
  assert.equal(snapshotResponse.json().entries.length, 2);
  const folderEntry = snapshotResponse.json().entries.find(
    (entry: { kind: string }) => entry.kind === "folder"
  );
  const markdownEntry = snapshotResponse.json().entries.find(
    (entry: { kind: string }) => entry.kind === "markdown"
  );
  assert.ok(folderEntry);
  assert.ok(markdownEntry);

  const moveFolderResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_move_folder",
          type: "move_entry",
          entryId: folderEntry.id,
          newPath: "Lectures",
          preconditions: {
            entryVersion: folderEntry.entryVersion,
            path: folderEntry.path
          }
        }
      ]
    }
  });

  assert.equal(moveFolderResponse.statusCode, 200);
  assert.equal(moveFolderResponse.json().results[0].entry.path, "Lectures");

  const conflictResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-2",
      operations: [
        {
          opId: "op_conflict",
          type: "move_entry",
          entryId: markdownEntry.id,
          newPath: "Lectures/Week-02.md",
          preconditions: {
            entryVersion: 0,
            path: "Math/Week-01.md"
          }
        }
      ]
    }
  });

  assert.equal(conflictResponse.statusCode, 409);
  assert.equal(conflictResponse.json().results[0].status, "conflict");
  assert.equal(conflictResponse.json().results[0].reason, "entry_version_mismatch");

  await app.close();
  await cleanupTestEnv(env);
});

test("room members endpoint is available to participants and rejects non-members", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });
  await app.rolay.auth.upsertUser({
    username: "reader1",
    password: "secret",
    displayName: "Reader One",
    globalRole: "reader"
  });
  await app.rolay.auth.upsertUser({
    username: "reader2",
    password: "secret",
    displayName: "Reader Two",
    globalRole: "reader"
  });

  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");
  const readerSession = await loginAs(app, "reader1", "secret", "reader-laptop");
  const outsiderSession = await loginAs(app, "reader2", "secret", "reader2-laptop");

  const roomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Members List Room"
    }
  });

  assert.equal(roomResponse.statusCode, 201);
  const roomId = roomResponse.json().workspace.id;

  const inviteResponse = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/invite`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(inviteResponse.statusCode, 200);

  const joinResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms/join",
    headers: {
      authorization: `Bearer ${readerSession.accessToken}`
    },
    payload: {
      code: inviteResponse.json().invite.code
    }
  });

  assert.equal(joinResponse.statusCode, 200);

  const memberListResponse = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/members`,
    headers: {
      authorization: `Bearer ${readerSession.accessToken}`
    }
  });

  assert.equal(memberListResponse.statusCode, 200);
  assert.equal(memberListResponse.json().members.length, 2);
  assert.equal(memberListResponse.json().members[0].role, "owner");
  assert.equal(memberListResponse.json().members[1].role, "member");
  assert.equal(memberListResponse.json().members[1].user.username, "reader1");

  const legacyAliasResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${roomId}/members`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(legacyAliasResponse.statusCode, 200);
  assert.equal(legacyAliasResponse.json().members.length, 2);

  const outsiderResponse = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/members`,
    headers: {
      authorization: `Bearer ${outsiderSession.accessToken}`
    }
  });

  assert.equal(outsiderResponse.statusCode, 403);

  await app.close();
  await cleanupTestEnv(env);
});

test("admin can manage users and rooms", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  const adminSession = await loginAs(app, "alice", "secret", "admin-laptop");

  const createWriterResponse = await app.inject({
    method: "POST",
    url: "/v1/admin/users",
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    },
    payload: {
      username: "writer1",
      password: "writer-secret",
      globalRole: "writer"
    }
  });

  const createReaderResponse = await app.inject({
    method: "POST",
    url: "/v1/admin/users",
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    },
    payload: {
      username: "reader1",
      password: "reader-secret",
      globalRole: "reader",
      displayName: "Reader One"
    }
  });

  assert.equal(createWriterResponse.statusCode, 201);
  assert.equal(createWriterResponse.json().user.globalRole, "writer");
  assert.equal(createReaderResponse.statusCode, 201);
  assert.equal(createReaderResponse.json().user.displayName, "Reader One");

  const usersListResponse = await app.inject({
    method: "GET",
    url: "/v1/admin/users",
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    }
  });

  assert.equal(usersListResponse.statusCode, 200);
  assert.equal(usersListResponse.json().users.length, 3);

  const writerSession = await loginAs(app, "writer1", "writer-secret", "writer-laptop");
  const createRoomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Physics"
    }
  });

  assert.equal(createRoomResponse.statusCode, 201);
  const roomId = createRoomResponse.json().workspace.id;

  const adminWorkspacesResponse = await app.inject({
    method: "GET",
    url: "/v1/admin/workspaces",
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    }
  });

  assert.equal(adminWorkspacesResponse.statusCode, 200);
  assert.equal(adminWorkspacesResponse.json().workspaces.length, 1);
  assert.equal(adminWorkspacesResponse.json().workspaces[0].workspace.id, roomId);

  const addMemberResponse = await app.inject({
    method: "POST",
    url: `/v1/admin/workspaces/${roomId}/members`,
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    },
    payload: {
      username: "reader1",
      role: "member"
    }
  });

  assert.equal(addMemberResponse.statusCode, 200);
  assert.equal(addMemberResponse.json().membership.role, "member");
  assert.equal(addMemberResponse.json().user.username, "reader1");

  const membersResponse = await app.inject({
    method: "GET",
    url: `/v1/admin/workspaces/${roomId}/members`,
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    }
  });

  assert.equal(membersResponse.statusCode, 200);
  assert.equal(membersResponse.json().members.length, 2);

  const deleteUserResponse = await app.inject({
    method: "DELETE",
    url: `/v1/admin/users/${createReaderResponse.json().user.id}`,
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    }
  });

  assert.equal(deleteUserResponse.statusCode, 200);
  assert.equal(deleteUserResponse.json().user.username, "reader1");

  const membersAfterDeleteResponse = await app.inject({
    method: "GET",
    url: `/v1/admin/workspaces/${roomId}/members`,
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    }
  });

  assert.equal(membersAfterDeleteResponse.statusCode, 200);
  assert.equal(membersAfterDeleteResponse.json().members.length, 1);
  assert.equal(membersAfterDeleteResponse.json().members[0].user.username, "writer1");

  const deleteWorkspaceResponse = await app.inject({
    method: "DELETE",
    url: `/v1/admin/workspaces/${roomId}`,
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    }
  });

  assert.equal(deleteWorkspaceResponse.statusCode, 200);
  assert.equal(deleteWorkspaceResponse.json().workspace.id, roomId);

  const adminWorkspacesAfterDeleteResponse = await app.inject({
    method: "GET",
    url: "/v1/admin/workspaces",
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    }
  });

  assert.equal(adminWorkspacesAfterDeleteResponse.statusCode, 200);
  assert.equal(adminWorkspacesAfterDeleteResponse.json().workspaces.length, 0);

  await app.close();
  await cleanupTestEnv(env);
});

test("file endpoints issue CRDT tokens and blob tickets for room members", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });
  await app.rolay.auth.upsertUser({
    username: "reader1",
    password: "secret",
    displayName: "Reader One",
    globalRole: "reader"
  });

  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");
  const readerSession = await loginAs(app, "reader1", "secret", "reader-laptop");

  const roomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Physics Notes"
    }
  });

  assert.equal(roomResponse.statusCode, 201);
  const roomId = roomResponse.json().workspace.id;

  const inviteResponse = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/invite`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(inviteResponse.statusCode, 200);

  const joinResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms/join",
    headers: {
      authorization: `Bearer ${readerSession.accessToken}`
    },
    payload: {
      code: inviteResponse.json().invite.code
    }
  });

  assert.equal(joinResponse.statusCode, 200);

  const createEntriesResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_markdown",
          type: "create_markdown",
          path: "Week-01.md"
        },
        {
          opId: "op_binary",
          type: "create_binary_placeholder",
          path: "attachments/diagram.png"
        }
      ]
    }
  });

  assert.equal(createEntriesResponse.statusCode, 200);
  const markdownEntry = createEntriesResponse.json().results[0].entry;
  const binaryEntry = createEntriesResponse.json().results[1].entry;

  const crdtTokenResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${markdownEntry.id}/crdt-token`,
    headers: {
      authorization: `Bearer ${readerSession.accessToken}`
    }
  });

  assert.equal(crdtTokenResponse.statusCode, 200);
  assert.equal(crdtTokenResponse.json().entryId, markdownEntry.id);
  assert.equal(crdtTokenResponse.json().docId, markdownEntry.docId);
  assert.equal(crdtTokenResponse.json().provider, "yjs-hocuspocus");

  const binaryPayload = Buffer.from("diagram-binary-v1", "utf8");
  const binaryHash = createSha256Hash(binaryPayload);

  const memberUploadTicket = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/upload-ticket`,
    headers: {
      authorization: `Bearer ${readerSession.accessToken}`
    },
    payload: {
      hash: binaryHash,
      sizeBytes: binaryPayload.byteLength,
      mimeType: "image/png"
    }
  });

  assert.equal(memberUploadTicket.statusCode, 200);
  assert.equal(memberUploadTicket.json().alreadyExists, false);
  assert.equal(memberUploadTicket.json().uploadId.length > 0, true);
  assert.equal(memberUploadTicket.json().sizeBytes, binaryPayload.byteLength);
  assert.equal(memberUploadTicket.json().mimeType, "image/png");
  assert.equal(memberUploadTicket.json().uploadedBytes, 0);
  assert.equal(memberUploadTicket.json().cancel.method, "DELETE");
  const uploadPath = new URL(memberUploadTicket.json().upload.url).pathname;

  const uploadResponse = await app.inject({
    method: "PUT",
    url: uploadPath,
    headers: {
      "content-type": "application/octet-stream"
    },
    payload: binaryPayload
  });

  assert.equal(uploadResponse.statusCode, 200);
  assert.equal(uploadResponse.json().complete, true);
  assert.equal(uploadResponse.json().uploadedBytes, binaryPayload.byteLength);
  assert.equal(uploadResponse.json().hash, binaryHash);

  const commitBlobResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${readerSession.accessToken}`
    },
    payload: {
      deviceId: "reader-device-1",
      operations: [
        {
          opId: "op_commit_blob",
          type: "commit_blob_revision",
          entryId: binaryEntry.id,
          hash: binaryHash,
          sizeBytes: binaryPayload.byteLength,
          mimeType: "image/png",
          preconditions: {
            entryVersion: binaryEntry.entryVersion
          }
        }
      ]
    }
  });

  assert.equal(commitBlobResponse.statusCode, 200);
  assert.equal(commitBlobResponse.json().results[0].entry.blob.hash, binaryHash);
  assert.equal(commitBlobResponse.json().results[0].entry.blob.sizeBytes, binaryPayload.byteLength);

  const writerUser = app.rolay.auth.authenticateAccessToken(writerSession.accessToken).user;
  const workspaceEvents = app.rolay.workspaces.listEventsSince(writerUser, roomId, 0);
  const commitEvent = workspaceEvents.find((event) => event.eventType === "blob.revision.committed");
  assert.ok(commitEvent);
  assert.equal(commitEvent.payload.hash, binaryHash);
  assert.equal(commitEvent.payload.sizeBytes, binaryPayload.byteLength);
  assert.equal(commitEvent.payload.mimeType, "image/png");

  const downloadTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/download-ticket`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(downloadTicketResponse.statusCode, 200);
  assert.equal(downloadTicketResponse.json().sizeBytes, binaryPayload.byteLength);
  assert.equal(downloadTicketResponse.json().mimeType, "image/png");
  assert.equal(downloadTicketResponse.json().rangeSupported, true);
  assert.equal(
    downloadTicketResponse.json().contentUrl,
    `${env.publicBaseUrl}/v1/files/${binaryEntry.id}/blob/content`
  );
  const downloadPath = new URL(downloadTicketResponse.json().url).pathname;
  const downloadResponse = await app.inject({
    method: "GET",
    url: downloadPath
  });

  assert.equal(downloadResponse.statusCode, 200);
  assert.equal(downloadResponse.headers["content-type"], "image/png");
  assert.equal(downloadResponse.headers["content-length"], String(binaryPayload.byteLength));
  assert.equal(downloadResponse.headers["accept-ranges"], "bytes");
  assert.equal(downloadResponse.headers["x-rolay-blob-hash"], binaryHash);
  assert.equal(downloadResponse.body, binaryPayload.toString("utf8"));

  await app.close();
  await cleanupTestEnv(env);
});

test("authenticated blob content upload endpoint accepts raw octet-stream and returns detailed hash mismatch errors", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });

  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");
  const roomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Authenticated Blob Upload"
    }
  });

  assert.equal(roomResponse.statusCode, 201);
  const roomId = roomResponse.json().workspace.id;

  const createEntryResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_auth_binary",
          type: "create_binary_placeholder",
          path: "attachments/audio.ogg"
        }
      ]
    }
  });

  assert.equal(createEntryResponse.statusCode, 200);
  const binaryEntry = createEntryResponse.json().results[0].entry;
  const payload = Buffer.from("voice-note-binary", "utf8");
  const hash = createSha256Hash(payload);

  const uploadTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/upload-ticket`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      hash,
      sizeBytes: payload.byteLength,
      mimeType: "audio/ogg"
    }
  });

  assert.equal(uploadTicketResponse.statusCode, 200);
  const uploadId = uploadTicketResponse.json().uploadId;

  const uploadContentResponse = await app.inject({
    method: "PUT",
    url: `/v1/files/${binaryEntry.id}/blob/uploads/${uploadId}/content`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`,
      "content-type": "application/octet-stream"
    },
    payload
  });

  assert.equal(uploadContentResponse.statusCode, 200);
  assert.deepEqual(uploadContentResponse.json(), {
    ok: true,
    uploadId,
    receivedBytes: payload.byteLength,
    uploadedBytes: payload.byteLength,
    sizeBytes: payload.byteLength,
    complete: true,
    hash
  });

  const commitResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_auth_binary_commit",
          type: "commit_blob_revision",
          entryId: binaryEntry.id,
          hash,
          sizeBytes: payload.byteLength,
          mimeType: "audio/ogg",
          preconditions: {
            entryVersion: binaryEntry.entryVersion
          }
        }
      ]
    }
  });

  assert.equal(commitResponse.statusCode, 200);
  assert.equal(commitResponse.json().results[0].entry.blob.hash, hash);

  const mismatchTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/upload-ticket`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      hash: createSha256Hash(Buffer.from("different-payload", "utf8")),
      sizeBytes: payload.byteLength,
      mimeType: "audio/ogg"
    }
  });

  assert.equal(mismatchTicketResponse.statusCode, 200);

  const mismatchUploadResponse = await app.inject({
    method: "PUT",
    url: `/v1/files/${binaryEntry.id}/blob/uploads/${mismatchTicketResponse.json().uploadId}/content`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`,
      "content-type": "application/octet-stream"
    },
    payload
  });

  assert.equal(mismatchUploadResponse.statusCode, 400);
  assert.equal(mismatchUploadResponse.json().error.code, "blob_hash_mismatch");
  assert.equal(
    mismatchUploadResponse.json().error.details.expectedHash,
    mismatchTicketResponse.json().hash
  );
  assert.equal(
    mismatchUploadResponse.json().error.details.actualHash,
    hash
  );
  assert.equal(
    mismatchUploadResponse.json().error.details.receivedSizeBytes,
    payload.byteLength
  );

  await app.close();
  await cleanupTestEnv(env);
});

test("blob uploads accept hex sha256 digests and normalize them to canonical storage keys", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });

  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");
  const roomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Hex Hash Upload"
    }
  });

  assert.equal(roomResponse.statusCode, 201);
  const roomId = roomResponse.json().workspace.id;

  const createEntryResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_hex_binary",
          type: "create_binary_placeholder",
          path: "attachments/recording.bin"
        }
      ]
    }
  });

  assert.equal(createEntryResponse.statusCode, 200);
  const binaryEntry = createEntryResponse.json().results[0].entry;
  const payload = Buffer.from("voice-note-binary", "utf8");
  const canonicalHash = createSha256Hash(payload);
  const hexHash = createSha256HashHex(payload);

  const uploadTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/upload-ticket`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      hash: hexHash,
      sizeBytes: payload.byteLength,
      mimeType: "application/octet-stream"
    }
  });

  assert.equal(uploadTicketResponse.statusCode, 200);
  assert.equal(uploadTicketResponse.json().hash, canonicalHash);
  assert.equal(uploadTicketResponse.json().uploadedBytes, 0);
  const uploadId = uploadTicketResponse.json().uploadId;

  const uploadContentResponse = await app.inject({
    method: "PUT",
    url: `/v1/files/${binaryEntry.id}/blob/uploads/${uploadId}/content`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`,
      "content-type": "application/octet-stream"
    },
    payload
  });

  assert.equal(uploadContentResponse.statusCode, 200);
  assert.equal(uploadContentResponse.json().hash, canonicalHash);
  assert.equal(uploadContentResponse.json().complete, true);
  assert.equal(uploadContentResponse.json().uploadedBytes, payload.byteLength);

  const commitResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_hex_commit",
          type: "commit_blob_revision",
          entryId: binaryEntry.id,
          hash: hexHash,
          sizeBytes: payload.byteLength,
          mimeType: "application/octet-stream",
          preconditions: {
            entryVersion: binaryEntry.entryVersion
          }
        }
      ]
    }
  });

  assert.equal(commitResponse.statusCode, 200);
  assert.equal(commitResponse.json().results[0].entry.blob.hash, canonicalHash);

  const downloadTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/download-ticket`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(downloadTicketResponse.statusCode, 200);
  assert.equal(downloadTicketResponse.json().hash, canonicalHash);
  assert.equal(downloadTicketResponse.json().rangeSupported, true);

  await app.close();
  await cleanupTestEnv(env);
});

test("blob upload sessions can be canceled before transfer begins", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });

  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");
  const roomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Cancelable Uploads"
    }
  });

  assert.equal(roomResponse.statusCode, 201);
  const roomId = roomResponse.json().workspace.id;

  const createEntryResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_cancelable_binary",
          type: "create_binary_placeholder",
          path: "attachments/big-video.mp4"
        }
      ]
    }
  });

  assert.equal(createEntryResponse.statusCode, 200);
  const binaryEntry = createEntryResponse.json().results[0].entry;
  const payload = Buffer.from("pretend-big-upload", "utf8");
  const hash = createSha256Hash(payload);

  const uploadTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/upload-ticket`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      hash,
      sizeBytes: payload.byteLength,
      mimeType: "video/mp4"
    }
  });

  assert.equal(uploadTicketResponse.statusCode, 200);
  const uploadId = uploadTicketResponse.json().uploadId;
  const uploadPath = new URL(uploadTicketResponse.json().upload.url).pathname;

  const cancelResponse = await app.inject({
    method: "DELETE",
    url: `/v1/files/${binaryEntry.id}/blob/uploads/${uploadId}`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(cancelResponse.statusCode, 200);
  assert.deepEqual(cancelResponse.json(), {
    ok: true,
    uploadId,
    wasActive: false
  });

  const uploadAfterCancelResponse = await app.inject({
    method: "PUT",
    url: uploadPath,
    headers: {
      "content-type": "video/mp4"
    },
    payload
  });

  assert.equal(uploadAfterCancelResponse.statusCode, 404);
  assert.equal(uploadAfterCancelResponse.json().error.code, "upload_ticket_not_found");

  await app.close();
  await cleanupTestEnv(env);
});

test("blob uploads can be resumed from the last confirmed byte offset", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });

  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");
  const roomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Resumable Uploads"
    }
  });

  assert.equal(roomResponse.statusCode, 201);
  const roomId = roomResponse.json().workspace.id;

  const createEntryResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_resumable_binary",
          type: "create_binary_placeholder",
          path: "attachments/archive.bin"
        }
      ]
    }
  });

  assert.equal(createEntryResponse.statusCode, 200);
  const binaryEntry = createEntryResponse.json().results[0].entry;
  const payload = Buffer.from("0123456789abcdef", "utf8");
  const firstChunk = payload.subarray(0, 6);
  const secondChunk = payload.subarray(6);
  const hash = createSha256Hash(payload);

  const initialTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/upload-ticket`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      hash,
      sizeBytes: payload.byteLength,
      mimeType: "application/octet-stream"
    }
  });

  assert.equal(initialTicketResponse.statusCode, 200);
  assert.equal(initialTicketResponse.json().uploadedBytes, 0);
  const uploadId = initialTicketResponse.json().uploadId;

  const firstChunkResponse = await app.inject({
    method: "PUT",
    url: `/v1/files/${binaryEntry.id}/blob/uploads/${uploadId}/content`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`,
      "content-type": "application/octet-stream",
      "content-range": `bytes 0-${firstChunk.byteLength - 1}/${payload.byteLength}`
    },
    payload: firstChunk
  });

  assert.equal(firstChunkResponse.statusCode, 200);
  assert.deepEqual(firstChunkResponse.json(), {
    ok: true,
    uploadId,
    receivedBytes: firstChunk.byteLength,
    uploadedBytes: firstChunk.byteLength,
    sizeBytes: payload.byteLength,
    complete: false
  });

  const resumedTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/upload-ticket`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      hash,
      sizeBytes: payload.byteLength,
      mimeType: "application/octet-stream"
    }
  });

  assert.equal(resumedTicketResponse.statusCode, 200);
  assert.equal(resumedTicketResponse.json().uploadId, uploadId);
  assert.equal(resumedTicketResponse.json().uploadedBytes, firstChunk.byteLength);
  assert.equal(resumedTicketResponse.json().status, "uploading");

  const mismatchOffsetResponse = await app.inject({
    method: "PUT",
    url: `/v1/files/${binaryEntry.id}/blob/uploads/${uploadId}/content`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`,
      "content-type": "application/octet-stream",
      "content-range": `bytes 0-${secondChunk.byteLength - 1}/${payload.byteLength}`
    },
    payload: secondChunk
  });

  assert.equal(mismatchOffsetResponse.statusCode, 409);
  assert.equal(mismatchOffsetResponse.json().error.code, "blob_offset_mismatch");
  assert.equal(
    mismatchOffsetResponse.json().error.details.expectedOffset,
    firstChunk.byteLength
  );
  assert.equal(mismatchOffsetResponse.json().error.details.receivedOffset, 0);

  const secondChunkResponse = await app.inject({
    method: "PUT",
    url: `/v1/files/${binaryEntry.id}/blob/uploads/${uploadId}/content`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`,
      "content-type": "application/octet-stream",
      "content-range": `bytes ${firstChunk.byteLength}-${payload.byteLength - 1}/${payload.byteLength}`
    },
    payload: secondChunk
  });

  assert.equal(secondChunkResponse.statusCode, 200);
  assert.deepEqual(secondChunkResponse.json(), {
    ok: true,
    uploadId,
    receivedBytes: payload.byteLength,
    uploadedBytes: payload.byteLength,
    sizeBytes: payload.byteLength,
    complete: true,
    hash
  });

  const readyTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/upload-ticket`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      hash,
      sizeBytes: payload.byteLength,
      mimeType: "application/octet-stream"
    }
  });

  assert.equal(readyTicketResponse.statusCode, 200);
  assert.equal(readyTicketResponse.json().alreadyExists, true);
  assert.equal(readyTicketResponse.json().uploadedBytes, payload.byteLength);
  assert.equal(readyTicketResponse.json().status, "ready");

  await app.close();
  await cleanupTestEnv(env);
});

test("authenticated blob content endpoint supports ranged downloads", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });

  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");
  const roomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Ranged Downloads"
    }
  });

  assert.equal(roomResponse.statusCode, 201);
  const roomId = roomResponse.json().workspace.id;

  const createEntryResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_ranged_binary",
          type: "create_binary_placeholder",
          path: "attachments/slides.pdf"
        }
      ]
    }
  });

  assert.equal(createEntryResponse.statusCode, 200);
  const binaryEntry = createEntryResponse.json().results[0].entry;
  const payload = Buffer.from("abcdefghijklmnop", "utf8");
  const hash = createSha256Hash(payload);

  const uploadTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/upload-ticket`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      hash,
      sizeBytes: payload.byteLength,
      mimeType: "application/pdf"
    }
  });

  assert.equal(uploadTicketResponse.statusCode, 200);
  const uploadId = uploadTicketResponse.json().uploadId;

  const uploadContentResponse = await app.inject({
    method: "PUT",
    url: `/v1/files/${binaryEntry.id}/blob/uploads/${uploadId}/content`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`,
      "content-type": "application/octet-stream"
    },
    payload
  });

  assert.equal(uploadContentResponse.statusCode, 200);
  assert.equal(uploadContentResponse.json().complete, true);

  const commitResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_ranged_binary_commit",
          type: "commit_blob_revision",
          entryId: binaryEntry.id,
          hash,
          sizeBytes: payload.byteLength,
          mimeType: "application/pdf",
          preconditions: {
            entryVersion: binaryEntry.entryVersion
          }
        }
      ]
    }
  });

  assert.equal(commitResponse.statusCode, 200);

  const partialDownloadResponse = await app.inject({
    method: "GET",
    url: `/v1/files/${binaryEntry.id}/blob/content`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`,
      range: "bytes=5-9"
    }
  });

  assert.equal(partialDownloadResponse.statusCode, 206);
  assert.equal(partialDownloadResponse.headers["accept-ranges"], "bytes");
  assert.equal(partialDownloadResponse.headers["content-type"], "application/pdf");
  assert.equal(partialDownloadResponse.headers["content-length"], "5");
  assert.equal(
    partialDownloadResponse.headers["content-range"],
    `bytes 5-9/${payload.byteLength}`
  );
  assert.equal(partialDownloadResponse.headers["x-rolay-blob-hash"], hash);
  assert.equal(partialDownloadResponse.body, payload.subarray(5, 10).toString("utf8"));

  const downloadTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/download-ticket`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(downloadTicketResponse.statusCode, 200);
  const downloadPath = new URL(downloadTicketResponse.json().url).pathname;
  const ticketRangeResponse = await app.inject({
    method: "GET",
    url: downloadPath,
    headers: {
      range: "bytes=10-"
    }
  });

  assert.equal(ticketRangeResponse.statusCode, 206);
  assert.equal(ticketRangeResponse.headers["accept-ranges"], "bytes");
  assert.equal(
    ticketRangeResponse.headers["content-range"],
    `bytes 10-${payload.byteLength - 1}/${payload.byteLength}`
  );
  assert.equal(ticketRangeResponse.body, payload.subarray(10).toString("utf8"));

  await app.close();
  await cleanupTestEnv(env);
});

test("realtime CRDT websocket sync persists markdown document state", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });

  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");
  const roomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Realtime Notes"
    }
  });

  assert.equal(roomResponse.statusCode, 201);
  const roomId = roomResponse.json().workspace.id;

  const createEntryResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_realtime_markdown",
          type: "create_markdown",
          path: "Week-02.md"
        }
      ]
    }
  });

  assert.equal(createEntryResponse.statusCode, 200);
  const markdownEntry = createEntryResponse.json().results[0].entry;

  const crdtTokenResponseA = await app.inject({
    method: "POST",
    url: `/v1/files/${markdownEntry.id}/crdt-token`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(crdtTokenResponseA.statusCode, 200);

  await app.listen({
    host: "127.0.0.1",
    port: 0
  });

  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const wsUrl = `ws://127.0.0.1:${address.port}/v1/crdt`;

  const firstDoc = new Y.Doc();
  const secondDoc = new Y.Doc();
  const firstText = firstDoc.getText("content");
  const secondText = secondDoc.getText("content");
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

  let firstSynced = false;
  const providerA = new HocuspocusProvider({
    url: wsUrl,
    name: markdownEntry.docId,
    document: firstDoc,
    token: crdtTokenResponseA.json().token,
    onSynced: ({ state }) => {
      if (state) {
        firstSynced = true;
      }
    }
  });

  await waitFor(() => firstSynced);
  firstText.insert(0, "Hello realtime");

  const crdtTokenResponseB = await app.inject({
    method: "POST",
    url: `/v1/files/${markdownEntry.id}/crdt-token`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(crdtTokenResponseB.statusCode, 200);

  let secondSynced = false;
  const providerB = new HocuspocusProvider({
    url: wsUrl,
    name: markdownEntry.docId,
    document: secondDoc,
    token: crdtTokenResponseB.json().token,
    onSynced: ({ state }) => {
      if (state) {
        secondSynced = true;
      }
    }
  });

  await waitFor(() => secondSynced);
  await waitFor(() => secondText.toString() === "Hello realtime");
  await sleep(200);

  const storedDocument = await app.rolay.storage.loadDocument(markdownEntry.docId);
  assert.ok(storedDocument);
  const persistedDoc = new Y.Doc();
  Y.applyUpdate(persistedDoc, storedDocument);
  assert.equal(persistedDoc.getText("content").toString(), "Hello realtime");

  providerA.destroy();
  providerB.destroy();
  await app.close();
  await cleanupTestEnv(env);
});

test("room note presence SSE reflects markdown awareness without requiring selection", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });

  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");
  const writerUser = writerSession.user as { id: string; displayName: string };
  const roomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Presence Notes"
    }
  });

  assert.equal(roomResponse.statusCode, 201);
  const roomId = roomResponse.json().workspace.id;

  const createEntryResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_note_presence_markdown",
          type: "create_markdown",
          path: "Week-03.md"
        }
      ]
    }
  });

  assert.equal(createEntryResponse.statusCode, 200);
  const markdownEntry = createEntryResponse.json().results[0].entry;

  await app.listen({
    host: "127.0.0.1",
    port: 0
  });

  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/v1/crdt`;

  const presenceStream = await openSseStream(
    `${baseUrl}/v1/workspaces/${roomId}/note-presence/events`,
    writerSession.accessToken
  );
  const snapshotMessage = await waitForSseEvent(presenceStream, "presence.snapshot");
  assert.ok(snapshotMessage.data);
  assert.deepEqual(JSON.parse(snapshotMessage.data), {
    workspaceId: roomId,
    notes: []
  });

  const crdtTokenResponseA = await app.inject({
    method: "POST",
    url: `/v1/files/${markdownEntry.id}/crdt-token`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(crdtTokenResponseA.statusCode, 200);

  const crdtTokenResponseB = await app.inject({
    method: "POST",
    url: `/v1/files/${markdownEntry.id}/crdt-token`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(crdtTokenResponseB.statusCode, 200);

  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

  const firstDoc = new Y.Doc();
  const secondDoc = new Y.Doc();
  let firstSynced = false;
  let secondSynced = false;

  const providerA = new HocuspocusProvider({
    url: wsUrl,
    name: markdownEntry.docId,
    document: firstDoc,
    token: crdtTokenResponseA.json().token,
    onSynced: ({ state }) => {
      if (state) {
        firstSynced = true;
      }
    }
  });

  const providerB = new HocuspocusProvider({
    url: wsUrl,
    name: markdownEntry.docId,
    document: secondDoc,
    token: crdtTokenResponseB.json().token,
    onSynced: ({ state }) => {
      if (state) {
        secondSynced = true;
      }
    }
  });

  await waitFor(() => firstSynced && secondSynced);

  providerA.setAwarenessField("user", {
    userId: writerUser.id,
    displayName: writerUser.displayName,
    color: "#8b5cf6"
  });
  providerA.setAwarenessField("viewer", {
    workspaceId: roomId,
    entryId: markdownEntry.id,
    active: true
  });

  const firstPresence = await waitForSseEventMatching<{
    workspaceId: string;
    entryId: string;
    viewers: Array<{
      presenceId: string;
      userId: string;
      displayName: string;
      color: string | null;
      hasSelection: boolean;
    }>;
  }>(
    presenceStream,
    "note.presence.updated",
    (payload) => payload.entryId === markdownEntry.id && payload.viewers.length === 1
  );

  assert.equal(firstPresence.payload.workspaceId, roomId);
  const [firstViewer] = firstPresence.payload.viewers;
  assert.ok(firstViewer);
  assert.equal(firstViewer.userId, writerUser.id);
  assert.equal(firstViewer.displayName, writerUser.displayName);
  assert.equal(firstViewer.color, "#8b5cf6");
  assert.equal(firstViewer.hasSelection, false);
  const firstPresenceId = firstViewer.presenceId;

  providerB.setAwarenessField("user", {
    userId: writerUser.id,
    displayName: writerUser.displayName,
    color: "#22c55e"
  });
  providerB.setAwarenessField("viewer", {
    workspaceId: roomId,
    entryId: markdownEntry.id,
    active: true
  });

  const secondPresence = await waitForSseEventMatching<{
    entryId: string;
    viewers: Array<{
      presenceId: string;
      userId: string;
      displayName: string;
      color: string | null;
      hasSelection: boolean;
    }>;
  }>(
    presenceStream,
    "note.presence.updated",
    (payload) => payload.entryId === markdownEntry.id && payload.viewers.length === 2
  );

  assert.equal(secondPresence.payload.viewers.every((viewer) => viewer.userId === writerUser.id), true);
  assert.equal(
    new Set(secondPresence.payload.viewers.map((viewer) => viewer.presenceId)).size,
    2
  );
  assert.ok(
    secondPresence.payload.viewers.some((viewer) => viewer.presenceId === firstPresenceId)
  );
  assert.deepEqual(
    [...new Set(secondPresence.payload.viewers.map((viewer) => viewer.color))].sort(),
    ["#22c55e", "#8b5cf6"]
  );
  assert.equal(
    secondPresence.payload.viewers.every((viewer) => viewer.hasSelection === false),
    true
  );

  providerA.setAwarenessField("selection", {
    anchor: 4,
    head: 4
  });

  const selectedPresence = await waitForSseEventMatching<{
    entryId: string;
    viewers: Array<{
      presenceId: string;
      hasSelection: boolean;
    }>;
  }>(
    presenceStream,
    "note.presence.updated",
    (payload) =>
      payload.entryId === markdownEntry.id &&
      payload.viewers.some(
        (viewer) => viewer.presenceId === firstPresenceId && viewer.hasSelection === true
      )
  );

  assert.ok(
    selectedPresence.payload.viewers.some(
      (viewer) => viewer.presenceId === firstPresenceId && viewer.hasSelection
    )
  );

  providerA.destroy();

  const afterFirstDisconnect = await waitForSseEventMatching<{
    entryId: string;
    viewers: Array<{
      presenceId: string;
    }>;
  }>(
    presenceStream,
    "note.presence.updated",
    (payload) =>
      payload.entryId === markdownEntry.id &&
      payload.viewers.length === 1 &&
      payload.viewers.every((viewer) => viewer.presenceId !== firstPresenceId)
  );

  assert.equal(afterFirstDisconnect.payload.viewers.length, 1);

  providerB.destroy();

  const afterSecondDisconnect = await waitForSseEventMatching<{
    entryId: string;
    viewers: Array<unknown>;
  }>(
    presenceStream,
    "note.presence.updated",
    (payload) => payload.entryId === markdownEntry.id && payload.viewers.length === 0
  );

  assert.deepEqual(afterSecondDisconnect.payload.viewers, []);

  await presenceStream.reader.cancel();
  await app.close();
  await cleanupTestEnv(env);
});

test("markdown bootstrap endpoint returns current stored Yjs state for workspace markdown files", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "writer1",
    password: "secret",
    displayName: "Writer One",
    globalRole: "writer"
  });

  const writerSession = await loginAs(app, "writer1", "secret", "writer-laptop");
  const roomResponse = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      name: "Offline Bootstrap Notes"
    }
  });

  assert.equal(roomResponse.statusCode, 201);
  const roomId = roomResponse.json().workspace.id;

  const createEntriesResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/ops/batch`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      deviceId: "writer-device-1",
      operations: [
        {
          opId: "op_bootstrap_markdown_a",
          type: "create_markdown",
          path: "Week-01.md"
        },
        {
          opId: "op_bootstrap_markdown_b",
          type: "create_markdown",
          path: "Week-02.md"
        },
        {
          opId: "op_bootstrap_binary",
          type: "create_binary_placeholder",
          path: "attachments/diagram.png"
        }
      ]
    }
  });

  assert.equal(createEntriesResponse.statusCode, 200);
  const firstMarkdownEntry = createEntriesResponse.json().results[0].entry;
  const secondMarkdownEntry = createEntriesResponse.json().results[1].entry;
  const binaryEntry = createEntriesResponse.json().results[2].entry;

  const firstDoc = new Y.Doc();
  firstDoc.getText("content").insert(0, "123hello");
  await app.rolay.storage.storeDocument(firstMarkdownEntry.docId, Y.encodeStateAsUpdate(firstDoc));

  const bootstrapAllResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/markdown/bootstrap`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(bootstrapAllResponse.statusCode, 200);
  assert.equal(bootstrapAllResponse.json().workspaceId, roomId);
  assert.equal(bootstrapAllResponse.json().encoding, "base64");
  assert.equal(bootstrapAllResponse.json().includesState, true);
  assert.equal(bootstrapAllResponse.json().documentCount, 2);
  assert.equal(bootstrapAllResponse.json().documents.length, 2);

  const bootstrapAllDocuments = bootstrapAllResponse.json().documents;
  const bootstrappedFirst = bootstrapAllDocuments.find(
    (document: { entryId: string }) => document.entryId === firstMarkdownEntry.id
  );
  const bootstrappedSecond = bootstrapAllDocuments.find(
    (document: { entryId: string }) => document.entryId === secondMarkdownEntry.id
  );

  assert.ok(bootstrappedFirst);
  assert.ok(bootstrappedSecond);
  assert.equal(typeof bootstrappedFirst.stateBytes, "number");
  assert.equal(typeof bootstrappedFirst.encodedBytes, "number");
  assert.ok(bootstrappedFirst.stateBytes > 0);
  assert.ok(bootstrappedFirst.encodedBytes > 0);
  assert.ok(bootstrapAllResponse.json().totalStateBytes >= bootstrappedFirst.stateBytes);
  assert.ok(bootstrapAllResponse.json().totalEncodedBytes >= bootstrappedFirst.encodedBytes);
  assert.equal(
    decodeCrdtBootstrapState(bootstrappedFirst.state).getText("content").toString(),
    "123hello"
  );
  assert.equal(
    decodeCrdtBootstrapState(bootstrappedSecond.state).getText("content").toString(),
    ""
  );

  const bootstrapSubsetResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/markdown/bootstrap`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      entryIds: [secondMarkdownEntry.id, firstMarkdownEntry.id, firstMarkdownEntry.id]
    }
  });

  assert.equal(bootstrapSubsetResponse.statusCode, 200);
  assert.deepEqual(
    bootstrapSubsetResponse.json().documents.map((document: { entryId: string }) => document.entryId),
    [secondMarkdownEntry.id, firstMarkdownEntry.id]
  );
  assert.equal(bootstrapSubsetResponse.json().includesState, true);

  const bootstrapMetadataOnlyResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/markdown/bootstrap`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      includeState: false
    }
  });

  assert.equal(bootstrapMetadataOnlyResponse.statusCode, 200);
  assert.equal(bootstrapMetadataOnlyResponse.json().includesState, false);
  assert.equal(bootstrapMetadataOnlyResponse.json().documentCount, 2);
  assert.equal(bootstrapMetadataOnlyResponse.json().documents.length, 2);
  for (const document of bootstrapMetadataOnlyResponse.json().documents) {
    assert.equal(typeof document.stateBytes, "number");
    assert.equal(typeof document.encodedBytes, "number");
    assert.equal("state" in document, false);
  }

  const invalidBootstrapResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/markdown/bootstrap`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      entryIds: [binaryEntry.id]
    }
  });

  assert.equal(invalidBootstrapResponse.statusCode, 404);
  assert.equal(invalidBootstrapResponse.json().error.code, "entry_not_found");

  const invalidIncludeStateResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${roomId}/markdown/bootstrap`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    },
    payload: {
      includeState: "yes"
    }
  });

  assert.equal(invalidIncludeStateResponse.statusCode, 400);
  assert.equal(invalidIncludeStateResponse.json().error.code, "invalid_request");

  await app.close();
  await cleanupTestEnv(env);
});
