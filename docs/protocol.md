# Rolay Server Protocol Guide

This is a practical guide to the current protocol. It is intentionally shorter than `openapi.yaml`,
but it explains how the pieces fit together.

For exact request and response schemas, use `openapi.yaml`.

## Naming Notes

The codebase still uses both `workspaces` and `rooms`.

Current product meaning:

- `room` is the human-facing concept
- `workspaceId` is still the main stable identifier in the API

In practice:

- prefer `/v1/rooms` for room-management UI
- use `/v1/workspaces/{workspaceId}/...` for tree/content sync

## Transport Layers

The protocol uses:

- REST JSON for auth, room management, tree mutations, bootstrap, and blob tickets
- SSE for room events and settings/admin events
- `Yjs` WebSocket for live Markdown collaboration

## Authentication

### Login

- `POST /v1/auth/login`

Returns:

- `accessToken`
- `refreshToken`
- `user`

`user` currently includes:

- `id`
- `username`
- `displayName`
- `isAdmin`
- `globalRole`

### Refresh

- `POST /v1/auth/refresh`

Returns a rotated token pair.

### Current user

- `GET /v1/auth/me`

### Update profile

- `PATCH /v1/auth/me/profile`

Currently used for `displayName`.

### Change password

- `PATCH /v1/auth/me/password`

Rules:

- caller must know the current password
- server rotates the session on success
- old tokens stop being valid

## Rooms

### List current user's rooms

- `GET /v1/rooms`

Returns the rooms the current user belongs to.

### Create room

- `POST /v1/rooms`

Allowed for:

- `admin`
- `writer`

Not allowed for:

- `reader`

### Join by invite code

- `POST /v1/rooms/join`

### List members of a room

- `GET /v1/rooms/{workspaceId}/members`

Rules:

- available to any current room participant
- response shape matches the admin room members endpoint
- non-members receive the normal workspace access error policy

### Invite management

- `GET /v1/rooms/{workspaceId}/invite`
- `PATCH /v1/rooms/{workspaceId}/invite`
- `POST /v1/rooms/{workspaceId}/invite/regenerate`

Rules:

- invite enable/disable does not regenerate the code
- regenerate creates a new code and invalidates the old one
- room `owner` can manage invite state
- `admin` can also inspect/manage through admin capabilities

## Admin API

### Users

- `GET /v1/admin/users`
- `POST /v1/admin/users`
- `DELETE /v1/admin/users/{userId}`

There is no public self-registration in `v1`.

### Rooms

- `GET /v1/admin/workspaces`
- `GET /v1/admin/workspaces/{workspaceId}/members`
- `POST /v1/admin/workspaces/{workspaceId}/members`
- `DELETE /v1/admin/workspaces/{workspaceId}`

Admin can add a user to a room by username and set room role.

## Settings SSE

- `GET /v1/events/settings`

Purpose:

- live updates for profile/settings screens
- room list updates
- invite state changes
- admin user and room management screens

Resume model:

- `Last-Event-ID`
- or `cursor`

Special behavior:

- first connect without cursor returns `stream.ready`
- later reconnects can resume from that event ID

Event families:

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
- `ping`

The settings stream is separate from room tree SSE.

`room.members.updated` carries a full current room member snapshot and is emitted only to current
participants of that room. Admin dashboards still receive `admin.room.members.updated`.

## Tree Snapshot And Tree Events

### Snapshot

- `GET /v1/workspaces/{workspaceId}/tree`

Returns:

- room metadata
- current room event cursor
- all entries for the room

Each entry has:

- stable `id`
- `path`
- `kind`
- `contentMode`
- `entryVersion`
- `deleted`
- `updatedAt`

Markdown entries may also have:

- `docId`

Binary entries may also have:

- `mimeType`
- `blob`

### Room event stream

- `GET /v1/workspaces/{workspaceId}/events?cursor=...`

This is the stream for tree/file changes inside one room.

Common events:

- `tree.entry.created`
- `tree.entry.updated`
- `tree.entry.deleted`
- `tree.entry.restored`
- `blob.revision.committed`

`cursor` here is a room-event cursor, not a text cursor or awareness position.

## Tree Mutations

- `POST /v1/workspaces/{workspaceId}/ops/batch`

The server is authoritative for tree changes.

Supported operation types:

