# Deploy And Auto-Deploy

This document describes the current production deploy shape for Rolay Server.

## Current Production Shape

The repository uses GitHub Actions to:

- build and test the server
- build the bundled public read-only web app
- build a Docker image
- push the image to `GHCR`
- connect to the VPS over SSH
- update the checkout on the VPS
- restart the production compose stack

## Current VPS

Current live target:

- OS: `Ubuntu 22.04`
- user: `user1`
- deploy path: `/home/user1/rolay-server`
- public URL: `https://rolay.ru`
- app container still listens on `3000`, but public traffic goes through `nginx` on `80/443`

## Workflow Files

- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`

## Deploy Workflow Summary

The deploy workflow currently:

1. creates the deploy directory if needed
2. bootstraps a git checkout on first run
3. fetches and fast-forwards `main`
4. logs into `ghcr.io`
5. sets `ROLAY_IMAGE` to the current GHCR tag
6. runs `docker compose -f docker-compose.prod.yml pull`
7. persists the deployed `ROLAY_IMAGE` tag into production `.env`
8. runs `docker compose -f docker-compose.prod.yml up -d --remove-orphans`
9. logs out of `ghcr.io`
10. prunes dangling images

## Secrets Required In GitHub

- `DEPLOY_HOST`
- `DEPLOY_PORT`
- `DEPLOY_USER`
- `DEPLOY_PATH`
- `DEPLOY_SSH_KEY`

The current non-secret values are:

- `DEPLOY_HOST=46.16.36.87`
- `DEPLOY_PORT=22`
- `DEPLOY_USER=user1`
- `DEPLOY_PATH=/home/user1/rolay-server`

## Production Runtime Files

Important production files on the VPS:

- `/home/user1/rolay-server/.env`
- `/home/user1/rolay-server/docker-compose.prod.yml`
- `/etc/nginx/sites-available/rolay.ru`
- `/etc/nginx/sites-enabled/rolay.ru`
- `/etc/letsencrypt/live/rolay.ru/*`

The runtime `.env` defines:

- `PUBLIC_BASE_URL`
- `CRDT_WS_URL`
- `BLOB_UPLOAD_BASE_URL`
- `BLOB_DOWNLOAD_BASE_URL`
- `ROLAY_IMAGE`
- `STATE_DRIVER`
- `POSTGRES_*`
- `STORAGE_DRIVER`
- `MINIO_*`
- `DEV_AUTH_*`

## Access And Networking

Current public setup exposes:

- `80/tcp` for HTTP to HTTPS redirect and Let's Encrypt renewal
- `443/tcp` for public HTTPS

The cloud security group must allow:

- `22/tcp` for SSH
- `80/tcp`
- `443/tcp`

The Docker container still publishes `3000/tcp`; it can remain open temporarily for debugging, but
normal public traffic should use `https://rolay.ru`.

## Domain And TLS

`rolay.ru` has an A record pointing to `46.16.36.87`.

The VPS uses Ubuntu `nginx` as the reverse proxy:

- `http://rolay.ru/*` redirects to `https://rolay.ru/*`
- `https://rolay.ru/*` proxies to `http://127.0.0.1:3000`
- WebSocket upgrade headers are enabled for CRDT and drawing connections
- proxy buffering is disabled so SSE streams can flush events promptly
- `client_max_body_size` is set high enough for large blob uploads

TLS is issued by Let's Encrypt through `certbot --nginx` and auto-renewed by certbot's scheduled
renewal task.

## Operational Notes

Important current behavior:

- the seeded admin account is read from `.env` during startup
- changing `DEV_AUTH_PASSWORD` requires restarting the server to reseed the admin password
- state is persisted through the configured state store, not through in-memory process state alone
- the public web app is served by the same container at `/`, so the current `3000/tcp` rule is
  enough until a reverse proxy/domain is added

## Recommended Next Infra Improvements

- move public traffic behind `Caddy` or `Nginx`
- switch public URLs from raw IP to domain + HTTPS
- add blob/object cleanup for orphaned staged or unreferenced payloads
- consider direct object-storage delivery for very large files if traffic grows
