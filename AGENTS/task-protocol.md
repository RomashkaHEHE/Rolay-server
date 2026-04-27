# Task Protocol

This file defines when and how to create implementation-memory files under `AGENTS/tasks/`.

## When Task File Is Required

Create task file when any of these is true:

- work spans multiple sessions
- work touches multiple subsystems
- work changes protocol or compatibility behavior
- work is not finished in one pass
- another agent would lose important local reasoning without handoff note

For tiny one-shot edits that land fully in one session, task file is optional.

## What Task File Must Contain

Each task file should include:

- status
- goal
- why it exists
- related ideas or prior decisions
- affected files or subsystems
- invariants that must not be broken
- current implementation state
- remaining work
- validation already run
- next recommended step for next agent

Use [task-template.md](task-template.md) as default shape.

## When To Update Task File

Update task file:

- when you start task
- when scope changes
- when you make important decision
- before you stop with unfinished work
- after validation changes confidence level

Do not leave task half-implemented in code and undocumented in `AGENTS/tasks/`.

## Task Lifecycle

1. Idea exists only as exploration
   - keep it under `AGENTS/ideas/`
2. Work becomes implementation-ready
   - create task file under `AGENTS/tasks/`
   - link back to idea file if there is one
3. Work is active
   - keep task file current
4. Work is complete
   - move durable facts into canonical docs if needed
   - summarize completion in `current-state.md`
   - remove task file if no active implementation memory is still needed

This repository treats `AGENTS/tasks/` as active or paused implementation memory, not permanent
archive.

## Linking Ideas To Tasks

When task comes from idea:

- add `Source idea:` link in task file
- update idea file to mention implementation started
- keep product/architecture rationale in `ideas/`
- keep execution detail and next-step memory in `tasks/`

## Updating Context

Update `AGENTS/context/*` when answer to any of these changes:

- why system designed this way?
- what tradeoff are we protecting?
- what compatibility or safety rule must future work preserve?

Do not force every implementation detail into `context/`. That layer is for durable design intent,
not step-by-step execution notes.

## Updating Current State

Update [current-state.md](current-state.md) when:

- priority changes
- new active task starts
- task finishes and matters to future work
- invariant changes
- new subsystem or protocol surface lands

## Minimum Handoff Rule

Before leaving incomplete work, make sure all three are true:

1. code reflects latest known state
2. task file says what is done and what is left
3. `current-state.md` still points new agent toward right next move
