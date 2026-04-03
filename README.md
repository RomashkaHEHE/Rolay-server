# Rolay Server

Backend for self-hosted Obsidian collaboration with realtime markdown editing,
workspace tree sync, and blob-based attachment storage.

## Current status

- live auth endpoints: `POST /v1/auth/login`, `POST /v1/auth/refresh`
- live auth endpoints: `GET /v1/auth/me`, `PATCH /v1/auth/me/profile`
- live admin endpoint: `POST /v1/admin/users`
- live workspace endpoints: `POST /v1/workspaces`, `POST /v1/invites/accept`
- live invite endpoint: `POST /v1/workspaces/:workspaceId/invites`
- live tree endpoints: `GET /v1/workspaces/:workspaceId/tree`
- live tree endpoints: `POST /v1/workspaces/:workspaceId/ops/batch`
- live event stream: `GET /v1/workspaces/:workspaceId/events` (SSE)
- live file endpoints: `POST /v1/files/:entryId/crdt-token`
- live file endpoints: `POST /v1/files/:entryId/blob/upload-ticket`
- live file endpoints: `POST /v1/files/:entryId/blob/download-ticket`
- live CRDT runtime: `Yjs` + `Hocuspocus` websocket server on `/v1/crdt`
- persistent document storage drivers: `local`, `minio`
- persistent server state drivers: `memory`, `postgres`

## Architecture decisions

- realtime CRDT is used only for markdown content
- workspace tree state is server-authoritative, not CRDT-based
- binary files are synced as blob objects addressed by `sha256`
- server state currently persists as a single snapshot row in PostgreSQL
- document payloads and blobs can live either on local disk or in MinIO/S3-compatible storage

## Local development

1. Copy `.env.example` to `.env`.
2. Install dependencies with `npm install`.
3. Start the app with `npm run dev`.

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
- created users are non-admin by default
- every user can change their own `displayName` via `PATCH /v1/auth/me/profile`

## Runtime expectations

- `Node.js 20+`
- `npm`
- optional local `Docker` for container smoke tests
- `PostgreSQL` when `STATE_DRIVER=postgres`
- `MinIO` or another S3-compatible backend when `STORAGE_DRIVER=minio`

## Repository docs

- [docs/architecture.md](docs/architecture.md)
- [docs/protocol.md](docs/protocol.md)
- [docs/conflict-resolution.md](docs/conflict-resolution.md)
- [docs/deploy.md](docs/deploy.md)
- [openapi.yaml](openapi.yaml)

## Next step

- replace the snapshot-style PostgreSQL persistence with a normalized relational model
- push the current server state to GitHub and let the first VPS deploy run
- add a reverse proxy and move public access from `:3000` to `80/443`
