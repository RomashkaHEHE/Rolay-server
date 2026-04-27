# Excalidraw Client Alignment

## Status

`in-progress`

## Goal

Keep server-side Excalidraw contract aligned with Rolay plugin so live single-editor mode works
when client recognizes drawings by suffix or frontmatter.

## Why This Exists

Excalidraw integration spans tree ops, blob persistence, live drawing websocket, and client-side
classification logic. Without task memory, next agent can easily reintroduce suffix-based checks or
forget that blob-only fallback must remain valid.

## Affected Areas

- `src/services/workspace-service.ts`
- `src/services/drawing-service.ts`
- `src/services/file-service.ts`
- `docs/protocol.md`
- `docs/architecture.md`
- `openapi.yaml`
- `test/app.test.ts`

## Must-Not-Break Invariants

- Excalidraw live mode is single-editor only in `v1`
- serialized drawing file remains blob-backed persistent layer
- drawing websocket is optional; blob-only fallback must stay valid
- `kind="excalidraw"` is source of truth once entry exists
- rename/move must not downgrade Excalidraw kind because filename changes
- Markdown CRDT must stay Markdown-only

## Current State

- server supports `create_excalidraw`
- drawing token, lease, control requests, scene snapshot broadcast, pointer presence exist
- reconnect hydration uses stored latest snapshot
- blob-only fallback for Excalidraw is covered by tests
- path constraints were relaxed: client may create Excalidraw at ordinary paths like `diagram.md`
- live drawing APIs work by entry kind, not filename suffix

## Remaining Work

- plugin branch still needs to fully consume relaxed Excalidraw kind contract
- server still does not parse serialized drawing frontmatter to reclassify already-existing entries
- if future need appears, evaluate explicit convert/reclassify API instead of ad-hoc heuristics

## Decisions Made

- do not use CRDT for Excalidraw in `v1`
- do not require `*.excalidraw.md` suffix on server
- do not auto-convert existing `markdown` or `binary` entry into `excalidraw` just from blob content
- keep drawing live channel separate from generic room/tree/file sync

## Validation

- full suite green after Excalidraw path relaxation
- `test/app.test.ts` covers:
  - markdown-only endpoint rejection for Excalidraw entries
  - blob-only fallback flow
  - live drawing token/lease/control/pointer flow
  - lease expiry

## Open Questions

- whether server should later validate Excalidraw serialized content by frontmatter on upload
- whether project wants explicit convert-entry flow for pre-existing room files

## Next Handoff

If plugin reports another Excalidraw mismatch, first classify it as one of:

1. kind-creation mismatch
2. blob persistence mismatch
3. live drawing websocket mismatch
4. compatibility/fallback mismatch

Then update this task before changing server behavior again.
