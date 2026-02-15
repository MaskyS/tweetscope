# Item 8 — Serving cutover: remove API proxy mode (`DATA_URL` ending `/api`)

Date: 2026-02-15

Problem:
The TS Explore API currently supports a dual-mode serving topology:
- **Local mode**: serve catalog/views/graph/query from local files + LanceDB.
- **Proxy mode**: if `DATA_URL` ends with `/api`, `data.ts` routes most endpoints to `dataProxyRoutes`
  (an upstream API proxy), and `buildFileUrl()` also rewrites file fetches to `/api/files/...`.

This increases cognitive complexity (two serving stacks, divergent behavior) and keeps legacy API
paths alive in production.

Goal:
Hard-cutover to the local/LanceDB serving stack:
- Remove `dataProxyRoutes` and the proxy-mode branch in `api/src/routes/data.ts`.
- Simplify `buildFileUrl()` to assume `DATA_URL` points at a file base (not `/api`).
- If `DATA_URL` is configured as `/api`, fail fast with a clear error.

Non-goals:
- Changing the local file serving behavior (`LATENT_SCOPE_DATA`) or remote file fetching behavior (`DATA_URL`)
  when `DATA_URL` points at a file base (R2/CDN).
- Changing endpoint shapes.

---

## Plan

### Phase A — Remove proxy-mode routing

- Delete `api/src/routes/dataProxy.ts`.
- Update `api/src/routes/data.ts` to always register:
  - `catalogRoutes`, `viewsRoutes`, `graphRoutes`, `queryRoutes`
  - no `proxyMode` branching.
- Add an import-time guard in `data.ts`: throw if `DATA_URL` ends with `/api` (fail fast at startup).
- Replace `api/src/__tests__/data-proxy.test.ts` with cutover-focused tests:
  - importing `data.ts` with `DATA_URL=.../api` fails fast
  - importing `data.ts` with no `DATA_URL` still serves a basic endpoint (e.g. `/datasets` → 200)

### Phase B — Disallow `/api` DATA_URL for file fetches

In `api/src/routes/dataShared/paths.ts`:
- Remove `isApiDataUrl()` and `/files/` rewrite.
- `buildFileUrl()` assumes `DATA_URL` is a file base URL; misconfiguration is handled by the startup guard.

Update env docs:
- Update `api/.env.example`, `api/.env.vercel.demo.example`, `api/.env.vercel.hosted.example` comments to remove the legacy API upstream option.

### Phase C — Validation

- `rg -n \"dataProxyRoutes|proxyMode|endsWith\\(\\\"/api\\\"\\)\" api/src` shows only intentional guard text (no runtime proxy code).
- `npm -C api run typecheck`
- `npm -C api run build`
- Add `api/package.json` script: `\"test\": \"node --test dist/__tests__\"`
- `npm -C api run test`

### Phase D — CC review + commit

1) CC reviews this plan.
2) Implement cutover.
3) CC reviews diff for accidental behavior changes.
4) Commit.
