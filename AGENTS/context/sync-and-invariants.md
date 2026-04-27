# Sync And Invariants

## The Core Separation

The server intentionally has separate sync systems:

- room tree SSE
- settings SSE
- note presence SSE
- note read-state SSE
- Markdown CRDT websocket
- binary blob upload/download
- drawing websocket

Do not collapse these casually. Each exists because its consistency model is different.

## Invariants That Matter

### 1. Only Markdown is CRDT

- Markdown => `Yjs` / `Hocuspocus`
- everything else => blob revision flow

Do not make `.txt`, images, or Excalidraw use the Markdown CRDT path.

### 2. The Tree Is Server-Authoritative

The file tree is not a CRDT. Stable entry IDs plus explicit conflicts are a deliberate choice.

Protect:

- `entryVersion` preconditions
- canonical path normalization
- explicit conflict responses

### 3. Binary Revisions Publish Only On Commit

Other users must not see partial uploads.

Protect:

- stage-then-commit upload flow
- explicit cancel behavior
- ranged download as a read concern, not a publish mechanism

### 4. Presence And Read State Are Different

- note presence = live and ephemeral
- note read state = persisted per account

Do not derive unread dots from awareness alone, and do not try to make read-state behave like live
presence.

### 5. Excalidraw Is Single-Editor In V1

Live Excalidraw is intentionally not multi-writer.

Protect:

- one active editor lease
- control request flow
- separate live scene snapshot storage

## What Usually Breaks When These Boundaries Blur

- clients interpret the wrong SSE stream
- binary files are treated like text
- compatibility breaks for old plugin builds
- partial data becomes visible too early
- conflicts become silent instead of explicit
