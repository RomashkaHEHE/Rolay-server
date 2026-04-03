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
): Promise<{ accessToken: string; refreshToken: string }> {
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
  const invite = {
    id: "inv_1",
    workspaceId: "ws_1",
    code: "INVITE123",
    role: "editor" as const,
    usedCount: 1
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
      slug: "notes",
      name: "Notes"
    },
    createdBy: user.id,
    createdAt: "2026-01-01T00:00:00.000Z",
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
    invites: new Map([[invite.id, invite]]),
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
  state.invitesByCode.set(invite.code, invite);
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

test("auth login and refresh issue opaque bearer tokens", async () => {
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
    isAdmin: true
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

test("workspace flow supports invites, tree ops, folder moves, and conflicts", async () => {
  const env = createTestEnv();
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "bob",
    password: "secret",
    displayName: "Bob"
  });

  const aliceSession = await loginAs(app, "alice", "secret", "alice-laptop");
  const bobSession = await loginAs(app, "bob", "secret", "bob-laptop");

  const workspaceResponse = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: {
      authorization: `Bearer ${aliceSession.accessToken}`
    },
    payload: {
      name: "Calculus Notes"
    }
  });

  assert.equal(workspaceResponse.statusCode, 201);
  const workspace = workspaceResponse.json().workspace;
  assert.equal(workspace.name, "Calculus Notes");
  assert.equal(workspace.slug, "calculus-notes");

  const inviteResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspace.id}/invites`,
    headers: {
      authorization: `Bearer ${aliceSession.accessToken}`
    },
    payload: {
      role: "editor",
      maxUses: 1
    }
  });

  assert.equal(inviteResponse.statusCode, 201);
  const invite = inviteResponse.json().invite;
  assert.equal(invite.role, "editor");

  const acceptResponse = await app.inject({
    method: "POST",
    url: "/v1/invites/accept",
    headers: {
      authorization: `Bearer ${bobSession.accessToken}`
    },
    payload: {
      code: invite.code
    }
  });

  assert.equal(acceptResponse.statusCode, 200);
  assert.equal(acceptResponse.json().workspace.id, workspace.id);

  const createBatch = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspace.id}/ops/batch`,
    headers: {
      authorization: `Bearer ${aliceSession.accessToken}`
    },
    payload: {
      deviceId: "alice-device-1",
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
  assert.equal(createdResults.length, 2);
  assert.equal(createdResults[0].status, "applied");
  assert.equal(createdResults[1].entry.path, "Math/Week-01.md");
  assert.match(createdResults[1].entry.docId, /^doc_/);

  const snapshotResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${workspace.id}/tree`,
    headers: {
      authorization: `Bearer ${bobSession.accessToken}`
    }
  });

  assert.equal(snapshotResponse.statusCode, 200);
  assert.equal(snapshotResponse.json().entries.length, 2);

  const entries = snapshotResponse.json().entries;
  const folderEntry = entries.find((entry: { kind: string }) => entry.kind === "folder");
  const markdownEntry = entries.find(
    (entry: { kind: string }) => entry.kind === "markdown"
  );
  assert.ok(folderEntry);
  assert.ok(markdownEntry);
  assert.equal(folderEntry.path, "Math");
  assert.equal(markdownEntry.path, "Math/Week-01.md");

  const moveFolderResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspace.id}/ops/batch`,
    headers: {
      authorization: `Bearer ${aliceSession.accessToken}`
    },
    payload: {
      deviceId: "alice-device-1",
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

  const movedSnapshot = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${workspace.id}/tree`,
    headers: {
      authorization: `Bearer ${bobSession.accessToken}`
    }
  });

  assert.equal(movedSnapshot.statusCode, 200);
  assert.deepEqual(
    movedSnapshot
      .json()
      .entries.map((entry: { path: string }) => entry.path)
      .sort(),
    ["Lectures", "Lectures/Week-01.md"]
  );

  const conflictResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspace.id}/ops/batch`,
    headers: {
      authorization: `Bearer ${aliceSession.accessToken}`
    },
    payload: {
      deviceId: "alice-device-2",
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

test("admin can create managed users and users can update their display name", async () => {
  const env = createTestEnv({
    devAuthUsername: "admin",
    devAuthPassword: "secret",
    devAuthDisplayName: "Admin User"
  });
  const app = await buildApp({
    logger: false,
    env
  });

  const adminSession = await loginAs(app, "admin", "secret", "admin-laptop");

  const createUserResponse = await app.inject({
    method: "POST",
    url: "/v1/admin/users",
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    },
    payload: {
      username: "student1",
      password: "student-secret"
    }
  });

  assert.equal(createUserResponse.statusCode, 201);
  assert.deepEqual(createUserResponse.json().user, {
    id: createUserResponse.json().user.id,
    username: "student1",
    displayName: "student1",
    isAdmin: false
  });

  const studentSession = await loginAs(app, "student1", "student-secret", "student-laptop");
  assert.equal(studentSession.accessToken.length > 0, true);

  const meResponse = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: {
      authorization: `Bearer ${studentSession.accessToken}`
    }
  });

  assert.equal(meResponse.statusCode, 200);
  assert.deepEqual(meResponse.json().user, {
    id: meResponse.json().user.id,
    username: "student1",
    displayName: "student1",
    isAdmin: false
  });

  const updateProfileResponse = await app.inject({
    method: "PATCH",
    url: "/v1/auth/me/profile",
    headers: {
      authorization: `Bearer ${studentSession.accessToken}`
    },
    payload: {
      displayName: "Student One"
    }
  });

  assert.equal(updateProfileResponse.statusCode, 200);
  assert.deepEqual(updateProfileResponse.json().user, {
    id: updateProfileResponse.json().user.id,
    username: "student1",
    displayName: "Student One",
    isAdmin: false
  });

  const duplicateUserResponse = await app.inject({
    method: "POST",
    url: "/v1/admin/users",
    headers: {
      authorization: `Bearer ${adminSession.accessToken}`
    },
    payload: {
      username: "student1",
      password: "another-secret"
    }
  });

  assert.equal(duplicateUserResponse.statusCode, 409);
  assert.equal(duplicateUserResponse.json().error.code, "username_taken");

  const nonAdminCreateResponse = await app.inject({
    method: "POST",
    url: "/v1/admin/users",
    headers: {
      authorization: `Bearer ${studentSession.accessToken}`
    },
    payload: {
      username: "student2",
      password: "student-secret"
    }
  });

  assert.equal(nonAdminCreateResponse.statusCode, 403);

  await app.close();
  await cleanupTestEnv(env);
});

