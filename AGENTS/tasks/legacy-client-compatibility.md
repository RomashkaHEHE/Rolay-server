# Legacy Client Compatibility

## Status

`in-progress`

## Goal

Keep older plugin builds working while server continues to gain new protocol features.

## Why This Exists

Recent work on note presence and Excalidraw showed that small protocol tightening can break older
or already-shipped plugin behavior. Compatibility is explicit ongoing task, not accidental side
effect.

## Affected Areas

- note presence awareness aggregation
- SSE payload evolution
- room/workspace route aliases
- blob upload and download flows
- hash normalization behavior
- Excalidraw classification behavior

## Must-Not-Break Invariants

- previously working plugin builds should not break from server-only upgrades without migration plan
- new protocol fields may be added, but old client assumptions need fallback where practical
- canonical docs must reflect compatibility behavior once it becomes part of contract

## Current State

- note presence accepts modern client payloads and still preserves older behavior where practical
- route aliases for `/rooms` and `/workspaces` remain active
- blob flow supports authenticated content endpoints and legacy ticket-based download
- Excalidraw no longer requires `*.excalidraw.md` suffix if client explicitly creates
  `kind="excalidraw"` entry

## Remaining Work

- keep adding compatibility regression tests when new breakage patterns appear
- decide whether project wants explicit compatibility matrix or minimum plugin version policy
- audit future protocol changes for "optional became required" mistakes before shipping

## Validation

- compatibility-sensitive flows covered in `test/app.test.ts`
- full test suite should stay green after protocol changes

## Next Handoff

If you touch client-facing protocol behavior, check this task first and decide whether change is:

1. additive
2. fallback-protected
3. intentionally breaking with documented migration
