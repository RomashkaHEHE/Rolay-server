# Sync And Invariants

## Core Separation

Server intentionally has separate sync systems:

- room tree SSE
- settings SSE
- note presence SSE
- Markdown CRDT websocket
- binary blob upload/download
- drawing websocket

Do not collapse these casually. Each exists because consistency model is different.

## Invariants That Matter

### 1. Only Markdown Is CRDT

- Markdown => `Yjs` / `Hocuspocus`
- everything else => blob revision flow

Do not make `.txt`, images, or Excalidraw use Markdown CRDT path.

### 2. Tree Is Server-Authoritative

File tree is not CRDT. Stable entry IDs plus explicit conflicts are deliberate choice.

Protect:

- `entryVersion` preconditions
- canonical path normalization
- explicit conflict responses

### 3. Binary And Excalidraw Revisions Publish Only On Commit

Other users must not see partial uploads.

Protect:

- stage-then-commit upload flow
- explicit cancel behavior
- ranged download as read concern, not publish mechanism

### 4. Presence Is Separate From Content Sync

- note presence = live and ephemeral
- drawing pointer = live and ephemeral
- content publication still follows its own channel

Do not derive file content state from presence alone.

### 5. Excalidraw Is Single-Editor In V1

Live Excalidraw intentionally not multi-writer.

Protect:

- one active editor lease
- control request flow
- separate live scene snapshot storage

### 6. Excalidraw Kind Is Explicit, Not Suffix-Based

`kind="excalidraw"` is source of truth once entry exists.

Protect:

- `create_excalidraw` may target ordinary Markdown paths like `diagram.md`
- rename/move must not downgrade Excalidraw kind because filename changes
- drawing token and live drawing APIs key off entry kind, not path suffix
- serialized drawing file remains blob-backed fallback layer

## What Usually Breaks When Boundaries Blur

- clients interpret wrong SSE stream
- binary files treated like text
- compatibility breaks for old plugin builds
- partial data becomes visible too early
- conflicts become silent instead of explicit
- Excalidraw fallback path activates unnecessarily because server validation is too strict
