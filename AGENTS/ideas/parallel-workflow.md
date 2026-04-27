# Parallel Workflow

When multiple ideas are explored in parallel, keep product memory and implementation memory
separate.

## Rule Of Thumb

- one idea = one idea file
- one implementation branch = one task file

The idea file is product or architecture memory.
The task file is implementation memory.

## Recommended Flow

1. Capture the idea in `ideas/`.
2. If implementation starts, create a branch for that idea.
3. Create one task file in `tasks/` for that branch.
4. Link the task file back to the idea file.
5. Keep design intent in `ideas/` and execution details in `tasks/`.

## Why This Split Matters

Without the split:

- product rationale gets buried in execution detail
- implementation handoffs become noisy
- agents cannot tell what is an approved direction versus what is a half-finished branch

## Completion Rule

When the branch finishes:

- update canonical docs if behavior changed
- summarize the result in `current-state.md`
- close or remove the task file
- keep the idea file only if it still matters as long-term product memory
