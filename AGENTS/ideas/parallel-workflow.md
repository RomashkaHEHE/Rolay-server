# Parallel Workflow

When multiple ideas are explored in parallel, keep product memory and implementation memory
separate.

## Rule Of Thumb

- one idea = one idea file
- one implementation branch = one task file

Idea file is product or architecture memory.
Task file is implementation memory.

## Recommended Flow

1. Capture idea in `ideas/`.
2. If implementation starts, create branch for that idea.
3. Create one task file in `tasks/` for that branch.
4. Link task file back to idea file.
5. Keep design intent in `ideas/` and execution details in `tasks/`.

## Why This Split Matters

Without split:

- product rationale gets buried in execution detail
- implementation handoffs become noisy
- agents cannot tell what is approved direction versus half-finished branch

## Completion Rule

When branch finishes:

- update canonical docs if behavior changed
- summarize result in `current-state.md`
- close or remove task file
- keep idea file only if it still matters as long-term product memory
