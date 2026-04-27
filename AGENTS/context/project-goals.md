# Project Goals

## Product Shape

Rolay Server exists to support self-hosted Obsidian collaboration workflow for relatively small
group.

Design target is not generic internet-scale collaboration platform. It is pragmatic server that
makes:

- Markdown collaboration reliable
- room membership simple
- attachment sync predictable
- Excalidraw collaboration good enough for study workflows
- self-hosting on single VPS realistic

## What Project Optimizes For

- correctness of Markdown merge behavior
- explicit tree conflicts instead of hidden magic
- operational simplicity over deep infrastructure
- plugin-friendly protocol boundaries
- preserving user work over chasing elegance

## What Project Deliberately Does Not Optimize For Yet

- multi-node horizontal scaling
- internet-scale fanout
- fully normalized relational persistence
- generic plugin-agnostic abstractions
- multi-writer Excalidraw scene merge

## Why That Matters

When adding new features, prefer solutions that fit current scope.

If change adds large-system complexity, make sure it solves real product need and not only
theoretical architecture preference.
