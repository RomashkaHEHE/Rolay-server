# Current State

Last updated: `2026-04-27`

## Baseline

Rolay Server is a single-process collaboration backend for a self-hosted Obsidian group.

Current core stack:

- Fastify HTTP API
- `Yjs` + `Hocuspocus` for Markdown realtime
- server-authoritative room tree
- blob-based sync for non-Markdown files
- single-editor live Excalidraw sessions
- public read-only room publishing and bundled web viewer
- state persistence via in-memory or PostgreSQL snapshot store
- object/document storage via local disk or MinIO-compatible backend

## Current Priorities

1. Preserve compatibility with existing plugin builds while protocol evolves.
2. Keep the synchronization layers clearly separated and predictable.
3. Maintain data safety over convenience, especially for Markdown merge behavior and binary upload
   publication.
4. Keep the bundled public read-only site deployable from the same Docker image as the API server.

## Stable Invariants

- `room` is the product term; `workspaceId` is still the stable API identifier.
- Only Markdown notes use CRDT.
- The file tree is server-authoritative, not CRDT-based.
- Binary and Excalidraw file revisions become visible to other users only after
  `commit_blob_revision`.
- Rooms are private by default; public read-only publication must stay explicitly opt-in.
- Public web visitors must never get write-capable CRDT access or appear as collaborators.
- Public web viewers may observe authenticated member awareness for cursors, but inbound public
  awareness is filtered before it can become shared presence.
- Room tree SSE, settings SSE, note presence SSE, and note read-state SSE are separate systems with
  different purposes.
- Backward compatibility matters: do not turn previously optional client data into required runtime
  input without a fallback or a versioned migration plan.
- `sha256` digests are normalized to canonical base64 form in persisted state and API responses.

## Active Tasks

- [tasks/legacy-client-compatibility.md](tasks/legacy-client-compatibility.md)
  - cross-cutting guardrail task to keep older plugin builds working while new protocol features are
    added

If you start another substantial feature, create a new task file before leaving unfinished work.

## Deployment Snapshot

- Production host: `http://46.16.36.87:3000`
- Production images are published as `ghcr.io/romashkahehe/rolay-server:sha-<12-char-commit>`
  by the `deploy` GitHub Actions workflow on `main`.
- `/` serves the bundled public read-only web app.
- `/ready` and existing `/v1/*` APIs remain on the same Fastify/Docker service.
- `/public/api/rooms` is live and returns published rooms only.

## Recently Completed Changes

- Added room-level Markdown note read-state stream and `mark-read` mutation.
- Added follow-mode support in note presence via awareness `sessionId`.
- Restored compatibility for older plugin builds that do not publish `viewer.sessionId` by
  synthesizing a legacy fallback `sessionId` server-side.
- Added resumable authenticated blob upload/download flows with progress metadata and cancel
  support.
- Added live Excalidraw support with single-editor lease semantics and reconnect snapshot storage.
- Added public read-only room publishing, public manifest/blob/CRDT APIs, and the bundled dark web
  viewer served from `/`.
- Deployed the public read-only site rollout to the production VM after the GitHub Actions SSH
  failure was caused by the server being temporarily offline.
- Improved the public web viewer visual language, added lazy KaTeX rendering for Markdown math, and
  switched public Excalidraw rendering to the official Excalidraw SVG export path with a lightweight
  canvas fallback.
- Fixed public Markdown live viewing so read-only CRDT sessions receive live edits and member
  awareness without publishing public visitor presence. Markdown source styling now highlights
  headings, emphasis, links, inline code, and related syntax closer to Obsidian's source view.
- Expanded public Excalidraw parsing for Obsidian Excalidraw plugin files marked with
  `excalidraw-plugin: parsed`.

## Where To Look First

For room, invite, or membership behavior:

- [src/modules/workspaces/workspaces.routes.ts](../src/modules/workspaces/workspaces.routes.ts)
- [src/modules/invites/invites.routes.ts](../src/modules/invites/invites.routes.ts)
- [src/services/workspace-service.ts](../src/services/workspace-service.ts)

For public read-only website behavior:

- [src/modules/public-api/public-api.routes.ts](../src/modules/public-api/public-api.routes.ts)
- [src/modules/root/root.routes.ts](../src/modules/root/root.routes.ts)
- [src/services/public-access-service.ts](../src/services/public-access-service.ts)
- [public-web/src/main.ts](../public-web/src/main.ts)

For Markdown realtime, note presence, or note read-state:

- [src/services/realtime-service.ts](../src/services/realtime-service.ts)
- [src/services/note-presence-service.ts](../src/services/note-presence-service.ts)
- [src/services/note-read-state-service.ts](../src/services/note-read-state-service.ts)

For binary transfer behavior:

- [src/modules/files/files.routes.ts](../src/modules/files/files.routes.ts)
- [src/modules/storage/storage.routes.ts](../src/modules/storage/storage.routes.ts)
- [src/services/file-service.ts](../src/services/file-service.ts)
- [src/services/storage-service.ts](../src/services/storage-service.ts)

For canonical protocol details:

- [openapi.yaml](../openapi.yaml)
- [docs/protocol.md](../docs/protocol.md)

## Immediate Watchouts

- Old plugin builds may still rely on legacy behavior around note presence and ticket-based blob
  flows.
- Public CRDT tokens must remain read-only; do not reuse authenticated member tokens for public
  website traffic.
- Do not remove the public awareness filtering in `src/services/realtime-service.ts`; it is what
  lets public viewers see member cursors without becoming collaborators themselves.
- Public manifests intentionally do not list image files as tree entries; images are exposed only
  through the `assets` map for Markdown embeds.
- Keep the public web shell lightweight. Heavy readers such as Markdown+KaTeX and Excalidraw should
  remain lazy-loaded chunks rather than blocking `/`.
- The plugin still needs UI wiring for publication toggles and public-link display; server support is
  already present.
- `docs/*` should remain factual; do not dump unfinished-task memory there.
- If you touch a protocol edge used by the plugin, update:
  - the task file, if the work is ongoing
  - `current-state.md`, if priorities or invariants changed
  - `openapi.yaml` and `docs/protocol.md`, if the wire contract changed