- `create_folder`
- `create_markdown`
- `create_binary_placeholder`
- `rename_entry`
- `move_entry`
- `delete_entry`
- `restore_entry`
- `commit_blob_revision`

Important behavior:

- operations are idempotent by `opId`
- conflicts use `preconditions`
- path collisions can return `suggestedPath`

## Markdown Bootstrap And Live CRDT

### Bootstrap

- `POST /v1/workspaces/{workspaceId}/markdown/bootstrap`

Purpose:

- preload Markdown `Yjs` state for safe local cache initialization
- avoid websocket-only bootstrap hacks

Supports:

- optional `entryIds`
- optional `includeState`

When `includeState=false`, server returns metadata only.

The response includes:

- `workspaceId`
- `encoding`
- `includesState`
- `documentCount`
- `totalStateBytes`
- `totalEncodedBytes`
- per document:
  - `entryId`
  - `docId`
  - `stateBytes`
  - `encodedBytes`
  - optional `state`

### Realtime token

- `POST /v1/files/{entryId}/crdt-token`

Returns:

- `entryId`
- `docId`
- `provider`
- `wsUrl`
- `token`
- `expiresAt`

This is only for Markdown entries.

### Realtime connection

Client uses:

- WebSocket at `/v1/crdt`
- a normal `Yjs` / `Hocuspocus` compatible provider

The server loads and stores `Yjs` documents from persistent storage.

## Binary File Protocol

This is the main protocol for all non-Markdown files, including `.txt`.

### Classification rule

Client should treat:

- `.md` => Markdown CRDT
- everything else => binary/blob

### Upload ticket

- `POST /v1/files/{entryId}/blob/upload-ticket`

Request includes:

- `hash`
- `sizeBytes`
- `mimeType`

Hash notes:

- client may send `sha256` digests in hex or base64 form
- server normalizes accepted digests to canonical `sha256:<base64>` before storing them or returning them in responses

Response now includes:

- `alreadyExists`
- `uploadId`
- `hash`
- `sizeBytes`
- `mimeType`
- `expiresAt`
- `upload`
- `cancel`

Behavior:

- if `alreadyExists=true`, client should skip byte upload and go directly to `commit_blob_revision`
- if `alreadyExists=false`, client should upload bytes to `upload.url`

### Authenticated blob content upload

- `PUT /v1/files/{entryId}/blob/uploads/{uploadId}/content`

Purpose:

- normal authenticated API upload path for desktop clients
- avoids depending entirely on the raw `/_storage/upload/{ticketId}` transport

Expected request:

- Bearer access token
- raw binary body
- usually `Content-Type: application/octet-stream`
- `Content-Length`

The server also accepts the ticket mime type as transport `Content-Type`.

Response:

- `ok`
- `hash`
- `sizeBytes`

Returned `hash` is canonical `sha256:<base64>` even if the upload ticket was created from a hex digest.

### Cancel upload

- `DELETE /v1/files/{entryId}/blob/uploads/{uploadId}`

Purpose:

- explicitly cancel a pending or active upload session

Client should also abort the local HTTP request when user cancels.

### Commit uploaded blob

After upload completes, client publishes the new file revision via `ops/batch`:

- `commit_blob_revision`

This is the moment when the new version becomes visible to the room.

### Download ticket

- `POST /v1/files/{entryId}/blob/download-ticket`

Response now includes:

- `hash`
- `sizeBytes`
- `mimeType`
- `url`

### Download payload

Client then requests the returned URL.

Server responds with streaming payload and sets:

- `Content-Type`
- `Content-Length`
- `X-Rolay-Blob-Hash`

This is enough for real byte-based download progress UI.

### Binary revision event

After a successful commit, room SSE emits:

- `blob.revision.committed`

Payload includes:

- `entryId`
- `path`
- `hash`
- `sizeBytes`
- `mimeType`
- `entryVersion`

## Client Startup Sequence

Recommended high-level flow:

1. Login or refresh
2. Fetch `GET /v1/auth/me`
3. Fetch room list
4. Open settings SSE
5. When opening a room:
   - fetch tree snapshot
   - open room SSE from `cursor`
   - bootstrap Markdown state
   - start CRDT providers only for opened Markdown docs
   - sync binary files through blob flow

## Source Of Truth

For exact payloads and schemas, use:

- `openapi.yaml`

For behavior details, inspect:

- route files in `src/modules`
- services in `src/services`
