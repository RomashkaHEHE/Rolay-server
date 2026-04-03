# Deploy and Auto-Deploy

This document describes the production deploy flow for `Rolay Server`.

## Target shape

- GitHub Actions builds and pushes the Docker image to `GHCR`
- the VPS connects over SSH
- the VPS keeps a checked-out copy of the repository in the deploy directory
- each deploy pulls the latest `main` branch, pulls the new image, and restarts the stack with `docker compose`

## Current VPS bootstrap

The current target VPS was prepared with:

- OS: `Ubuntu 22.04`
- Docker: installed
- Docker Compose plugin: installed
- deploy user: `user1`
- deploy path: `/home/user1/rolay-server`
- runtime env file: `/home/user1/rolay-server/.env`

The repository stays public on GitHub, so the VPS can clone it over HTTPS.

## GitHub Actions flow

Workflow files:

- [ci.yml](../.github/workflows/ci.yml)
- [deploy.yml](../.github/workflows/deploy.yml)

`deploy.yml` now does the following on the VPS:

1. creates `DEPLOY_PATH` if it does not exist
2. bootstraps a git checkout in place on the first run
3. otherwise fetches and fast-forwards `main`
4. sets `ROLAY_IMAGE` to the just-built `GHCR` tag
5. logs in to `ghcr.io` on the VPS with the workflow `GITHUB_TOKEN`
6. runs `docker compose -f docker-compose.prod.yml pull`
7. runs `docker compose -f docker-compose.prod.yml up -d --remove-orphans`
8. logs out from `ghcr.io`
9. prunes old dangling images

## GitHub secrets

Set these repository secrets before enabling auto-deploy:

- `DEPLOY_HOST`
- `DEPLOY_PORT`
- `DEPLOY_USER`
- `DEPLOY_PATH`
- `DEPLOY_SSH_KEY`

No separate `GHCR` secret is required for this workflow: the deploy step reuses the GitHub Actions `GITHUB_TOKEN` to authenticate the VPS against `ghcr.io` for the pull.

For the current VPS, the non-secret values are:

- `DEPLOY_HOST=46.16.36.87`
- `DEPLOY_PORT=22`
- `DEPLOY_USER=user1`
- `DEPLOY_PATH=/home/user1/rolay-server`

`DEPLOY_SSH_KEY` must contain the private key that matches the public key installed on the VPS.

## Runtime env on the VPS

The production stack reads `/home/user1/rolay-server/.env`.

It currently contains:

- `POSTGRES_*` values for the local Postgres container
- `MINIO_*` values for the local MinIO container
- `PUBLIC_BASE_URL`, `CRDT_WS_URL`, `BLOB_*` values pointing at the server IP on port `3000`
- `DEV_AUTH_*` values for the initial application login

If you later move behind a domain and reverse proxy, update:

- `PUBLIC_BASE_URL`
- `CRDT_WS_URL`
- `BLOB_UPLOAD_BASE_URL`
- `BLOB_DOWNLOAD_BASE_URL`

## Network note

The cloud security group must allow the app port you plan to use.

Right now the runtime is configured for direct access on:

- `3000/tcp`

If the cloud security group only allows SSH, the app will deploy successfully but will not be reachable from the internet. Later, the better production shape is:

- open `80/tcp` and `443/tcp`
- put `Caddy` or `Nginx` in front
- move the app behind the reverse proxy

## First live deploy

After the local changes are committed and pushed to `main`, the deploy workflow is enough to bootstrap the repo on the VPS and start the stack.

Until those changes are pushed, the VPS is only prepared, not yet serving the current local version of the app.
