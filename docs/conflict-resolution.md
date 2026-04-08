# Conflict Resolution In Rolay Server

This document describes the current conflict model. It explains what the server actually guarantees
and what the plugin still has to do on the client side.

## Core Principle

Rolay does not use one universal merge strategy for everything.

Different data types use different rules:

- Markdown content => CRDT merge
- file tree => server-authoritative operations with preconditions
- binary files => whole-file revision model

## Markdown

### Concurrent edits

Markdown files are shared `Yjs` documents.

If two users edit the same note at the same time:

- both edit the same logical CRDT document
- `Yjs` merges their updates
- the server does not do last-write-wins text replacement

This means concurrent Markdown edits should merge rather than silently overwrite each other.

### Offline edits

The intended model is:

- local Markdown edits are stored in local `Yjs` state
- reconnect merges that state back into the shared document

If local offline Markdown edits are lost, that is a client bug or client bootstrap bug, not intended server behavior.

### Delete vs offline edits

If a room entry was deleted while a user still has offline Markdown changes:

- the original path should stay deleted if the server already accepted that delete
- the offline content should be preserved by the client as a conflict copy

The current server does not automatically materialize that copy; the plugin must do it safely.

## Tree Operations

Tree conflicts are handled through:

- stable entry IDs
- `entryVersion`
- optional `path` preconditions

The server accepts valid operations in order and rejects stale ones with conflict results.

### Rename and move

If two clients rename or move the same entry concurrently:

- one operation wins first
- the other usually gets `entry_version_mismatch` or `path_mismatch`

If two different entries target the same final path:

- the second operation returns conflict
- the response may include `suggestedPath`

### Delete and restore

Delete and restore are logical operations on entries.

If restore conflicts with an existing path or invalid parent:

- server returns conflict
- client should not guess
- client should either refetch or use `suggestedPath` if provided

## Binary Files

Binary files are not CRDT.

The model is:

- upload bytes
- then commit a new blob revision

There is no server-side content merge for binary revisions.

### Concurrent binary updates

If two users update the same binary file:

- they may upload different blobs
- whichever `commit_blob_revision` is accepted first becomes the current revision
- the other client should see conflict through stale `preconditions` / `entryVersion`

The client must not pretend that binary content can be merged like Markdown.

### Canceling an upload

Binary upload is now stage-then-commit.

If a user cancels upload:

- client should abort the HTTP upload request
- client should call the cancel endpoint
- client must not send `commit_blob_revision`

Until commit happens, the room should behave as if the new file version does not exist yet.

### Partial upload visibility

The server does not publish partial binary content to the room.

Other users only learn about a new binary revision after:

- upload completed successfully
- `commit_blob_revision` succeeded

This avoids exposing half-uploaded files.

## SSE Consistency

There are two SSE streams and they solve different conflict problems.

### Room SSE

Used for:

- tree events
- blob revision commit visibility

### Settings SSE

Used for:

- room list
- invite state
- profile/admin management UI

Clients should not mix them or treat one as a substitute for the other.

## What The Client Should Do On Conflict

When the server returns tree conflict:

1. inspect the returned `reason`
2. inspect `serverEntry` if present
3. refetch or locally reconcile with current server state
4. retry only if the action is still valid

The client should not silently overwrite state after a `409`.

## Current Known Limits

The current server does not yet provide:

- automatic background cleanup of orphaned uploaded blobs
- resumable chunked uploads
- automatic client conflict-copy creation for every offline edge case

Those are acceptable `v1` limitations, but the plugin should be conservative and preserve user data whenever possible.
