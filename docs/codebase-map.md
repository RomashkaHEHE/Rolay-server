# Codebase Map

This document is for new engineers or agents entering the repository without chat history.
It tells you where to look first for each feature.

## Start Here

Recommended reading order:

1. `README.md`
2. `docs/architecture.md`
3. `docs/protocol.md`
4. `openapi.yaml`
5. `src/app.ts`
6. route modules in `src/modules`
7. service modules in `src/services`
8. `test/app.test.ts`

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
  - both `/v1/workspaces` and `/v1/rooms` aliases

- `src/modules/invites/invites.routes.ts`
  - join room by invite code
  - get/toggle/regenerate invite

- `src/modules/tree/tree.routes.ts`
  - room tree snapshot
  - batch tree mutations
  - room SSE event stream

- `src/modules/files/files.routes.ts`
  - markdown bootstrap
  - CRDT token
  - blob upload ticket
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
  - blob ticket issuance
  - cancel upload API behavior

- `src/services/realtime-service.ts`
  - `Hocuspocus` integration
  - Markdown-only websocket auth
  - load/store of Yjs document state

- `src/services/settings-events-service.ts`
  - settings/admin SSE event publication and visibility filtering

- `src/services/storage-service.ts`
  - local or MinIO-backed object/document persistence
  - staged streaming blob uploads
  - streaming blob downloads
  - active upload cancellation

- `src/services/state-store.ts`
  - memory/postgres snapshot state persistence

- `src/services/memory-state.ts`
  - in-memory canonical state
  - snapshot serialization/deserialization
  - listener registries

## Two Different SSE Systems

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

Do not confuse them.

## Markdown Vs Binary

This is another critical split.

### Markdown

- route: `POST /v1/files/{entryId}/crdt-token`
- runtime: `src/services/realtime-service.ts`
- bootstrap: `POST /v1/workspaces/{workspaceId}/markdown/bootstrap`

### Binary

- route: `POST /v1/files/{entryId}/blob/upload-ticket`
- route: `PUT /v1/files/{entryId}/blob/uploads/{uploadId}/content`
- route: `DELETE /v1/files/{entryId}/blob/uploads/{uploadId}`
- route: `POST /v1/files/{entryId}/blob/download-ticket`
- storage implementation: `src/services/storage-service.ts`
- tree publish point: `commit_blob_revision` in `src/services/workspace-service.ts`

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
- markdown bootstrap

If you are unsure whether a behavior is intentional, search this file first.
