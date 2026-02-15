# Item 2 — View Tables + Serving Pivot (Milestone D) Plan

Date: 2026-02-15

Status:
- Initial implementation in progress (uncommitted at time of writing).
- CC review flagged local-only correctness risks + proxy-mode shape mismatches to fix before merging.

Problem:
Explore bootstrap is still anchored on “scope” artifacts and a multi-source ladder:
- TS API `views.ts` tries LanceDB (Cloud-only today) → falls back to `scope-input.parquet` → (historically) proxy fallbacks.
- Frontend fetch path is hard-coded to `/datasets/:dataset/scopes/:scope/parquet`.

This keeps multiple runtime contracts alive and forces engineers to reason about:
table-id vs scope-id vs parquet schema contracts.

Goal:
Introduce a **view-first serving surface** so Explore bootstrap can be:
`views/meta` + `views/rows|points` + `views/cluster-tree` from **local-first LanceDB** (and later Cloud) with one contract and *without parquet fallback* on the new endpoints.

Non-goals (for this item):
- Arrow IPC transport + payload budgeting (defer; start with JSON).
- Full “Scope → View” rename across the entire frontend/pipeline (defer; add compatibility aliases).
- Move query/search to Cloud-only (keep current behavior).

---

## Phase A — Contract + IDs (explicit)

Define the identity mapping and enforce it in one helper:

- URL param `:view` is the current human scope id (`scope.id`, e.g. `scopes-001`) for backwards compatibility.
- Canonical table id for the view data is `scope.lancedb_table_id` (often `{dataset}__{uuid}`), and must be opened local-first.

Implementation note: add a single resolver (TS) that returns the canonical `lancedb_table_id` from scope JSON (and later `scope_uid` if/when needed).
Pragmatic note: TS serving uses `lancedb_table_id` only for this milestone; `scope_uid` can be introduced later when the UI needs a stable non-human identifier.

---

## Phase B — Write-side (Python) minimal: view registry only

1. Do NOT duplicate scope rows into a new `__view_points` table (avoids double-storage).
   - Reuse the existing per-scope LanceDB table written by `export_lance.py`.
2. Optionally add `{dataset}__views` as a thin registry table (one row per view) for listing/views metadata.
   - Deferred in this item; serving relies on scope JSON + the existing per-scope table.

Acceptance checks:
- No additional large row tables are created beyond the existing per-scope table.
- (If registry is implemented) `{dataset}__views` exists and is idempotent.

---

## Phase C — Read-side serving (TS API)

1. Rename/generalize `getGraphTable` into a single local-first table opener that supports:
   - suffix form (`edges`, `node_stats`, `scope_uid`) → expands to `{dataset}__${suffix}`
   - full table id form (`{dataset}__{uuid}` or legacy `scopes-001`) → opens as-is
   This ensures `/views/*` endpoints can use local LanceDB without requiring `LANCEDB_URI`.
2. Add view endpoints in `api/src/routes/views.ts` (keep scope endpoints for compatibility):
   - `GET /datasets/:dataset/views/:view/meta` → returns view metadata (start by loading scope json).
   - `GET /datasets/:dataset/views/:view/rows` → returns current “scope parquet JSON” contract (same as existing `/scopes/:scope/parquet`).
   - `GET /datasets/:dataset/views/:view/cluster-tree` → returns `cluster_labels_lookup` (or table-backed nodes if present).
   - `GET /datasets/:dataset/views/:view/points` → returns minimal points payload by selecting columns from the existing per-scope table.
3. `/views/*` endpoints must NOT fall back to parquet; if the per-scope table is missing, return a typed 404.
4. Add the new `/views/*` endpoints to the proxy allowlist in `api/src/routes/dataProxy.ts` so proxy mode continues to work.

CC review notes (must address before commit):
- Canonicalize view table ids: `scope.lancedb_table_id` might be a UUID suffix; ensure handlers use one canonical id for table open + `getTableColumns()`.
- Remove redundant double-opens in `/views/:view/rows` and `/views/:view/points`.
- Don’t swallow errors: log underlying exceptions in the `/views/*` 404 paths.
- Proxy-mode shape: `/views/:view/cluster-tree` should return the reduced `{ hierarchical_labels, unknown_count, cluster_labels_lookup }` shape even when proxying.
  (Optional) `/views/:view/points` proxy should project columns (avoid returning full parquet rows).

Acceptance checks:
- In local mode (`LATENT_SCOPE_DATA` set, no `LANCEDB_URI`), `/views/:view/rows` and `/views/:view/points` serve from local LanceDB (no Cloud requirement).
- `/views/*` endpoints have no parquet fallback and return a typed 404 if the table is missing.

---

## Phase D — Frontend cutover (minimal)

1. Update `web/src/api/viewClient.ts`:
   - Switch `fetchScopeRows()` to call `/datasets/:dataset/views/:view/rows` (treat `scopeId` as `viewId` for now).
2. (Optional in this item) Add use of `/views/:view/points` for scatter-only components once stable.

Acceptance checks:
- Explore loads using the new `/views/:view/rows` endpoint (no behavioral change).

---

## Tests

- TS: add `api/src/__tests__/views-view-alias.test.ts` to ensure `/views/:view/rows` matches `/scopes/:scope/parquet` shape.
- Python: add a small unit-ish test for `materialize_view_tables` table creation (skip if LanceDB not available in CI; otherwise run locally).

---

Rollout notes:
- This item intentionally adds “view” endpoints as aliases first, then moves consumers.
- Once consumers move, we can delete “scope” serving routes and remove parquet fallback.
- Backfill: for older datasets, run `export_lance.py` (or the pipeline step that writes per-scope Lance tables) before switching consumers to `/views/*`.
