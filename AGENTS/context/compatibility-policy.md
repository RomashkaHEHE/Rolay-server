# Compatibility Policy

## Current Reality

This project already has plugin builds in the wild, so protocol changes are not free.

The current expectation is:

- older plugin builds should keep working unless there is an explicit migration plan
- additive changes are preferred over breaking changes
- when a new client field becomes important, server-side fallback is usually safer than sudden
  strict rejection

## Practical Rules

### Prefer Additive Changes

Good examples:

- adding a new SSE field
- adding a new endpoint while keeping the old one
- returning more metadata without changing existing semantics

Risky examples:

- making an old optional client field effectively mandatory
- changing the meaning of an existing field
- removing old aliases without a deprecation story

### Keep Legacy Paths Working When Reasonable

Examples already in the codebase:

- `/rooms` and `/workspaces` aliases
- ticket-based blob download still works while authenticated blob content exists
- `sha256` hex input still normalizes correctly
- note presence now synthesizes a legacy fallback `sessionId` for older clients that never sent one

### Protect Old Clients With Tests When Possible

If a regression is easy to express in a test, add one.

This is especially valuable for:

- note presence
- blob transfer flows
- route aliases
- hash normalization

## When A Breaking Change Is Acceptable

Only when all three are true:

1. the old behavior is actively harmful or impossible to maintain
2. the migration path is documented
3. the change is reflected in canonical docs and operational handoff

If those conditions are not met, bias toward compatibility.
