# Deploy And Auto-Deploy

This document describes the current production deploy shape for Rolay Server.

## Current Production Shape

The repository uses GitHub Actions to:

- build and test the server
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
- direct public access currently on port `3000`

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
7. runs `docker compose -f docker-compose.prod.yml up -d --remove-orphans`
8. logs out of `ghcr.io`
9. prunes dangling images

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

The runtime `.env` defines:

- `PUBLIC_BASE_URL`
- `CRDT_WS_URL`
- `BLOB_UPLOAD_BASE_URL`
- `BLOB_DOWNLOAD_BASE_URL`
- `STATE_DRIVER`
- `POSTGRES_*`
- `STORAGE_DRIVER`
- `MINIO_*`
- `DEV_AUTH_*`

## Access And Networking

Current setup exposes the app directly on:

- `3000/tcp`

The cloud security group must allow:

- `22/tcp` for SSH
- `3000/tcp` for current direct app access

The better production target later is:

- `80/tcp`
- `443/tcp`
- reverse proxy in front of the app

## Operational Notes

Important current behavior:

- the seeded admin account is read from `.env` during startup
- changing `DEV_AUTH_PASSWORD` requires restarting the server to reseed the admin password
- state is persisted through the configured state store, not through in-memory process state alone

## Recommended Next Infra Improvements

- move public traffic behind `Caddy` or `Nginx`
- switch public URLs from raw IP to domain + HTTPS
- add blob/object cleanup for orphaned staged or unreferenced payloads
- consider direct object-storage delivery for very large files if traffic grows
