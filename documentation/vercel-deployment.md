# Vercel Deployment Setup

This repo should deploy from a single branch (`main`) into four Vercel projects:

1. `web-demo` (read-only visakanv frontend)
2. `api-demo` (read-only visakanv API)
3. `web-app` (multi-user frontend)
4. `api-app` (multi-user API)

This avoids branch drift while still letting demo and multi-user run different runtime behavior via environment variables.

## Why this split

- Demo and hosted share almost all code.
- Behavior differences are config-driven (`LATENT_SCOPE_APP_MODE`, read-only flag, public dataset/scope).
- Vercel already supports independent env vars, domains, and promotion per project.

## Shared infra (common to both demo + hosted)

- LanceDB: `LANCEDB_URI`, `LANCEDB_API_KEY`
- VoyageAI: `VOYAGE_API_KEY`, optional `VOYAGE_MODEL`
- Data artifacts source: `DATA_URL` (R2/S3/CDN) and/or `LATENT_SCOPE_DATA` (local dev)
- CORS allowlist: `CORS_ORIGIN`
- Observability: Vercel logs + error tracking (recommended: Sentry)

## Project root directories

- `web-*` projects use root directory: `web`
- `api-*` projects use root directory: `api`

`web/vercel.json` is used for SPA fallback routing.
`api/vercel.json` is intentionally minimal; Hono on Vercel is zero-config and serves `api/src/index.ts` as the function entrypoint.

## Environment templates

Use these files as source-of-truth when creating Vercel environment variables:

- `api/.env.vercel.demo.example`
- `api/.env.vercel.hosted.example`
- `web/.env.vercel.demo.example`
- `web/.env.vercel.hosted.example`

## Required mode settings

### Demo (`api-demo`)

- `LATENT_SCOPE_APP_MODE=single_profile`
- `LATENT_SCOPE_READ_ONLY=1`
- `LATENT_SCOPE_PUBLIC_DATASET=visakanv-tweets`
- `LATENT_SCOPE_PUBLIC_SCOPE=scopes-001`

### Hosted (`api-app`)

- `LATENT_SCOPE_APP_MODE=hosted`
- `LATENT_SCOPE_READ_ONLY=0`

## Frontend API URL wiring

### Demo frontend (`web-demo`)

- `VITE_API_URL=https://<api-demo-domain>/api`

### Hosted frontend (`web-app`)

- `VITE_API_URL=https://<api-app-domain>/api`

## Domain layout (recommended)

- Demo:
  - `demo.yourdomain.com` -> `web-demo`
  - `api-demo.yourdomain.com` -> `api-demo`
- Hosted:
  - `app.yourdomain.com` -> `web-app`
  - `api.yourdomain.com` -> `api-app`

## CI / GitHub flow

- Connect all four Vercel projects to this GitHub repo.
- Production deployments from `main`.
- Preview deployments for PR branches on all four projects.
- Keep one code line; do not maintain long-lived `demo` and `hosted` branches.

## Current product boundary

- TS API is the production serving path for Explore/read routes.
- Python remains for pipeline/admin/write workflows during migration.
- For full hosted multi-user production, add TS-native auth + jobs endpoints and bind to Modal/Postgres.
