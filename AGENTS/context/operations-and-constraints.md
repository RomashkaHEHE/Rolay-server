# Operations And Constraints

## Current Operational Shape

The project currently assumes a single VPS deployment with:

- one Node process
- one PostgreSQL instance when persistence is enabled
- local disk or MinIO-compatible storage for documents and blobs
- GitHub Actions based deploys

This is intentionally simple.

## What This Means For Development

- in-memory listener fanout is acceptable
- single-process assumptions are still common in services
- background maintenance jobs are limited
- persistence is straightforward but not yet analytically rich

## Important Constraints

### Snapshot State Store

PostgreSQL persistence currently stores one canonical snapshot row per deployment key.

That keeps operations simple, but it means:

- no relational querying over live state
- no cheap partial updates
- schema evolution happens through snapshot versioning

### Blob Lifecycle

Large files already support resumable transfer, but cleanup is still a future concern.

The system still needs:

- orphaned blob cleanup
- expired upload session cleanup
- possibly direct object-storage delivery if traffic grows

### Scale Envelope

The current scale target is still "small group on one server".

If work starts to push beyond that, treat it as an explicit architecture initiative, not as a
background assumption.
