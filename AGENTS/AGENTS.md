# AGENTS Entrypoint

This directory is operational handoff layer for AI agents working in this repository.

Use it for:

- current priorities
- unfinished work
- design intent and tradeoffs
- backlog ideas and implementation memory

Do not treat `AGENTS/` as source of truth for wire formats or runtime behavior. Canonical facts
still live in:

- [README.md](../README.md)
- [docs/architecture.md](../docs/architecture.md)
- [docs/protocol.md](../docs/protocol.md)
- [docs/codebase-map.md](../docs/codebase-map.md)
- [openapi.yaml](../openapi.yaml)

## Read Order

1. [current-state.md](current-state.md)
2. [task-protocol.md](task-protocol.md)
3. [tasks/README.md](tasks/README.md)
4. specific task file you are continuing, if one exists
5. [context/README.md](context/README.md)
6. canonical docs relevant to feature you are touching
7. [ideas/index.md](ideas/index.md) only if exploring future work

## How This Layer Is Organized

- `current-state.md`
  - short operational snapshot of repo right now
- `task-protocol.md`
  - rules for creating and maintaining task memory
- `task-template.md`
  - template for new task files
- `context/`
  - design intent, tradeoffs, invariants
- `tasks/`
  - active or paused implementation memory
- `ideas/`
  - product or architecture backlog not yet concrete implementation task

## Required Update Rules

When you change project, update `AGENTS/` deliberately:

1. Update [current-state.md](current-state.md) when:
   - priorities change
   - new major subsystem lands
   - major task starts or finishes
   - invariant changes

2. Create or update task file when:
   - work spans more than one session
   - work touches multiple subsystems
   - you leave behind unfinished implementation detail
   - another agent should resume without chat history

3. Update `context/` when:
   - reason behind design changes
   - compatibility rule changes
   - tradeoff becomes more important than before

4. Update `ideas/` when:
   - new idea appears but is not implementation-ready
   - idea moves into active implementation
   - idea is rejected or deliberately postponed

## Important Boundary

Keep agent-specific guidance inside `AGENTS/`.

- `README.md` and `docs/*` stay factual and human-readable
- `AGENTS/*` carries workflow, priority, and handoff memory

If fact becomes canonical, move it into `README.md`, `docs/*`, or `openapi.yaml` and leave only
operational summary in `AGENTS/`.
