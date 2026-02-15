# Cognitive Complexity Reduction — Implementation Plan

Date: 2026-02-15

Goal: reduce cognitive complexity for engineers by removing distributed mode branching and hidden coupling (not cosmetic renames).

This plan is organized as 6 work items. Each item has: motivation, scope, steps, and acceptance checks.

---

## 1) Kill endpoint-local proxy fallback branching (P0)

### Motivation
Today many read endpoints include per-handler fallback chains:
`try primary -> catch -> if (isApiDataUrl()) proxyDataApi() -> else 404`.
This forces engineers to reason about multiple runtime modes inside each endpoint.

### Scope
- Keep **proxy capability** as a deployment option, but move the decision to app wiring.
- Remove per-endpoint use of:
  - `isApiDataUrl()`
  - `proxyDataApi()`
  - `passthrough()`
- Preserve existing non-proxy “file/CDN” fetch behavior for JSON/parquet artifacts (`loadJsonFile`, `loadParquetRows`).

### Steps
1. Add `api/src/routes/dataProxy.ts`:
   - Proxy only the **data surface** paths (avoid shadowing `/api/health`, `/api/version`, `/api/app-config`, `/api/resolve-url`):
     - `/datasets`, `/datasets/*`
     - `/files/*`
     - `/tags`
     - `/models/*`
     - `/indexed`, `/query`, `/column-filter`
   - Forwards method, headers, query string, and body for non-GET/HEAD.
2. Change `api/src/routes/data.ts` to choose **exactly one** route set at module init:
   - proxy mode (`DATA_URL` ends with `/api`) → mount `dataProxyRoutes` only
   - non-proxy mode → mount `catalogRoutes`, `viewsRoutes`, `graphRoutes`, `queryRoutes` as today
3. Delete endpoint-local proxy branches from:
   - `api/src/routes/graph.ts`
   - `api/src/routes/views.ts`
   - `api/src/routes/catalog.ts`
4. In `api/src/routes/dataShared.ts`:
   - keep the `/api`-aware file URL behavior inside `buildFileUrl()`
   - remove exports used only for endpoint-local proxy branching (`proxyDataApi`, `passthrough`, and exported `isApiDataUrl`)
5. Typecheck and run existing node:test suite(s).

### Acceptance checks
- `rg "proxyDataApi\\(|passthrough\\(" api/src/routes` returns no hits.
- `rg "isApiDataUrl\\(" api/src/routes` returns no hits outside `dataShared.ts` (internal helper is allowed).
- In proxy mode, `GET /api/datasets/:dataset/meta` is a pure proxy (no local reads).
- In non-proxy mode, behavior is unchanged except that proxy fallbacks are gone (404/empty instead of proxying).

---

## 2) Finish Milestone D: view tables + serving pivot (P0/P1)

### Motivation
Views bootstrap is currently “Lance-first but still scope-table + parquet fallback”. This keeps multiple serving contracts alive and makes it hard to reason about identity/versioning.

### Scope
- Introduce LanceDB tables:
  - `views`
  - `view_points` (materialized bootstrap payload)
  - `cluster_nodes` (hierarchical labels)
- Add view-specific endpoints (meta, points, cluster tree) and migrate frontend consumers.
- Remove `scope-input.parquet` as a runtime contract in hosted mode.

### Steps (high level)
1. Define table schemas (TS + Python writer side) and indexes.
2. Implement writer stage(s) to materialize view tables.
3. Add API routes:
   - `GET /datasets/:dataset/views/:viewId/meta`
   - `GET /datasets/:dataset/views/:viewId/cluster-tree`
   - `GET /datasets/:dataset/views/:viewId/points` (Arrow IPC preferred)
4. Switch web Explore bootstrap to new endpoints.
5. Remove parquet fallback from `api/src/routes/views.ts` production path.

### Acceptance checks
- Explore first render works with table-only backend.
- No production read path depends on `scope-input.parquet`.

---

## 3) Decompose `latentscope/scripts/scope.py` into pipeline stages (P1)

### Motivation
`scope()` (454 LOC) mixes metadata assembly, label transforms, parquet building, validation, and export side effects, which makes partial rebuilds and testing hard.

### Scope
- Create `latentscope/pipeline/stages/*` and move logic into stage functions.
- Keep CLI surface compatible (`ls-scope` / existing script entry) while delegating to stages.

### Steps (high level)
1. Create stage modules: `assemble_meta`, `build_points`, `materialize_scope_input`, `export_lance`.
2. Make `scope()` orchestration a thin composition layer.
3. Add unit tests around stage boundaries (where feasible).

### Acceptance checks
- Each stage can run independently (idempotent inputs/outputs).
- Stage modules are importable and testable without filesystem-heavy integration.

---

## 4) Split `latentscope/server/jobs.py` write surface (P1)

### Motivation
`jobs.py` (706 LOC) mixes policy, request parsing, shell command assembly, and job supervision; it is also security-sensitive (`shell=True`).

### Scope
- Move hosted ingest/import to TS API (`api/src/routes/import.ts`) + structured runner.
- Keep Flask endpoints studio-only as a transitional tool (or remove once TS path is complete).

### Steps (high level)
1. Add `api/src/routes/import.ts` for extracted-json upload and job submission.
2. Create a runner abstraction (no stringly `shell=True`; use argv arrays).
3. Replace stdout parsing with structured progress events or explicit artifacts.

### Acceptance checks
- Hosted mode no longer depends on Flask `jobs.py`.
- No `shell=True` in job execution path for user-controlled input.

---

## 5) Identity contract unification (record_id + view overlays) (P1/P2)

### Motivation
`ls_index` leaks across graph artifacts, API responses, and frontend enrichment, increasing coupling and making progressive subsets brittle.

### Scope
- Introduce canonical `record_id` for graph identity.
- Make view-local indices strictly scoped to `view_id` (optional overlay).
- Update graph endpoints and frontend thread/quotes to key on `record_id` first.

### Acceptance checks
- Frontend no longer needs “index repair/enrichment” logic to render thread/quotes.
- Edges/node-stats are not keyed by view-coupled indices.

---

## 6) Missing tests as a simplification enabler (P0)

### Motivation
We cannot safely remove fallbacks/contracts without a minimal regression suite.

### Scope
- Add unit tests for `validate_extracted_archive_payload`.
- Add endpoint tests for zip rejection (or at least handler-level unit tests if integration harness is absent).
- Add a lightweight incremental import equivalence test harness (year-by-year) if feasible.

### Acceptance checks
- CI/local runs catch payload contract regressions and policy regressions.
