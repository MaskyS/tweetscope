# Item 7 — Decompose `api/src/routes/dataShared.ts` (reduce cognitive complexity)

Date: 2026-02-15

Problem:
`api/src/routes/dataShared.ts` centralizes multiple bounded contexts:
- environment config (`DATA_DIR`, `DATA_URL`, public dataset/scope)
- storage primitives (local file reads, remote file fetches, parquet reading)
- scope meta caching
- schema contract loading + validation
- SQL/query helpers (identifier/value escaping, filter where builder)
- row normalization/sorting helpers (index normalization, json-safe conversion)

This makes it hard to reason about changes and increases hidden coupling across route modules.

Goal:
Split `dataShared.ts` into small, explicit modules **without changing** the public exports used by
`catalog.ts`, `views.ts`, `graph.ts`, and `query.ts`.

Non-goals:
- Changing endpoint behavior or storage strategy
- Removing proxy mode / upstream proxy routes (handled in the serving cutover item)
- Reworking caching strategy or adding new caches

---

## Plan

### Phase A — Create focused modules

Add `api/src/routes/dataShared/` modules:
- `env.ts` — process env normalization and exported constants (`RAW_DATA_URL`, `DATA_DIR`, `PUBLIC_DATASET`, `PUBLIC_SCOPE`)
- `env.ts` also owns env-backed defaults (`resolveScopeId`, `resolveDataset`) and `expandHome()`
- `types.ts` — shared exported types (`JsonRecord`, `EdgeRow`, `NodeStatsRow`)
- `paths.ts` — safe path and URL helpers (`ensureSafeRelativePath`, `fileExists`, `buildFileUrl`)
- `contracts.ts` — scope-input contract load + validation (`scopeContract`, `validateRequiredColumns`)
- `sql.ts` — SQL-safe helpers (`sqlIdentifier`, `buildFilterWhere`, internal `sqlValue`/`sqlString`)
- `transforms.ts` — non-I/O helpers (`normalizeIndex`, `jsonSafe`, `ensureIndexInSelection`, `attachIndexFields`, `sortRows`)
- `storage.ts` — file/parquet loading + listing + scope meta cache (`loadJsonFile`, `loadParquetRows`, `listJsonObjects`, `listDatasetsFromDataDir`, `getScopeMeta`, `resolveLanceTableId`)

### Phase B — Convert `dataShared.ts` into a stable barrel

Keep `api/src/routes/dataShared.ts` as the *compat layer* and re-export all prior public symbols from
the new modules so existing imports (`./dataShared.js`) continue to work unchanged.

Important:
- Re-export `scopeContract` as a live binding (do not snapshot its value).

### Phase C — Validation

- `npm -C api run typecheck`
- `npm -C api run build`
- Ensure `api/src/lib/graphRepo.ts` still compiles (it imports from `../routes/dataShared.js`).
- Ensure `api/src/routes/*` compiles without import cycles.

### Phase D — CC review + commit

1) CC reviews this plan.
2) Implement the decomposition + barrel exports.
3) CC reviews the diff for accidental behavior changes.
4) Commit.
