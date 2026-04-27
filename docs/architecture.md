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
- enough structure for a dedicated Obsidian plugin and small self-hosted group workflow
- operational simplicity over maximum generality

## High-Level Model

The server has five different synchronization layers:

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

4. Markdown note presence and read state
   - note presence is live and awareness-derived
   - note read state is persisted per account and driven by stored Markdown content versions

5. Excalidraw live sessions
   - single current editor per drawing
   - live scene snapshot broadcast to viewers
   - editor pointer presence
   - persistent `.excalidraw.md` file remains blob-backed storage/fallback

6. Public read-only publishing
   - room owner/admin controlled `public/private` switch
   - bundled dark web app served at `/`
   - unauthenticated public API scoped only to published rooms
   - read-only CRDT tokens for public Markdown viewing

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

The server uses seven transports:

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

4. Note presence SSE
   - `GET /v1/workspaces/{workspaceId}/note-presence/events`
   - used for room-wide live note viewer state aggregated from Markdown awareness
   - exposes awareness-derived `sessionId` for follow-mode joins back into document awareness

5. Note read-state SSE
   - `GET /v1/workspaces/{workspaceId}/note-read-state/events`
   - used for room-wide persisted unread/read state for Markdown notes

6. CRDT WebSocket
   - `/v1/crdt`
   - used only for live Markdown collaboration

7. Drawing WebSocket
   - `/v1/drawings`
   - used only for live Excalidraw single-editor sessions

8. Public HTTP surface
   - `/`
   - `/public/api/...`
   - used only for read-only room publication

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
- server also aggregates awareness into room-level note presence
- server also advances per-note read-state `contentVersion` when changed Markdown state is stored

### Non-Markdown files

Binary entries have:

- `kind = "binary"`
- `contentMode = "blob"`
- optional `blob` metadata with `hash`, `sizeBytes`, `mimeType`

Flow:

- client creates a binary placeholder in the tree
- client requests an upload ticket
- file is uploaded to server-side staging
- client can resume upload from the server-confirmed byte offset
- upload can be canceled before commit
- only after `commit_blob_revision` does the new file version become visible to everyone else

This keeps binary sync simple and avoids pretending that non-text files are CRDT-safe.

### Excalidraw drawings

Excalidraw entries have:

- `kind = "excalidraw"`
- `contentMode = "blob"`
- optional persistent `blob` revision for the serialized `.excalidraw.md` file

Live drawing collaboration is intentionally not multi-writer. The server keeps:

- one active editor lease per drawing
- at most one pending control request
- the latest accepted full scene snapshot
- the latest fresh editor pointer

Persistent file sync for the serialized drawing still uses the normal blob flow. Live scene state is
stored separately for reconnect/viewer hydration and does not parse or merge the `.excalidraw.md`
file on the server.

### Public read-only rooms

Room publication is stored on the room record as `publication.enabled` and
`publication.updatedAt`. It is private by default and can be changed only by room owners or admins.

The public web app deliberately uses a narrower contract than the authenticated plugin:

- room list includes only published rooms
- manifests include visible navigation entries for folders, Markdown notes, and Excalidraw files
- image files are exposed only through an `assets` map so Markdown embeds can resolve them without
  listing all binary files in the public tree
- public blob reads are limited to image binaries and Excalidraw blobs
- public Markdown CRDT sessions are read-only and reject non-empty public awareness so visitors do
  not appear as collaborators

Disabling publication invalidates public CRDT tokens and closes room Markdown connections. Private
plugin clients can reconnect with normal authenticated tokens.

## Why the Tree Is Server-Authoritative

The file tree is not a CRDT.

Reasons:

- rename and move semantics are easier to reason about
- Obsidian file handling maps more naturally to stable entry IDs plus canonical paths
- conflict handling is simpler and more explicit
- the implementation is easier to reason about and implement correctly in clients

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

There are three separate live stream systems.

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

### Note presence stream

Scope:

- one room
- live viewer state for Markdown notes only

Implemented in:

- `src/modules/note-presence/note-presence.routes.ts`
- `src/services/note-presence-service.ts`
- `src/services/realtime-service.ts`

Behavior:

- initial `presence.snapshot` on every new connection
- live `note.presence.updated` events after awareness changes
- no durable resume cursor
- duplicate presence records for the same user are allowed across devices/windows
- selection is optional; viewer-only awareness still counts as presence

## Large File Behavior

Large binary uploads now follow a stage-then-commit model.

Important properties:

- upload is streamed through the server
- upload can resume from the last confirmed byte offset
- download is streamed to clients
- download can resume through HTTP `Range`
- upload has explicit cancel support
- room members do not see a new blob revision until `commit_blob_revision`
- clients can show progress using:
  - upload ticket `uploadedBytes`
  - upload and download `sizeBytes`
  - HTTP `Content-Length`
  - HTTP `Content-Range`

This is safer than exposing partial binary content while an upload is still running.

## Scaling Boundaries

The current implementation is good for a small group and a single VPS, but it is still a single-process design.

Current constraints:

- one Node process
- one in-memory listener fanout for SSE
- one `Hocuspocus` instance
- no Redis or distributed pub/sub
- no background GC for orphaned blob payloads yet

That is acceptable for the current product scope, but it is not a large multi-node architecture yet.

