# AGENTS Entrypoint

This directory is the operational handoff layer for AI agents working in this repository.

Use it for:

- current priorities
- unfinished work
- design intent and tradeoffs
- backlog ideas and implementation memory

Do not treat `AGENTS/` as the source of truth for wire formats or runtime behavior. Canonical facts
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
4. The specific task file you are continuing, if one exists
5. [context/README.md](context/README.md)
6. The canonical docs relevant to the feature you are touching
7. [ideas/index.md](ideas/index.md) only if you are exploring or shaping future work

## How This Layer Is Organized

- `current-state.md`
  - short operational snapshot of the repo right now
- `task-protocol.md`
  - rules for creating and maintaining task memory
- `task-template.md`
  - template for new task files
- `context/`
  - design intent, tradeoffs, and invariants
- `tasks/`
  - active or paused implementation memory
- `ideas/`
  - product or architecture backlog that is not yet a concrete implementation task

## Required Update Rules

When you change the project, update `AGENTS/` deliberately:

1. Update [current-state.md](current-state.md) when:
   - priorities change
   - a new major subsystem lands
   - a major task starts or finishes
   - an invariant changes

2. Create or update a task file when:
   - work spans more than one session
   - work touches multiple subsystems
   - you leave behind unfinished implementation detail
   - another agent should be able to resume without chat history

3. Update `context/` when:
   - the reason behind a design changes
   - a compatibility rule changes
   - a tradeoff becomes more important than before

4. Update `ideas/` when:
   - a new idea appears but is not implementation-ready
   - an idea moves into active implementation
   - an idea is rejected or deliberately postponed

## Important Boundary

Keep agent-specific guidance inside `AGENTS/`.

- `README.md` and `docs/*` should stay factual and human-readable
- `AGENTS/*` should carry workflow, priority, and handoff memory

If a fact becomes important enough to be canonical, move it into `README.md`, `docs/*`, or
`openapi.yaml` and leave only the operational summary in `AGENTS/`.
