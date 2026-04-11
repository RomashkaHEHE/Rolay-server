# Rolay Server Architecture

This document describes the current server architecture as it exists in this repository.
If this file and the code ever disagree, trust:

1. `openapi.yaml`
2. route modules in `src/modules`
3. service implementations in `src/services`

## Goals

Rolay is designed for a small self-hosted collaboration group using Obsidian.
The current server optimizes for:

- reliable realtime editing for Markdown notes
- predictable tree/file sync
- simple room and invite management
- enough structure for an Obsidian plugin to be implemented without chat history
- operational simplicity over maximum generality

## High-Level Model

The server has three different synchronization layers:

1. Room and user management
   - authentication
   - global roles
   - room membership
   - invites
   - settings/admin live updates

2. Workspace tree sync
   - canonical file/folder tree per room
   - server-authoritative
   - changes exposed through REST batch ops and room SSE

3. File content sync
   - Markdown: realtime `Yjs` / `Hocuspocus`
   - non-Markdown files: blob-based whole-file sync

These layers are intentionally separate. Only Markdown content uses CRDT.

## Roles

There are two role systems.

### Global roles

- `admin`
- `writer`
- `reader`

Behavior:

- `admin` can manage users and rooms
- `writer` can create rooms
- `reader` cannot create rooms and can only join existing rooms

### Room roles

- `owner`
- `member`

Behavior:

- `owner` can manage the room invite
- `member` can participate in the room but cannot manage invite state

## Primary Transport Layers

The server uses four transports:

1. REST JSON
   - auth
   - rooms
   - admin
   - tree snapshot
   - tree mutations
   - markdown bootstrap
   - blob tickets

2. Room SSE
   - `GET /v1/workspaces/{workspaceId}/events`
   - used for tree/file events inside one room

3. Settings SSE
   - `GET /v1/events/settings`
   - used for profile, room list, admin list, invite, and membership updates

4. CRDT WebSocket
   - `/v1/crdt`
   - used only for live Markdown collaboration

## File Sync Design

### Markdown files

Markdown entries have:

- `kind = "markdown"`
- `contentMode = "crdt"`
- `docId`

Flow:

- client requests `crdt-token`
- client connects to `Hocuspocus`
- server loads/stores the `Yjs` document from persistent storage

### Non-Markdown files

Binary entries have:

- `kind = "binary"`
- `contentMode = "blob"`
- optional `blob` metadata with `hash`, `sizeBytes`, `mimeType`

Flow:

- client creates a binary placeholder in the tree
- client requests an upload ticket
- file is uploaded to server-side staging
- upload can be canceled before commit
- only after `commit_blob_revision` does the new file version become visible to everyone else

This keeps binary sync simple and avoids pretending that non-text files are CRDT-safe.

## Why the Tree Is Server-Authoritative

The file tree is not a CRDT.

Reasons:

- rename and move semantics are easier to reason about
- Obsidian file handling maps more naturally to stable entry IDs plus canonical paths
- conflict handling is simpler and more explicit
- the implementation is easier for plugin agents to understand

The room tree is synchronized as:

- snapshot via `GET /tree`
- ordered event stream via room SSE
- mutation via `POST /ops/batch`

## Persistence Model

There are two persistence axes.

### State store

Configured by `STATE_DRIVER`:

- `memory`
- `postgres`

Current implementation:

- server state is serialized as a snapshot
- when using `postgres`, a single snapshot row is persisted

This is simple but not yet a normalized relational model.

### Object/document storage

Configured by `STORAGE_DRIVER`:

- `local`
- `minio`

Stored objects:

- Yjs document state
- blob payloads
- blob metadata

## Event Systems

There are two separate SSE systems.

### Room event stream

Scope:

- one room
- file tree and file revision events

Implemented in:

- `src/modules/tree/tree.routes.ts`
- `src/services/workspace-service.ts`

Typical events:

- `tree.entry.created`
- `tree.entry.updated`
- `tree.entry.deleted`
- `tree.entry.restored`
- `blob.revision.committed`

### Settings event stream

Scope:

- current user settings and room list
- admin management data

Implemented in:

- `src/modules/settings-events/settings-events.routes.ts`
- `src/services/settings-events-service.ts`

Typical events:

- `auth.me.updated`
- `room.created`
- `room.updated`
- `room.deleted`
- `room.members.updated`
- `room.membership.changed`
- `room.invite.updated`
- `admin.user.created`
- `admin.user.updated`
- `admin.user.deleted`
- `admin.room.members.updated`

## Large File Behavior

Large binary uploads now follow a stage-then-commit model.

Important properties:

- upload is streamed through the server
- download is streamed to clients
- upload has explicit cancel support
- room members do not see a new blob revision until `commit_blob_revision`
- clients can show progress using:
  - upload ticket metadata
  - download ticket metadata
  - HTTP `Content-Length`

This is safer than exposing partial binary content while an upload is still running.

## Scaling Boundaries

The current implementation is good for a small group and a single VPS, but it is still a single-process design.

Current constraints:

- one Node process
- one in-memory listener fanout for SSE
- one `Hocuspocus` instance
- no Redis or distributed pub/sub
- no resumable chunked uploads yet
- no background GC for orphaned blob payloads yet

That is acceptable for the current product scope, but it is not a large multi-node architecture yet.

## Recommended Reading Order For A New Agent

1. `README.md`
2. `docs/codebase-map.md`
3. `openapi.yaml`
4. route modules under `src/modules`
5. service modules under `src/services`
6. `test/app.test.ts`
