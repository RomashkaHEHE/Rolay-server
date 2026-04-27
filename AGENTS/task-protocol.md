# Task Protocol

This file defines when and how to create implementation-memory files under `AGENTS/tasks/`.

## When A Task File Is Required

Create a task file when any of the following is true:

- the work will span multiple sessions
- the work touches multiple subsystems
- the work changes protocol or compatibility behavior
- the work is not finished in one pass
- another agent would lose important local reasoning without a handoff note

For tiny, one-shot edits that land fully in one session, a task file is optional.

## What A Task File Must Contain

Each task file should include:

- status
- goal
- why it exists
- related ideas or prior decisions
- affected files or subsystems
- invariants that must not be broken
- current state of implementation
- remaining work
- validation already run
- next recommended step for the next agent

Use [task-template.md](task-template.md) as the default shape.

## When To Update A Task File

Update the task file:

- when you start the task
- when scope changes
- when you make an important decision
- before you stop with unfinished work
- after validation changes the confidence level

Do not leave a task half-implemented in code and undocumented in `AGENTS/tasks/`.

## Task Lifecycle

1. Idea exists only as exploration
   - keep it under `AGENTS/ideas/`
2. Work becomes implementation-ready
   - create a task file under `AGENTS/tasks/`
   - link back to the idea file if there is one
3. Work is active
   - keep the task file current
4. Work is complete
   - move the durable facts into canonical docs if needed
   - summarize the completion in `current-state.md`
   - remove the task file if no active implementation memory is still needed

This repository currently treats `AGENTS/tasks/` as active or paused implementation memory, not as
a permanent archive.

## Linking Ideas To Tasks

When a task comes from an idea:

- add a `Source idea:` link in the task file
- update the idea file to mention that implementation started
- keep the product/architecture rationale in `ideas/`
- keep execution detail and next-step memory in `tasks/`

## Updating Context

Update `AGENTS/context/*` when the answer to any of these changes:

- why is the system designed this way?
- what tradeoff are we protecting?
- what compatibility or safety rule must future work preserve?

Do not force every implementation detail into `context/`. That layer is for durable design intent,
not for step-by-step execution notes.

## Updating Current State

Update [current-state.md](current-state.md) when:

- a priority changes
- a new active task starts
- a task finishes and matters to future work
- an invariant changes
- a new subsystem or protocol surface lands

## Minimum Handoff Rule

Before leaving incomplete work, make sure all three are true:

1. the code reflects the latest known state
2. the task file says what is done and what is left
3. `current-state.md` still points a new agent toward the right next move
