# Agent Entrypoint

This file is the fastest way for a new agent to orient in the repository without chat history.

## What This Server Does

Rolay Server is a self-hosted collaboration backend for Obsidian.

It has three main domains:

1. room and user management
2. server-authoritative file tree sync
3. file content sync

Content sync is intentionally split:

- Markdown uses `Yjs` / `Hocuspocus`
- everything else uses blob-based whole-file sync

## Read In This Order

1. `README.md`
2. `docs/codebase-map.md`
3. `docs/architecture.md`
4. `docs/protocol.md`
5. `openapi.yaml`
6. `src/app.ts`
7. the route module related to your feature
8. the matching service module
9. `test/app.test.ts`

If docs and code disagree, trust:

1. `openapi.yaml`
2. route modules
3. service implementations

## Critical Concepts

### Two room names for one thing

- product/UI concept: `room`
- stable API identifier: `workspaceId`

This is legacy naming. It is normal in this repository.

### Four room sync streams

- `/v1/workspaces/{workspaceId}/events`
  - room-local tree and file events
- `/v1/workspaces/{workspaceId}/note-presence/events`
  - room-local live note presence aggregated from markdown awareness
  - includes awareness-derived `sessionId` for follow-mode joins
- `/v1/workspaces/{workspaceId}/note-read-state/events`
  - room-local persisted unread/read state for markdown notes
- `/v1/events/settings`
  - profile, room list, invite state, members list, admin UI

Do not mix them.

### Two file sync models

- Markdown:
  - `crdt-token`
  - websocket `/v1/crdt`
  - optional bootstrap via `/v1/workspaces/{workspaceId}/markdown/bootstrap`
- Binary:
  - upload ticket
  - resumable upload by byte offset
  - authenticated upload content endpoint
  - authenticated ranged download endpoint
  - `commit_blob_revision`
  - download ticket

### Roles

Global roles:

- `admin`
- `writer`
- `reader`

Room roles:

- `owner`
- `member`

## Where To Look

If you change:

- auth/users:
  - `src/modules/auth/auth.routes.ts`
  - `src/services/auth-service.ts`
- rooms/invites/members:
  - `src/modules/workspaces/workspaces.routes.ts`
  - `src/modules/invites/invites.routes.ts`
  - `src/services/workspace-service.ts`
  - `src/services/settings-events-service.ts`
- note presence:
  - `src/modules/note-presence/note-presence.routes.ts`
  - `src/services/note-presence-service.ts`
  - `src/services/realtime-service.ts`
- note read state:
  - `src/modules/note-read-state/note-read-state.routes.ts`
  - `src/services/note-read-state-service.ts`
  - `src/services/realtime-service.ts`
- tree sync:
  - `src/modules/tree/tree.routes.ts`
  - `src/services/workspace-service.ts`
- Markdown realtime:
  - `src/modules/files/files.routes.ts`
  - `src/services/file-service.ts`
  - `src/services/realtime-service.ts`
- binary uploads/downloads:
  - `src/modules/files/files.routes.ts`
  - `src/modules/storage/storage.routes.ts`
  - `src/services/file-service.ts`
  - `src/services/storage-service.ts`
  - `src/core/hashes.ts`

## Practical Rules

- route modules should stay thin
- business logic should live in services
- prefer stable IDs over names
- only Markdown is CRDT
- binary payloads are invisible to other users until `commit_blob_revision`
- server normalizes accepted `sha256` digests to canonical base64 form

## Best Executable Reference

If you need to know whether behavior is intentional, read:

- `test/app.test.ts`

It covers the current supported flows better than chat history ever will.
