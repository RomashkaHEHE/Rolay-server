# Legacy Client Compatibility

## Status

`in-progress`

## Goal

Keep older plugin builds working while the server continues to gain new protocol features.

## Why This Exists

Recent work on note presence follow mode showed that a seemingly small protocol tightening can make
older clients disappear from presence-related features. Compatibility is now an explicit ongoing
task, not an accidental side effect.

## Affected Areas

- note presence awareness aggregation
- SSE payload evolution
- room/workspace route aliases
- blob upload and download flows
- hash normalization behavior

## Must-Not-Break Invariants

- previously working plugin builds should not be broken by server-only upgrades without a migration
  plan
- new protocol fields may be added, but old client assumptions need a fallback where practical
- canonical docs must reflect compatibility behavior once it becomes part of the contract

## Current State

- note presence now accepts modern `viewer.sessionId` and also synthesizes a legacy fallback
  `sessionId` for clients that do not send it
- route aliases for `/rooms` and `/workspaces` remain active
- blob flow still supports both authenticated content endpoints and legacy ticket-based download

## Remaining Work

- keep adding compatibility regression tests when new breakage patterns are found
- decide whether the project wants an explicit compatibility matrix or minimum plugin version policy
- audit future protocol changes for "optional became required" mistakes before shipping them

## Validation

- compatibility around legacy note presence is covered by `test/app.test.ts`
- full test suite should stay green after protocol changes

## Next Handoff

If you touch client-facing protocol behavior, check this task first and decide whether the change is:

1. additive
2. fallback-protected
3. intentionally breaking with a documented migration
