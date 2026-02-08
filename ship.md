# Ship Plan: Demo + Hosted Deployment

Date: February 8, 2026

## 1. Goal
Ship two production deployments from one repo:

1. Read-only public demo for `visakanv` tweets.
2. Multi-user hosted app where users can import/request archives.

Both variants should use the TypeScript serving API for Explore/read paths.

## 2. Current State (Implemented)

### 2.1 Serving stack
- Explore/read serving is now in `api/` (TypeScript + Hono).
- App config endpoint returns frontend-compatible keys:
  - `public_dataset_id`
  - `public_scope_id`
  - full `features` object
  - `limits`
- Search requests include `deleted = false` filtering in LanceDB queries.

### 2.2 Read endpoints migrated to TS API
`api/src/routes/data.ts` now serves/proxies the read bootstrap surface used by Explore:
- `datasets/:dataset/meta`
- `datasets/:dataset/scopes`
- `datasets/:dataset/embeddings`
- `datasets/:dataset/clusters`
- `datasets/:dataset/clusters/:cluster/labels_available`
- `datasets/:dataset/links/*`
- `indexed`, `query`, `column-filter`
- `files/*`, `datasets`
- `models/embedding_models`, `tags`

`scope_id` is now required for query/indexed/filter routes when no public scope is configured.

### 2.3 Frontend request correctness
Frontend read calls now pass `scope_id` where needed (thread, quotes, carousel, hover, filter/data fetch paths), so hosted multi-scope behavior is compatible with TS API routing.

### 2.4 Vercel project split scaffolding
Added per-project Vercel config and env templates:
- `web/vercel.json`
- `api/vercel.json`
- `web/.env.vercel.demo.example`
- `web/.env.vercel.hosted.example`
- `api/.env.vercel.demo.example`
- `api/.env.vercel.hosted.example`
- `documentation/vercel-deployment.md`

## 3. Flask/Python Boundary (Current)

### 3.1 Production read path
- Deployed Explore/read traffic should go to TS API only.
- Flask is not required for deployed read routes.

### 3.2 Remaining Python scope
Keep Python for workflows that have not yet been moved to TS:
- import
- jobs/orchestration hooks
- admin/bulk write operations

For local development, a Python service can still be used as an optional legacy upstream, but it is no longer the target serving architecture.

## 4. Deployment Topology
Use one code line (`main`) and four Vercel projects:

1. `web-demo`
2. `api-demo`
3. `web-app`
4. `api-app`

Recommended domains:
- `demo.<domain>` -> `web-demo`
- `api-demo.<domain>` -> `api-demo`
- `app.<domain>` -> `web-app`
- `api.<domain>` -> `api-app`

Frontend wiring:
- demo: `VITE_API_URL=https://api-demo.<domain>/api`
- hosted: `VITE_API_URL=https://api.<domain>/api`

## 5. Shared Infra (Common to Demo + Hosted)
- LanceDB Cloud: `LANCEDB_URI`, `LANCEDB_API_KEY`
- Voyage AI: `VOYAGE_API_KEY`, optional `VOYAGE_MODEL`
- Data artifacts source: `DATA_URL` and/or `LATENT_SCOPE_DATA`
- CORS allowlist: `CORS_ORIGIN`
- Optional hosted limits:
  - `LATENT_SCOPE_MAX_UPLOAD_MB`
  - `LATENT_SCOPE_JOB_TIMEOUT_SEC`

## 6. Remaining Work Before Full Hosted Launch
1. TS-native auth for per-user datasets/scopes.
2. TS endpoints for import/job lifecycle (or stable gateway to Python workers).
3. Persistent metadata/source-of-truth for dataset/scope discovery in hosted mode.
4. Background job orchestration wiring (Modal + status persistence + notifications).
5. Production monitoring and alerting (errors, latency, job failures).

## 7. Branching Strategy
Do not split long-lived `demo` vs `hosted` branches.
Use:
- single branch (`main`)
- per-project env configuration in Vercel
- PR previews on all four projects
