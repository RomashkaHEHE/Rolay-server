# Current State

Last updated: `2026-04-27`

## Baseline

Rolay Server is single-process collaboration backend for self-hosted Obsidian group.

Current core stack:

- Fastify HTTP API
- `Yjs` + `Hocuspocus` for Markdown realtime
- server-authoritative room tree
- blob-based sync for non-Markdown files
- single-editor live Excalidraw sessions
- state persistence via in-memory or PostgreSQL snapshot store
- object/document storage via local disk or MinIO-compatible backend

## Current Priorities

1. Preserve compatibility with existing plugin builds while protocol evolves.
2. Keep sync layers clearly separated and predictable.
3. Keep Excalidraw contract aligned with plugin without leaking drawing rules into Markdown or
   generic blob behavior.
4. Maintain data safety over convenience, especially for Markdown merge behavior and blob
   publication.

## Stable Invariants

- `room` is product term; `workspaceId` is still stable API identifier.
- Only Markdown notes use CRDT.
- File tree is server-authoritative, not CRDT-based.
- Binary and Excalidraw file revisions become visible to other users only after
  `commit_blob_revision`.
- Room tree SSE, settings SSE, note presence SSE, and drawing websocket are separate systems with
  different purposes.
- Excalidraw live mode is single-editor only in `v1`.
- Excalidraw classification is driven by entry kind and client intent, not by filename suffix.
- Backward compatibility matters: do not turn previously optional client data into required runtime
  input without fallback or migration plan.
- `sha256` digests are normalized to canonical base64 form in persisted state and API responses.

## Active Tasks

- [tasks/legacy-client-compatibility.md](tasks/legacy-client-compatibility.md)
  - cross-cutting guardrail task for older plugin builds and protocol evolution
- [tasks/excalidraw-client-alignment.md](tasks/excalidraw-client-alignment.md)
  - Excalidraw single-editor/live contract and plugin alignment memory

If you start another substantial feature, create new task file before leaving unfinished work.

## Recently Completed Changes

- Added resumable authenticated blob upload/download flows with progress metadata and cancel
  support.
- Added room-level Markdown note presence SSE.
- Added live Excalidraw support with single-editor lease semantics and reconnect snapshot storage.
- Added blob-only Excalidraw fallback coverage so live drawing channel stays optional.
- Relaxed Excalidraw path constraints: `create_excalidraw` no longer requires
  `*.excalidraw.md`, and rename/move no longer downgrade `kind="excalidraw"`.

## Where To Look First

For room, invite, membership, or tree behavior:

- [src/modules/workspaces/workspaces.routes.ts](../src/modules/workspaces/workspaces.routes.ts)
- [src/modules/invites/invites.routes.ts](../src/modules/invites/invites.routes.ts)
- [src/modules/tree/tree.routes.ts](../src/modules/tree/tree.routes.ts)
- [src/services/workspace-service.ts](../src/services/workspace-service.ts)

For Markdown realtime and note presence:

- [src/services/realtime-service.ts](../src/services/realtime-service.ts)
- [src/services/note-presence-service.ts](../src/services/note-presence-service.ts)

For binary transfer behavior:

- [src/modules/files/files.routes.ts](../src/modules/files/files.routes.ts)
- [src/modules/storage/storage.routes.ts](../src/modules/storage/storage.routes.ts)
- [src/services/file-service.ts](../src/services/file-service.ts)
- [src/services/storage-service.ts](../src/services/storage-service.ts)

For Excalidraw:

- [src/modules/drawings/drawings.routes.ts](../src/modules/drawings/drawings.routes.ts)
- [src/services/drawing-service.ts](../src/services/drawing-service.ts)
- [src/services/workspace-service.ts](../src/services/workspace-service.ts)
- [test/app.test.ts](../test/app.test.ts)

For canonical protocol details:

- [openapi.yaml](../openapi.yaml)
- [docs/protocol.md](../docs/protocol.md)

## Immediate Watchouts

- Old plugin builds may still rely on legacy blob ticket behavior and older Excalidraw assumptions.
- `docs/*` should stay factual; unfinished reasoning belongs in `AGENTS/`.
- If you touch client-facing protocol behavior, update:
  - task file if work is ongoing
  - `current-state.md` if priorities or invariants changed
  - `openapi.yaml` and `docs/protocol.md` if wire contract changed
