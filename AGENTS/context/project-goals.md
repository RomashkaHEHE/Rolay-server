# Project Goals

## Product Shape

Rolay Server exists to support a self-hosted Obsidian collaboration workflow for a relatively small
group.

The design target is not a generic internet-scale collaboration platform. It is a pragmatic server
that makes:

- Markdown collaboration reliable
- room membership simple
- attachment sync predictable
- self-hosting on a single VPS realistic

## What The Project Optimizes For

- correctness of Markdown merge behavior
- explicit tree conflicts instead of hidden magic
- operational simplicity over deep infrastructure
- plugin-friendly protocol boundaries
- preserving user work over chasing elegance

## What The Project Deliberately Does Not Optimize For Yet

- multi-node horizontal scaling
- internet-scale fanout
- fully normalized relational persistence
- generic plugin-agnostic abstractions

## Why That Matters

When adding new features, prefer solutions that fit the current scope.

If a change adds large-system complexity, make sure it solves a real product need and not only a
theoretical architecture preference.
