# Rolay Server

Backend for self-hosted Obsidian collaboration with realtime markdown editing,
single-editor Excalidraw live sessions, room tree sync, and blob-based attachment storage.

## Current status

- live auth endpoints: `POST /v1/auth/login`, `POST /v1/auth/refresh`
- live auth endpoints: `GET /v1/auth/me`, `PATCH /v1/auth/me/profile`, `PATCH /v1/auth/me/password`
- live settings/admin stream: `GET /v1/events/settings` (SSE with cursor resume)
- live room endpoints:
  `GET /v1/rooms`,
  `POST /v1/rooms`,
  `GET /v1/rooms/:workspaceId/members`,
  `GET /v1/rooms/:workspaceId/publication`,
  `PATCH /v1/rooms/:workspaceId/publication`,
  `POST /v1/rooms/join`
- live public read-only site: `GET /`
- live public read-only API:
  `GET /public/api/rooms`,
  `GET /public/api/rooms/:workspaceId/manifest`,
  `GET /public/api/rooms/:workspaceId/events`,
  `POST /public/api/rooms/:workspaceId/markdown/:entryId/crdt-token`,
  `GET /public/api/rooms/:workspaceId/files/:entryId/blob/content`
- live room invite endpoints:
  `GET /v1/rooms/:workspaceId/invite`,
  `PATCH /v1/rooms/:workspaceId/invite`,
  `POST /v1/rooms/:workspaceId/invite/regenerate`
- live admin endpoints:
  `GET /v1/admin/users`,
  `POST /v1/admin/users`,
  `DELETE /v1/admin/users/:userId`,
  `GET /v1/admin/workspaces`,
  `GET /v1/admin/workspaces/:workspaceId/members`,
  `POST /v1/admin/workspaces/:workspaceId/members`,
  `DELETE /v1/admin/workspaces/:workspaceId`
- live tree endpoints: `GET /v1/workspaces/:workspaceId/tree`
- live tree endpoints: `POST /v1/workspaces/:workspaceId/ops/batch`
- live event stream: `GET /v1/workspaces/:workspaceId/events` (SSE)
- live note presence stream:
  `GET /v1/workspaces/:workspaceId/note-presence/events`
  (SSE snapshot + live note updates)
- live note read-state stream:
  `GET /v1/workspaces/:workspaceId/note-read-state/events`
  (SSE snapshot + live unread/read updates for markdown notes)
- live note read mutation:
  `POST /v1/workspaces/:workspaceId/notes/:entryId/read`
- live markdown bootstrap: `POST /v1/workspaces/:workspaceId/markdown/bootstrap`
  (supports metadata-only mode via `includeState=false`)
- live file endpoints: `POST /v1/files/:entryId/crdt-token`
- live file endpoints: `POST /v1/files/:entryId/drawing-token`
- live file endpoints: `POST /v1/files/:entryId/blob/upload-ticket`
- live file endpoints: `PUT /v1/files/:entryId/blob/uploads/:uploadId/content`
- live file endpoints: `GET /v1/files/:entryId/blob/content`
- live file endpoints: `POST /v1/files/:entryId/blob/download-ticket`
- live file endpoints: `DELETE /v1/files/:entryId/blob/uploads/:uploadId`
- live CRDT runtime: `Yjs` + `Hocuspocus` websocket server on `/v1/crdt`
- live drawing endpoints:
  `POST /v1/drawings/:entryId/lease/acquire`,
  `POST /v1/drawings/:entryId/lease/release`,
  `POST /v1/drawings/:entryId/control-requests`,
  `POST /v1/drawings/:entryId/control-requests/:requestId/approve`,
  `POST /v1/drawings/:entryId/control-requests/:requestId/deny`
- live drawing runtime: single-editor websocket server on `/v1/drawings`
- persistent document storage drivers: `local`, `minio`
- persistent server state drivers: `memory`, `postgres`

## Architecture decisions

- global user roles are `admin`, `writer`, `reader`
- room membership roles are `owner`, `member`
- realtime CRDT is used only for markdown content
- room-level note presence is aggregated from markdown awareness and exposed through a separate SSE stream
- room-level note read state is persisted per account and exposed through its own SSE stream
- Excalidraw drawings use first-class `kind="excalidraw"` entries with blob persistence plus
  single-editor live scene broadcast
- room tree state is server-authoritative, not CRDT-based
- room publication is opt-in; rooms are private by default and only owner/admin can toggle public read-only access
- public read-only Markdown uses short-lived read-only CRDT tokens and does not publish visitor presence
- public read-only Markdown connections are counted separately as anonymous per-note viewer counts
- public web Markdown renders as a read-only preview, including math, callouts, basic formatting,
  embedded images, and Obsidian Excalidraw plugin notes marked with `excalidraw-plugin: parsed`
- public manifests show folders, Markdown notes, and Excalidraw files; image blobs are exposed only as assets for embedded Markdown images
- binary files are synced as blob objects addressed by `sha256`
- server accepts `sha256` digests in hex or base64 form and normalizes them to canonical base64 in API responses and persisted state
- binary uploads are staged and streamed through the server before `commit_blob_revision`
- binary uploads are resumable by byte offset and return `uploadedBytes` on resumed tickets
- drawing live scene snapshots are stored separately from room state snapshots and do not use CRDT
- desktop clients can upload blob bytes through an authenticated API endpoint instead of relying only on raw ticket URLs
- binary downloads support authenticated HTTP `Range` requests with `206 Partial Content`
- binary progress can be driven by `uploadedBytes`, `sizeBytes`, `Content-Length`, and `Content-Range`
- server state currently persists as a single snapshot row in PostgreSQL
- document payloads and blobs can live either on local disk or in MinIO/S3-compatible storage

## Local development

1. Copy `.env.example` to `.env`.
2. Install dependencies with `npm install`.
3. Start the app with `npm run dev`.
4. Build the public web app with `npm run build:web` or build everything with `npm run build`.

For a full local stack with `PostgreSQL` and `MinIO`, use:

```bash
docker compose up --build
```

Default dev auth:

- username: `dev`
- password: `dev-password`
- display name: `Development User`
- role: `admin`

Managed accounts:

- there is no public self-registration in `v1`
- the seeded dev user is an admin and can create other accounts via `POST /v1/admin/users`
- created accounts can currently be `writer` or `reader`
- only `writer` and `admin` can create rooms
- `reader` cannot create rooms and can only join existing rooms
- every user can change their own `displayName` via `PATCH /v1/auth/me/profile`
- every room has one stable invite key that can be enabled/disabled without changing it
- owners can regenerate the invite key, which invalidates the old one
- room owners can publish/unpublish a room through `PATCH /v1/rooms/:workspaceId/publication`

## Runtime expectations

- `Node.js 20+`
- `npm`
- optional local `Docker` for container smoke tests
- `PostgreSQL` when `STATE_DRIVER=postgres`
- `MinIO` or another S3-compatible backend when `STORAGE_DRIVER=minio`

## Repository docs

- [AGENTS/AGENTS.md](AGENTS/AGENTS.md)
- [docs/codebase-map.md](docs/codebase-map.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/protocol.md](docs/protocol.md)
- [docs/conflict-resolution.md](docs/conflict-resolution.md)
- [docs/deploy.md](docs/deploy.md)
- [openapi.yaml](openapi.yaml)

## Next step

- replace the snapshot-style PostgreSQL persistence with a normalized relational model
- add a reverse proxy and move public access from `:3000` to `80/443`
- add background cleanup for orphaned blob payloads and expired upload artifacts
- add background cleanup for orphaned resumable upload sessions
