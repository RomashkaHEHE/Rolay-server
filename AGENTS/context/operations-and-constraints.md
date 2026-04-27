# Operations And Constraints

## Current Operational Shape

Project currently assumes single VPS deployment with:

- one Node process
- one PostgreSQL instance when persistence enabled
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

That keeps operations simple, but means:

- no relational querying over live state
- no cheap partial updates
- schema evolution happens through snapshot versioning

### Blob Lifecycle

Large files already support resumable transfer, but cleanup still future concern.

System still needs:

- orphaned blob cleanup
- expired upload session cleanup
- possibly direct object-storage delivery if traffic grows

### Excalidraw Live Sessions

Live drawing state is intentionally lightweight on server side.

Current constraints:

- single current editor only
- no scene diff merge
- no server-side parsing of serialized drawing content for reclassification
- reconnect hydration uses stored snapshot, not full collaborative history

### Scale Envelope

Current scale target still "small group on one server".

If work starts to push beyond that, treat it as explicit architecture initiative, not background
assumption.
