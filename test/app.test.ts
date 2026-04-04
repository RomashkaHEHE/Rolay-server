import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

import { buildApp } from "../src/app";
import { AppEnv } from "../src/config/env";
import { MemoryState } from "../src/services/memory-state";
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
  const uploadPath = new URL(memberUploadTicket.json().upload.url).pathname;

  const uploadResponse = await app.inject({
    method: "PUT",
    url: uploadPath,
    headers: {
      "content-type": "image/png"
    },
    payload: binaryPayload
  });

  assert.equal(uploadResponse.statusCode, 201);

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

  const downloadTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/download-ticket`,
    headers: {
      authorization: `Bearer ${writerSession.accessToken}`
    }
  });

  assert.equal(downloadTicketResponse.statusCode, 200);
  const downloadPath = new URL(downloadTicketResponse.json().url).pathname;
  const downloadResponse = await app.inject({
    method: "GET",
    url: downloadPath
  });

  assert.equal(downloadResponse.statusCode, 200);
  assert.equal(downloadResponse.headers["content-type"], "image/png");
  assert.equal(downloadResponse.body, binaryPayload.toString("utf8"));

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

  await app.close();
  await cleanupTestEnv(env);
});