test("file endpoints issue CRDT tokens, enforce upload roles, and return blob tickets", async () => {
  const env = createTestEnv({
    devAuthUsername: "owner",
    devAuthPassword: "secret",
    devAuthDisplayName: "Owner"
  });
  const app = await buildApp({
    logger: false,
    env
  });

  await app.rolay.auth.upsertUser({
    username: "viewer",
    password: "secret",
    displayName: "Viewer"
  });

  const ownerSession = await loginAs(app, "owner", "secret", "owner-laptop");
  const viewerSession = await loginAs(app, "viewer", "secret", "viewer-laptop");

  const workspaceResponse = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: {
      authorization: `Bearer ${ownerSession.accessToken}`
    },
    payload: {
      name: "Physics Notes"
    }
  });

  assert.equal(workspaceResponse.statusCode, 201);
  const workspace = workspaceResponse.json().workspace;

  const inviteResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspace.id}/invites`,
    headers: {
      authorization: `Bearer ${ownerSession.accessToken}`
    },
    payload: {
      role: "viewer"
    }
  });

  assert.equal(inviteResponse.statusCode, 201);

  const acceptResponse = await app.inject({
    method: "POST",
    url: "/v1/invites/accept",
    headers: {
      authorization: `Bearer ${viewerSession.accessToken}`
    },
    payload: {
      code: inviteResponse.json().invite.code
    }
  });

  assert.equal(acceptResponse.statusCode, 200);

  const createEntriesResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspace.id}/ops/batch`,
    headers: {
      authorization: `Bearer ${ownerSession.accessToken}`
    },
    payload: {
      deviceId: "owner-device-1",
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
      authorization: `Bearer ${viewerSession.accessToken}`
    }
  });

  assert.equal(crdtTokenResponse.statusCode, 200);
  assert.equal(crdtTokenResponse.json().entryId, markdownEntry.id);
  assert.equal(crdtTokenResponse.json().docId, markdownEntry.docId);
  assert.equal(crdtTokenResponse.json().provider, "yjs-hocuspocus");
  assert.equal(crdtTokenResponse.json().wsUrl, "ws://localhost:3000/v1/crdt");
  assert.match(crdtTokenResponse.json().token, /^[A-Za-z0-9_-]{20,}$/);

  const viewerUploadAttempt = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/upload-ticket`,
    headers: {
      authorization: `Bearer ${viewerSession.accessToken}`
    },
    payload: {
      hash: "sha256:invalid",
      sizeBytes: 48213,
      mimeType: "image/png"
    }
  });

  assert.equal(viewerUploadAttempt.statusCode, 403);

  const binaryPayload = Buffer.from("diagram-binary-v1", "utf8");
  const binaryHash = createSha256Hash(binaryPayload);

  const ownerUploadTicket = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/upload-ticket`,
    headers: {
      authorization: `Bearer ${ownerSession.accessToken}`
    },
    payload: {
      hash: binaryHash,
      sizeBytes: binaryPayload.byteLength,
      mimeType: "image/png"
    }
  });

  assert.equal(ownerUploadTicket.statusCode, 200);
  assert.equal(ownerUploadTicket.json().alreadyExists, false);
  assert.equal(ownerUploadTicket.json().upload.method, "PUT");
  assert.match(
    ownerUploadTicket.json().upload.url,
    /http:\/\/localhost:3000\/_storage\/upload\//
  );

  const uploadPath = new URL(ownerUploadTicket.json().upload.url).pathname;
  const uploadResponse = await app.inject({
    method: "PUT",
    url: uploadPath,
    headers: {
      "content-type": "image/png"
    },
    payload: binaryPayload
  });

  assert.equal(uploadResponse.statusCode, 201);
  assert.equal(uploadResponse.json().hash, binaryHash);

  const commitBlobResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspace.id}/ops/batch`,
    headers: {
      authorization: `Bearer ${ownerSession.accessToken}`
    },
    payload: {
      deviceId: "owner-device-1",
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

  const dedupedUploadResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/upload-ticket`,
    headers: {
      authorization: `Bearer ${ownerSession.accessToken}`
    },
    payload: {
      hash: binaryHash,
      sizeBytes: binaryPayload.byteLength,
      mimeType: "image/png"
    }
  });

  assert.equal(dedupedUploadResponse.statusCode, 200);
  assert.equal(dedupedUploadResponse.json().alreadyExists, true);
  assert.equal(dedupedUploadResponse.json().upload, undefined);

  const downloadTicketResponse = await app.inject({
    method: "POST",
    url: `/v1/files/${binaryEntry.id}/blob/download-ticket`,
    headers: {
      authorization: `Bearer ${viewerSession.accessToken}`
    }
  });

  assert.equal(downloadTicketResponse.statusCode, 200);
  assert.equal(downloadTicketResponse.json().hash, binaryHash);
  assert.match(
    downloadTicketResponse.json().url,
    /http:\/\/localhost:3000\/_storage\/download\//
  );

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

  const ownerSession = await loginAs(app, "alice", "secret", "alice-laptop");
  const workspaceResponse = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: {
      authorization: `Bearer ${ownerSession.accessToken}`
    },
    payload: {
      name: "Realtime Notes"
    }
  });

  assert.equal(workspaceResponse.statusCode, 201);
  const workspace = workspaceResponse.json().workspace;

  const createEntryResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspace.id}/ops/batch`,
    headers: {
      authorization: `Bearer ${ownerSession.accessToken}`
    },
    payload: {
      deviceId: "alice-device-1",
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
      authorization: `Bearer ${ownerSession.accessToken}`
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
      authorization: `Bearer ${ownerSession.accessToken}`
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
