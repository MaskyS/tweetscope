# Item 9 — Remove parquet serving fallback from TS API

Date: 2026-02-15

Problem:
Even after the serving cutover (no `DATA_URL=/api` proxy mode), the TS API still carries a parquet
read path via `loadParquetRows()` (HyParquet). This keeps a second storage contract alive, increases
cognitive branching (Arrow/parquet range reads + schema concerns), and complicates the serving model.

Goal:
Remove parquet reads from the TS Explore API runtime:
- Delete the cluster-label parquet endpoint (`/datasets/:dataset/clusters/:cluster/labels/:labelId`).
- Remove `loadParquetRows()` and the underlying HyParquet plumbing from `dataShared` storage helpers.
- Remove the `hyparquet` dependency from `api/package.json`.

Non-goals:
- Materializing `cluster_nodes` / label rows into LanceDB tables (tracked separately).
- Changing the primary LanceDB-backed view/graph/query endpoints.

---

## Plan

### Phase A — Remove the only parquet-backed route

In `api/src/routes/views.ts`:
- Remove `loadParquetRows` import.
- Delete the `labels/:labelId` route that reads `*.parquet` from `clusters/`.
- Keep `labels_available` (JSON-based) for now; it no longer has a paired parquet route.

In `web/src/api/catalogClient.ts`:
- Remove the unused `fetchClusterLabelsAvailable` / `fetchClusterLabels` helpers to avoid dead calls.

### Phase B — Remove parquet loader plumbing

In `api/src/routes/dataShared/storage.ts`:
- Delete `loadParquetRows()` and `asyncBufferFromLocalFile()` (and `hyparquet` imports).
- Clean up now-unused types/imports (`AsyncBuffer`, `Awaitable`, `createReadStream`, `stat`).

In `api/src/routes/dataShared.ts`:
- Stop exporting `loadParquetRows`.

In `api/package.json`:
- Remove `hyparquet` dependency.
- Run `npm -C api install` to update `api/package-lock.json`.

### Phase C — Validation

- `npm -C api run typecheck`
- `npm -C api run test`
- `npm -C web run production`

### Phase D — CC review + commit

1) CC reviews this plan.
2) Implement.
3) CC reviews diff for accidental behavior changes.
4) Commit.
