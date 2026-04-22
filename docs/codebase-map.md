# Codebase Map

This document is for new engineers or agents entering the repository without chat history.
It tells you where to look first for each feature.

## Start Here

Recommended reading order:

1. `AGENT_ENTRYPOINT.md`
2. `README.md`
3. `docs/architecture.md`
4. `docs/protocol.md`
5. `openapi.yaml`
6. `src/app.ts`
7. route modules in `src/modules`
8. service modules in `src/services`
9. `test/app.test.ts`

## Top-Level Runtime Entry Points

- `src/index.ts`
  - process entrypoint
- `src/app.ts`
  - Fastify construction
  - route registration
  - realtime service attachment
- `src/core/context.ts`
  - builds the shared app context and services

## Configuration

- `src/config/env.ts`
  - all env parsing
  - transport URLs
  - storage driver selection
  - blob ticket TTL

## Core Helpers

- `src/core/errors.ts`
  - application error type and API error payload shape
- `src/core/http-auth.ts`
  - bearer auth extraction
- `src/core/passwords.ts`
  - password hashing and verification
- `src/core/hashes.ts`
  - canonical SHA-256 parsing and normalization
  - legacy blob-key compatibility helpers
- `src/core/paths.ts`
  - path normalization and conflict path suggestions
- `src/core/ids.ts`
  - IDs and invite code generation

## Domain Types

- `src/domain/types.ts`
  - user roles
  - room roles
  - file entry model
  - settings SSE events
  - room event model
  - ticket records

This file is the fastest way to see the server's core vocabulary.

## Route Modules

Each route module is intentionally thin. If you need actual behavior, jump from routes into the matching service.

- `src/modules/auth/auth.routes.ts`
  - login
  - refresh
  - current user
  - display name update
  - password change

- `src/modules/admin/admin.routes.ts`
  - admin user list/create/delete
  - admin room list/delete
  - admin room members list/add

- `src/modules/workspaces/workspaces.routes.ts`
  - room list
  - room creation
  - participant room members list
  - both `/v1/workspaces` and `/v1/rooms` aliases

- `src/modules/note-presence/note-presence.routes.ts`
  - room note-presence SSE stream
  - initial snapshot plus live per-note presence updates

- `src/modules/note-read-state/note-read-state.routes.ts`
  - room note read-state SSE stream
  - markdown note mark-read mutation

- `src/modules/invites/invites.routes.ts`
  - join room by invite code
  - get/toggle/regenerate invite

- `src/modules/tree/tree.routes.ts`
  - room tree snapshot
  - batch tree mutations
  - room SSE event stream

- `src/modules/drawings/drawings.routes.ts`
  - Excalidraw lease acquire/release
  - control request approve/deny

- `src/modules/files/files.routes.ts`
  - markdown bootstrap
  - CRDT token
  - drawing token
  - blob upload ticket
  - authenticated ranged blob content download
  - authenticated blob content upload
  - blob download ticket
  - cancel blob upload

- `src/modules/settings-events/settings-events.routes.ts`
  - settings/admin SSE stream

- `src/modules/storage/storage.routes.ts`
  - internal upload and download handlers behind blob tickets

## Service Modules

Most business logic lives here.

- `src/services/auth-service.ts`
  - seeded admin
  - user lifecycle
  - session creation and rotation
  - password changes
  - session invalidation

- `src/services/workspace-service.ts`
  - room membership and invite logic
  - tree snapshot
  - batch ops
  - tree conflict handling
  - room SSE event publication

- `src/services/file-service.ts`
  - markdown bootstrap
  - CRDT token issuance
  - resumable blob upload ticket issuance
  - authenticated ranged blob reads
  - cancel upload API behavior

- `src/services/realtime-service.ts`
  - `Hocuspocus` integration
  - Markdown-only websocket auth
  - load/store of Yjs document state
  - awareness hook feeding note presence aggregation

- `src/services/note-presence-service.ts`
  - room-level live note presence aggregation
  - viewer snapshot/update fanout
  - duplicate-presence handling for multi-device users
  - forwards awareness `sessionId` into room-level presence viewers for follow mode

- `src/services/note-read-state-service.ts`
  - per-account Markdown unread/read-state snapshots
  - note `contentVersion` tracking
  - mark-read mutation behavior
  - live per-account update fanout

- `src/services/drawing-service.ts`
  - Excalidraw drawing tokens
  - single-editor lease state
  - control requests
  - live scene snapshot broadcast
  - editor pointer broadcast
  - snapshot persistence for reconnects

- `src/services/settings-events-service.ts`
  - settings/admin SSE event publication and visibility filtering

- `src/services/storage-service.ts`
  - local or MinIO-backed object/document persistence
  - staged resumable blob uploads
  - ranged blob downloads
  - active upload cancellation

- `src/services/state-store.ts`
  - memory/postgres snapshot state persistence

- `src/services/memory-state.ts`
  - in-memory canonical state
  - snapshot serialization/deserialization
  - listener registries

## Three Different Live Streams

This matters a lot.

### Room SSE

- implementation: `src/modules/tree/tree.routes.ts`
- state source: `src/services/workspace-service.ts`
- scope: one room
- payloads: tree/file events

### Settings SSE

- implementation: `src/modules/settings-events/settings-events.routes.ts`
- state source: `src/services/settings-events-service.ts`
- scope: current user settings and admin screens
- payloads: profile/room/admin snapshots

### Note Presence SSE

- implementation: `src/modules/note-presence/note-presence.routes.ts`
- state source: `src/services/note-presence-service.ts`
- upstream source of truth: Markdown awareness from `src/services/realtime-service.ts`
- scope: one room
- payloads: `presence.snapshot`, `note.presence.updated`

### Note Read-State SSE

- implementation: `src/modules/note-read-state/note-read-state.routes.ts`
- state source: `src/services/note-read-state-service.ts`
- upstream source of truth: persisted Markdown state transitions from `src/services/realtime-service.ts`
- scope: one room, per subscribed account
- payloads: `read-state.snapshot`, `note.read-state.updated`

Do not confuse them.

## Markdown Vs Binary

This is another critical split.

### Markdown

- route: `POST /v1/files/{entryId}/crdt-token`
- runtime: `src/services/realtime-service.ts`
- bootstrap: `POST /v1/workspaces/{workspaceId}/markdown/bootstrap`

### Binary

- route: `POST /v1/files/{entryId}/blob/upload-ticket`
- route: `GET /v1/files/{entryId}/blob/content`
- route: `PUT /v1/files/{entryId}/blob/uploads/{uploadId}/content`
- route: `DELETE /v1/files/{entryId}/blob/uploads/{uploadId}`
- route: `POST /v1/files/{entryId}/blob/download-ticket`
- storage implementation: `src/services/storage-service.ts`
- tree publish point: `commit_blob_revision` in `src/services/workspace-service.ts`

### Excalidraw

- tree op: `create_excalidraw`
- route: `POST /v1/files/{entryId}/drawing-token`
- routes: `POST /v1/drawings/{entryId}/...`
- runtime: `src/services/drawing-service.ts`
- persistent serialized file: blob flow
- live scene state: drawing websocket + stored reconnect snapshot

## Tests

- `test/app.test.ts`

This file is long, but it is the best executable overview of what the server currently supports:

- auth and password change
- roles and room creation
- admin flows
- settings SSE
- room tree ops
- blob upload/download
- upload cancellation
- CRDT websocket sync
- note presence SSE
- note read-state SSE
- markdown bootstrap

If you are unsure whether a behavior is intentional, search this file first.
