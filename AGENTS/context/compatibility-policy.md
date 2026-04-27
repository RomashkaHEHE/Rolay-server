# Compatibility Policy

## Current Reality

Project already has plugin builds in wild, so protocol changes are not free.

Current expectation:

- older plugin builds should keep working unless explicit migration plan exists
- additive changes are preferred over breaking changes
- when new client field or path rule becomes important, server-side fallback is usually safer than
  sudden strict rejection

## Practical Rules

### Prefer Additive Changes

Good examples:

- adding new SSE field
- adding new endpoint while keeping old one
- returning more metadata without changing existing semantics
- relaxing server validation so existing client intent can succeed

Risky examples:

- making old optional client field effectively mandatory
- changing meaning of existing field
- removing old aliases without deprecation story
- coupling Excalidraw behavior to filename when client already classifies by frontmatter

### Keep Legacy Paths Working When Reasonable

Examples already in codebase:

- `/rooms` and `/workspaces` aliases
- ticket-based blob download still works while authenticated blob content exists
- `sha256` hex input still normalizes correctly
- Excalidraw no longer requires `*.excalidraw.md` suffix if client explicitly uses
  `create_excalidraw`

### Protect Old Clients With Tests When Possible

If regression is easy to express in test, add one.

This especially valuable for:

- note presence
- blob transfer flows
- route aliases
- hash normalization
- Excalidraw classification and fallback behavior

## When Breaking Change Is Acceptable

Only when all three true:

1. old behavior actively harmful or impossible to maintain
2. migration path documented
3. change reflected in canonical docs and operational handoff

If those conditions are not met, bias toward compatibility.
