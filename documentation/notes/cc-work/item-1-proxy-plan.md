# Item 1 — Centralize proxy mode (remove endpoint-local fallbacks) Plan

Date: 2026-02-15

Problem:
Read endpoints in `api/src/routes/{catalog,views,graph}.ts` contain per-handler branching:
`try local -> catch -> if (DATA_URL ends with /api) proxy -> else {404/empty}`.
This spreads deployment-mode logic across many handlers.

Goal:
Make exactly one proxy decision in route wiring:
- If `DATA_URL` ends with `/api`, the read data surface is served as a pure proxy.
- Otherwise, serve via local LanceDB + file/CDN fetch paths.

Non-goals:
- Do not change the legacy upstream API shapes; proxy mode assumes upstream already serves the contract the frontend expects.
- Do not refactor view-table work (Milestone D) in this item.

Implementation steps:
1. Add `api/src/routes/dataProxy.ts` with a `dataProxyRoutes` Hono router:
   - Handles only an explicit allowlist of legacy data-surface endpoints:
     - `/datasets`
     - `/datasets/:dataset/meta`
     - `/datasets/:dataset/scopes`
     - `/datasets/:dataset/scopes/:scope`
     - `/datasets/:dataset/scopes/:scope/parquet`
     - `/datasets/:dataset/embeddings`
     - `/datasets/:dataset/clusters`
     - `/datasets/:dataset/clusters/:cluster/labels_available`
     - `/datasets/:dataset/clusters/:cluster/labels/:labelId`
     - `/datasets/:dataset/links/meta`
     - `/datasets/:dataset/links/node-stats`
     - `/datasets/:dataset/links/by-indices`
     - `/datasets/:dataset/links/thread/:tweetId`
     - `/datasets/:dataset/links/quotes/:tweetId`
     - `/files/:filePath{.+}`
     - `/tags`
   - Does NOT proxy `/indexed`, `/query`, `/column-filter` (these have no legacy proxy fallback today; keep served by `query.ts`).
   - Proxies to `DATA_URL` (trim trailing slash) which must end with `/api`.
   - Forwards method, query string, and body for non-GET/HEAD.
   - Sets `Content-Type` from the incoming request when present, but does not forward arbitrary request headers (avoid credential leakage).
   - Returns upstream status + body and preserves upstream `Content-Type`.
2. Update `api/src/routes/data.ts`:
   - Compute `proxyMode = DATA_URL?.replace(/\/$/, \"\")?.endsWith(\"/api\")`.
   - If `proxyMode`, mount `dataProxyRoutes` plus `queryRoutes` (query endpoints are LanceDB-only and remain local).
   - Else, mount `catalogRoutes`, `viewsRoutes`, `graphRoutes`, `queryRoutes`.
   - Keep `export { getScopeMeta } from \"./dataShared.js\"` for `search.ts`.
3. Remove endpoint-local proxy fallback logic from:
   - `api/src/routes/catalog.ts`
   - `api/src/routes/views.ts`
   - `api/src/routes/graph.ts`
4. Remove now-dead helpers from `api/src/routes/dataShared.ts`:
   - Delete `proxyDataApi()` and `passthrough()`.
   - Keep `buildFileUrl()` behavior that supports `DATA_URL` ending with `/api` (it maps to `/files/...`).
5. Add `api/src/__tests__/data-proxy.test.ts` (node:test) to validate:
   - In proxy mode, requests are forwarded to an upstream HTTP server with correct path + query.
   - POST bodies are forwarded (e.g. `/indexed`).
   - Upstream 500 is propagated.
   - Upstream connection failure returns 502/503.
   - Non-proxy mode does not mount proxy routes.
6. Run:
   - `cd api && npm run typecheck`
   - `npx tsx --test api/src/__tests__/data-proxy.test.ts`

Acceptance checks:
- `rg \"proxyDataApi\\(|passthrough\\(\" api/src/routes` returns no hits.
- `rg \"isApiDataUrl\\(\" api/src/routes` has no hits outside `dataShared.ts`.
- `DATA_URL=http://upstream/api` causes `GET /api/datasets/foo/meta` to be a pure proxy (no local reads).
