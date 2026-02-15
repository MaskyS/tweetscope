# Refactor Plan: Twitter Knowledge Explorer

Last updated: 2026-02-15

## 1. Product Direction (Explicit)

Primary user value for this product:

1. Navigate all of a user archive (example: visakanv) quickly.
2. Learn via topic/cluster exploration first.
3. Traverse reply/quote relationships naturally (bidirectional in UX).
4. Use search as support, not the main mode.

Implications:

- This is not a generic latent-space workbench for end users.
- Model/UMAP/cluster knobs should remain opinionated and mostly hidden.
- The data/serving model should optimize graph + topic exploration latency, not maximal pipeline flexibility.

## 2. Hard Constraints

### 2.1 Privacy boundary (must enforce)

Hosted mode requirement: raw X archive zip must never reach the server.

Current client extractor already reads only:

- `data/tweets.js`
- `data/note-tweet.js`
- `data/like.js`
- `data/account.js`
- `data/profile.js`

(see `web/src/lib/twitterArchiveParser.js`).

Plan requirement:

- Keep this extraction in browser.
- Add server-side enforcement so hosted mode rejects raw zip uploads.
- Treat extracted payload version (`archive_format`) as a strict contract.

### 2.2 Multi-archive support

A user can own multiple archives/datasets. This must be first-class in routing, data model, and jobs.

### 2.3 Progressive operation

We need two progressive flows:

1. Progressive ingest/indexing (year-by-year or chunk-by-chunk build).
2. Progressive view builds (subset map builds for testing and demos).

## 3. Current State and Gaps

## 3.1 Current pipeline (as implemented)

`twitter_import -> ingest(input.parquet) -> embed -> dual UMAP -> cluster -> scope -> export_lance`

Links are built separately by `build_links_graph` from `input.parquet` and written to both flat files (`links/edges.parquet`, `links/node_link_stats.parquet`) and LanceDB tables (`{dataset}__edges`, `{dataset}__node_stats`) with BTREE/BITMAP indexes.

## 3.2 Link model gaps

Current builder (`latentscope/scripts/build_links_graph.py`) creates directed edges with `edge_kind` (`reply|quote`), deterministic `edge_id`, and `provenance` (`native_field|url_extract`) annotation.

- reply: `src_tweet_id -> in_reply_to_status_id` (provenance: `native_field`)
- quote: `src_tweet_id -> quoted_status_id` when present (provenance: `native_field`), falls back to URL parsing of `urls_json` (provenance: `url_extract`). Native field takes precedence via `seen_edges` dedup.

Remaining gaps:

1. UX "bidirectional" exists in API assembly, not data contract.
2. `ls_index` is still mixed into graph artifacts. It is scope/view-specific and unstable across progressive subsets. Edge identity uses `edge_id` (tweet-id-based hash) which is stable, but `src_ls_index`/`dst_ls_index` in parquet are still view-coupled.

Resolved:

- Edge provenance is now annotated on every edge (`provenance` column).
- Edge schema uses `edge_kind` (not `edge_type`) and `edge_id` (deterministic hash) per the target entity model.
- Browser extractor passes `quoted_status_id_str` and `conversation_id_str` through all three layers (JS extractor → Python flattener → edge builder). Native-field quote edges are now produced.

## 3.3 Serving model gaps — PARTIALLY RESOLVED

Resolved:
- Graph endpoints (`/links/*`) now read from LanceDB via `graphRepo.ts` repository abstraction. No in-memory parquet cache.
- Flask graph endpoints (thread, quotes, edges, node-stats) removed from `datasets.py`; Flask `datasets_bp` + `search_bp` registered only in studio mode.
- `views.ts` bootstrap tries LanceDB first, falls back to `scope-input.parquet`.
- Legacy TS API proxy mode removed: `DATA_URL` ending with `/api` is no longer supported (fail-fast at startup).

Remaining:
- Cluster/tree bootstrap still reads scope JSON artifacts (not yet in LanceDB `cluster_nodes` table).
- Views bootstrap still falls back to `scope-input.parquet` as a file-based checkpoint.
- `dataShared` utilities are decomposed into explicit modules, but storage policy still spans local files (`LATENT_SCOPE_DATA`) vs remote file-base fetch (`DATA_URL`).

## 3.4 Progressive import gaps

`twitter_import.py` now has `_upsert_import_rows()` which merges incoming rows into existing `input.parquet` by `id`, assigns stable `ls_index` values for new rows, and writes per-batch manifests to `imports/{batch_id}.json`. `build_links_graph.py` supports `--incremental` mode that recomputes only edges for changed tweet IDs.

Remaining gaps:

- Upsert still rewrites the full `input.parquet` on every import (O(n) file write, not O(delta)). This is the expected transitional state until LanceDB `merge_insert` replaces parquet as the record store.
- No explicit `dataset_version` — batch manifests track lineage, but there is no single version counter.
- Incremental import tests do not exist yet.

## 3.5 Cognitive complexity baseline (actual organization, 2026-02-11)

This baseline focuses on what makes engineering work hard: mental branching, hidden coupling, and policy spread.

### Baseline A: One file owns too many bounded contexts — RESOLVED

`api/src/routes/data.ts` was a 1,241-line monolith. Now split into domain modules: `catalog.ts` (141), `views.ts` (173), `graph.ts` (174), `query.ts` (202), plus `dataShared.ts` (barrel) + `routes/dataShared/*` (modules). `data.ts` is a 25-line thin router. New `graphRepo.ts` (222 LOC) provides repository-pattern LanceDB access for graph domain.

`dataShared` is decomposed into focused modules (`env`, `paths`, `storage`, `contracts`, `sql`, `transforms`) with a stable re-export surface (`dataShared.ts`) for route consumers.

### Baseline B: Per-request mode branching is high — PARTIALLY RESOLVED

The monolith split distributes mode branching across domain modules. The TS API no longer has an `/api` upstream proxy mode; remaining branching is primarily local files (`LATENT_SCOPE_DATA`) vs remote file-base fetch (`DATA_URL`), plus `views.ts` parquet fallback vs LanceDB.

### Baseline C: Contract multiplicity and translation churn — PARTIALLY RESOLVED

Identity and graph fields are translated in multiple layers:

- `scope.py` builds `ls_index` into scope artifacts (`latentscope/scripts/scope.py`)
- links artifacts store both tweet ids and scope indices (`latentscope/scripts/build_links_graph.py`)
- LanceDB graph tables use `-1` as null sentinel for `ls_index` (mapped back to `null` by `graphRepo.ts`)
- API re-normalizes index fields (now across domain modules in `api/src/routes/`)

Frontend translation layer reduced: `ScopeContext.jsx` deleted, `useNodeStats.ts` rewritten as strict server-contract consumer (98 LOC, no client-side graph recompute). `apiService.js` replaced by typed domain clients.

Remaining: pipeline-side `ls_index` multiplicity still exists (scope.py, build_links_graph.py). LanceDB graph tables carry `ls_index` alongside `tweet_id` for frontend compatibility. Resolves with LanceDB identity unification (Milestone D).

### Baseline D: Policy logic is split across UI + backend — RESOLVED

Privacy is now enforced at the server boundary:

- `jobs.py` rejects `source_type=zip` with HTTP 400 unconditionally.
- `jobs.py` validates all `community_json` uploads with `validate_extracted_archive_payload()` (strict `archive_format`, field presence, count consistency).
- `Home.jsx` always extracts in-browser; the privacy toggle is removed. The frontend cannot weaken the server-side policy.

### Baseline E: Orchestration and side effects are tightly coupled — PARTIALLY RESOLVED

Resolved:
- `export_lance` extracted from `scope.py` to standalone `export_lance.py` (84 LOC).
- `scope.py` no longer writes intermediate `{scope_id}.parquet` — goes straight to `-input.parquet`.
- `build_links_graph.py` graph builder functions already decomposed (`_build_edges_for_sources`, `_refresh_edge_targets`, `_build_node_stats_df`, `_canonicalize_edges_df`); now also writes to LanceDB tables as a side-effect of the build step.

Remaining:
- `scope()` in `latentscope/scripts/scope.py` (454 LOC) still performs metadata assembly, label-tree transformation, parquet generation, contract validation, and Lance export in one orchestration path.
- Jobs write API is now decomposed into focused modules (routes/store/runner/delete helpers) and job execution is hardened (argv execution, safe deletes), but write orchestration still runs in-process via threads (not a dedicated worker/service).

Why this matters:
- Hard to test stages independently.
- Hard to run partial rebuilds for progressive workflows without full pipeline side effects.

## 3.6 Complexity reduction targets (organization and cognition)

These targets are about lowering cognitive load and coupling, not just reducing file length.

### Target A: One request path, one data-source decision

For each production read endpoint:

- exactly one repository layer decides source-of-truth
- no endpoint-level legacy proxy fallback chain
- deployment mode resolved once in app wiring, not inside each handler

Acceptance check:
- tracing one request requires at most one mode decision and one storage contract.

### Target B: Bounded contexts become explicit modules

Split read serving by domain, not by arbitrary file size:

- `catalog` (dataset/scope metadata)
- `views` (points/cluster tree bootstrap)
- `graph` (neighbors/thread/quotes)
- `query` (indexed/query/filter/search)

Acceptance check:
- no module owns more than one product domain plus shared infra primitives.

### Target C: Identity contract unification

Define and enforce:

- `record_id` is the canonical graph identity
- view-local index (`ls_index` or equivalent) is scoped to `view_id`, never a global graph key
- edges and stats APIs are keyed by canonical identity first, with optional view overlays

Acceptance check:
- frontend does not need to guess/repair identity mappings across endpoints.

### Target D: Privacy policy centralized at server boundary

Hosted policy:

- raw zip upload rejected unconditionally by backend
- accepted payload contract is extracted/minimized archive JSON only
- UI can improve UX, but cannot weaken policy

Acceptance check:
- privacy guarantee holds even with a custom client.

### Target E: Stage-oriented pipeline composition

Refactor orchestration into explicit stage units:

- ingest/normalize
- records upsert
- edges build/upsert
- embed/update
- view build/materialization

Acceptance check:
- each stage can be run, tested, and rerun independently with deterministic idempotent inputs.

### Target F: Remove client-side semantic fallbacks

Examples to eliminate:

- recomputing node stats from raw edges in frontend fallback paths
- mutating cluster metadata objects during fetch/bootstrap in context providers

Acceptance check:
- frontend consumes stable server contracts and remains mostly declarative.

## 3.7 Before/After diagrams

### 3.7.1 Data serving topology (before — pre-domain-split)

```text
Browser
  -> TS API (`api/src/routes/data.ts`)
      -> scope JSON + scope-input.parquet (CDN/local files)
      -> links/*.parquet (full edge cache in API process)
      -> LanceDB table (only some routes: /indexed, /query, /column-filter, /search)
      -> legacy proxy mode (DATA_URL ending /api) for many endpoints (removed 2026-02-15)

Result:
- one request surface backed by mixed storage contracts
- endpoint behavior changes by mode/path
- graph semantics partly reconstructed in frontend fallbacks
```

### 3.7.1b Data serving topology (current — post-domain-split, pre-cutover)

```text
Browser
  -> TS API (domain modules: catalog/views/graph/query)
      -> graph.ts → graphRepo.ts → LanceDB local tables ({dataset}__edges, __node_stats)
         fallback: none (404 if links graph not present)
      -> views.ts → LanceDB scope table (via lancedb_table_id)
         fallback: scope-input.parquet from disk/CDN
      -> query.ts → LanceDB Cloud (vector search, filters)
      -> catalog.ts → scope JSON + meta JSON from disk/CDN (local files or DATA_URL file-base fetch)
  -> Flask (studio mode only)
      -> datasets_bp: scope parquet, cluster labels, embeddings list
      -> search_bp: vector search (studio only)
      -> NOT registered: graph/link endpoints (deleted from datasets.py)

Result:
- graph domain fully on LanceDB (primary path)
- views bootstrap LanceDB-first with file fallback
- no legacy API proxy mode in the TS API
- Flask no longer serves graph data; datasets_bp + search_bp gated to studio mode
```

### 3.7.2 Data serving topology (after, no backward-compat)

```text
Browser
  -> TS API (domain modules: catalog/views/graph/query)
      -> LanceDB tables as sole runtime source:
           records
           edges
           node_stats
           views
           view_points
           cluster_nodes
      -> optional export artifacts (parquet/json) are non-runtime

Result:
- one runtime data source
- one identity contract (`record_id`, `view_id`)
- no endpoint-local legacy fallback/proxy branching
```

### 3.7.3 Build pipeline (before — pre-refactor)

```text
twitter_import
  -> ingest(input.parquet)
  -> embed
  -> dual umap
  -> cluster
  -> scope (builds scope.json + scope.parquet + scope-input.parquet + export_lance inline)
  -> build_links_graph (separate links/*.parquet only)
```

### 3.7.3b Build pipeline (current)

```text
twitter_import
  -> ingest(input.parquet)
  -> embed
  -> dual umap
  -> cluster
  -> scope (builds scope.json + scope-input.parquet; calls export_lance.py)
     - no longer writes intermediate {scope_id}.parquet
     - export_lance.py extracted to standalone module (84 LOC)
  -> build_links_graph
     - writes links/*.parquet (backward compat)
     - writes LanceDB tables: {dataset}__edges, {dataset}__node_stats
       with BTREE indexes (src/dst_tweet_id, tweet_id, ls_index, thread_root_id)
       with BITMAP indexes (edge_kind, internal_target)
```

### 3.7.4 Build pipeline (after, staged + incremental)

```text
extract (client only)
  -> normalize/validate extracted payload
  -> upsert_records (LanceDB)
  -> upsert_edges (LanceDB)
  -> embed delta (only missing vectors)
  -> optional recompute node_stats
  -> build_view (view_points + cluster_nodes + view metadata)
  -> optional export bundle (for backup/debug only)
```

### 3.7.5 Deployment stack topology (before — pre-refactor)

```text
User Browser
  -> Vercel `web-demo` / `web-app` (React/Vite static app)
      -> Vercel `api-demo` / `api-app` (Hono Node functions, single data.ts monolith)
          -> DATA_URL (Cloudflare R2 custom domain, e.g. `https://data.maskys.com`)
             reads scope/input/links parquet + json artifacts
          -> LanceDB Cloud (subset of routes: indexed/query/filter/search)
          -> legacy API-proxy branch when DATA_URL points to `/api`
          -> optional local DATA_DIR in non-prod modes

Write/build path (separate):
  -> Flask jobs endpoints (`latentscope/server/jobs.py`)
      -> Python CLI pipeline (`twitter_import.py`, `scope.py`, `build_links_graph.py`)
      -> filesystem artifacts + LanceDB export
  -> Flask datasets_bp + search_bp (duplicate read endpoints)
```

Key implementation reality (before):
- runtime serving depends on both R2 artifact availability and LanceDB availability
- route behavior differs by env/mode (`DATA_DIR`, `DATA_URL`, proxy mode)
- Vercel API layer is not fully isolated from legacy serving compatibility branches
- Flask duplicated most TS API read endpoints for local dev

### 3.7.5b Deployment stack topology (current)

```text
User Browser
  -> Vercel `web-demo` / `web-app` (React/Vite static app)
      -> Vercel `api-demo` / `api-app` (Hono domain modules)
          catalog.ts  -> scope JSON + meta from disk/CDN (local files or DATA_URL file-base fetch)
          views.ts    -> LanceDB scope table (primary); parquet fallback (file-based checkpoint)
          graph.ts    -> graphRepo.ts -> LanceDB local tables (primary)
          query.ts    -> LanceDB Cloud (vector search, filters)
          -> optional local DATA_DIR (LATENT_SCOPE_DATA) for LanceDB local tables

Write/build path:
  -> Flask jobs endpoints (`latentscope/server/jobs.py`)
      -> Python CLI pipeline → filesystem artifacts + LanceDB local + optional Cloud export
  -> Flask datasets_bp + search_bp (studio mode ONLY, not production)
```

Key implementation reality (current):
- graph domain fully on LanceDB (no parquet edge cache in API process)
- views bootstrap LanceDB-first but still carries file-based checkpoints (`scope-input.parquet`)
- Flask graph endpoints deleted; Flask read blueprints gated to studio mode
- no legacy API proxy mode in the TS API (`DATA_URL` ending `/api` rejected at startup)

### 3.7.6 Deployment stack topology (after hard cutover)

```text
User Browser
  -> Vercel `web-demo` / `web-app`
      -> Vercel `api-demo` / `api-app` (domain routes: catalog/views/graph/query/import)
          -> LanceDB Cloud ONLY for runtime product reads

Async ingest/build workers (Python or TS worker runtime)
  -> validate extracted payload
  -> upsert records/edges/views into LanceDB Cloud
  -> optional export bundle writer -> Cloudflare R2 (non-runtime artifacts)

R2 role:
  -> downloadable exports / backup bundles / audit artifacts
  -> NOT required for core runtime query/graph/bootstrap paths
```

Key implementation reality (after):
- Vercel runtime has one authoritative data backend (LanceDB Cloud)
- Cloudflare R2 remains in stack but as distribution/backup plane, not live contract plane
- no endpoint-local fallback to legacy API/file contracts in production

## 3.8 Chesterton’s fence: why parquet exists today (and what changes)

Hard-cutover does not mean “delete everything old blindly.”  
This section records the original rationale for current artifacts so we only remove complexity after replacing the value they provided.

### Fence A: `input.parquet` as canonical ingest snapshot

Why it exists:
- stable, columnar, tool-agnostic snapshot between import and downstream Python steps
- easy reproducibility/debug (`re-run from one file`, no live DB dependency)
- cheap local iteration for batch scripts

What to keep:
- keep as pipeline checkpoint artifact (debug/replay)

What changes:
- no longer used by production read-serving
- canonical runtime source moves to Lance tables

Removal gate:
- production paths never read it directly
- rebuild/replay workflow verified from Lance + import batches

### Fence B: `scope-input.parquet` bootstrap file

Why it exists:
- one denormalized payload for frontend bootstrap (plot + metadata columns) with minimal API orchestration
- works with static hosting/CDN + hyparquet range reads
- decouples Explore bootstrap from DB query complexity

What to keep:
- the single-payload bootstrap pattern is correct and must be preserved

What changes:
- production bootstrap reads view metadata + **a single materialized response** containing all view_points from Lance-backed API
- the payload is not paged — at our data scale (10k-200k rows), the scatter plot needs all (x, y, cluster_id, record_id) coordinates to render the first frame, and paging would add round-trip latency without benefit

Payload budget analysis (200k rows, worst case):

| Format | Per-row fields | Raw size | Gzip/Brotli | Notes |
|---|---|---|---|---|
| JSON | x(f32), y(f32), cluster_id(i32), record_id(~20B str), label(~30B str), deleted(bool) | ~18 MB | ~3-4 MB | Highest decode overhead; verbose key repetition |
| Arrow IPC | same fields, columnar binary | ~6 MB | ~1.5-2.5 MB | Fast decode (zero-copy in browsers with Apache Arrow JS); columnar compression efficient |
| Current parquet | ~25 columns including text, urls, media | ~5-8 MB | N/A (already compressed) | Includes far more columns than needed for scatter render |

Decision: **Use Arrow IPC** for the points endpoint. It is columnar (compresses well), fast to decode (Arrow JS exists), and carries only the fields needed for first render. JSON is acceptable as a simpler fallback for small datasets (<20k rows).

Transport requirements:
- Brotli or gzip `Content-Encoding` is mandatory on this endpoint (reduces ~6MB → ~2MB)
- CDN cache with `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` keyed on `view_id` + view version
- Runtime envelopes (must be enforced in implementation + CI):
  - compressed payload target: <= 3 MB p95, hard cap 5 MB
  - uncompressed payload hard cap: 20 MB
  - handler wall-time target (warm path): <= 1.5s p95, hard timeout budget: 8s
  - API function peak memory target: <= 512 MB
  - if an endpoint response would exceed hard caps, return a typed error and require a smaller/filtered view build
- Deployment config requirements:
  - Vercel function timeout/memory must be explicitly configured to satisfy the above envelopes (no default-plan assumptions)
  - CI must run a payload-budget check on representative 200k-row views before release
- If benchmark shows 200k Arrow IPC exceeds p95 < 1.5s target on representative connections, fallback strategy is two-phase: (1) metadata + cluster tree first (instant render of empty map + tree), (2) points payload in background (scatter fills in). This is NOT paging — it is progressive hydration of a single view.

Removal gate:
- first-screen render meets latency/bytes targets with the Lance-backed single-payload endpoint
- frontend no longer depends on the parquet file specifically, but still gets all points in one fetch

### Fence C: `links/*.parquet` graph artifacts — RUNTIME DECOUPLED

Why it exists:
- simple graph snapshot from tweet export fields (reply/url links)
- easy debugging and offline inspection
- avoided introducing graph table design early

What to keep:
- optional debug/export snapshot for audits

What changed (2026-02-15):
- `build_links_graph.py` now writes to both parquet AND LanceDB tables (`{dataset}__edges`, `{dataset}__node_stats`)
- `graphRepo.ts` reads exclusively from LanceDB tables — no parquet reads in the graph serving path
- `graph.ts` routes use `graphRepo` as the only runtime data path (no legacy proxy fallback)
- Flask graph endpoints removed from `datasets.py`; `datasets_bp` is studio-only
- Parquet artifacts are now write-only from the graph build step; no runtime consumer in the TS API

Remaining removal gate:
- correctness + latency benchmarks on Lance-only path (section 10.5.1)

### Fence D: Flat file lineage (`embeddings/`, `umaps/`, `clusters/`, `scopes/`)

Why it exists:
- explicit intermediate artifacts make pipeline failures inspectable
- supports experimental iteration on one stage without a full system dependency
- keeps model/UMAP/cluster outputs auditable

What to keep:
- stage outputs as optional checkpoints for experimentation and audits

What changes:
- checkpoints are not a serving contract
- serving contracts are table-first and identity-stable

Removal gate:
- API and frontend can run entirely from table contracts in production
- checkpoints can be regenerated from canonical tables + batch metadata when needed

### Fence E: CDN-hosted parquet for demo serving

Why it exists:
- simple deployment: static files + TS API + range reads
- avoids early control-plane complexity

What to keep:
- export distribution path for low-ops demos and backups

What changes:
- hosted product runtime should not depend on file presence drift
- table contracts become authoritative for product behavior

Removal gate:
- hosted-mode SLOs are met with table-only runtime
- artifact sync failures cannot break core product routes

### Fence decision rule (applies to every legacy artifact)

Before removing a legacy artifact from runtime:
1. state the original value it provided,
2. identify the new mechanism replacing that value,
3. prove parity on correctness + latency + operability,
4. only then remove runtime coupling.

## 3.9 Code file architecture (before/after, cognitive complexity view)

This section maps responsibility at file level.  
Goal: reduce “how many files I must load in my head” for one product change.

### 3.9.1 File map (before — pre-domain-split)

```text
api/
  src/routes/data.ts                # catalog + scope parquet + links + query + files + legacy proxy mode
  src/routes/search.ts              # vector search route, scope/meta coupling
  src/lib/lancedb.ts                # LanceDB helpers

latentscope/server/
  app.py                            # Flask app + legacy read/write composition
  jobs.py                           # import API + job runner + command assembly + process management
  datasets.py/search.py/tags.py     # legacy serving/admin endpoints

latentscope/scripts/
  twitter_import.py                 # source parsing + filters + upsert/merge + pipeline orchestrator
  scope.py                          # scope metadata + label transforms + parquet builds + export_lance
  build_links_graph.py              # edge_kind/provenance/edge_id extraction + incremental rebuild + node stats

web/src/
  lib/apiService.js                 # all API calls (mixed old/new domains + external model APIs)
  contexts/ScopeContext.jsx         # bootstrap + cluster stats mutation + hierarchy build
  hooks/useNodeStats.js             # endpoint read + edge-derived fallback recomputation
  components/Home.jsx               # browser-only extract + upload (zip rejection is server-enforced)
```

### 3.9.1b File map (current — 2026-02-15)

```text
api/                                  # Production serving API (Hono, Vercel)
  src/routes/data.ts                  # thin router (25 LOC)
  src/routes/catalog.ts               # datasets/views metadata (141 LOC)
  src/routes/views.ts                 # points/bootstrap — LanceDB-first, parquet fallback (173 LOC)
  src/routes/graph.ts                 # neighbors/thread/quotes — LanceDB via graphRepo (174 LOC)
  src/routes/query.ts                 # indexed/query/filter/search (202 LOC)
  src/routes/dataShared.ts            # barrel re-export surface
  src/routes/dataShared/*             # env/paths/storage/contracts/sql/transforms modules
  src/lib/lancedb.ts                  # LanceDB connection + getLocalDb + getGraphTable (115+ LOC)
  src/lib/graphRepo.ts                # NEW: LanceGraphRepo — graph data access layer (222 LOC)
  src/__tests__/graph-parity.test.ts  # NEW: graph contract shape tests (206 LOC)
  src/__tests__/data-proxy.test.ts    # NEW: asserts proxy mode removed

web/src/                              # React frontend (Vite + Deck.GL, Vercel)
  api/{base,catalog,view,graph,query}Client.ts  # typed domain clients (replaces apiService.js)
  hooks/useNodeStats.ts               # strict server-contract consumer (98 LOC)
  components/Home.jsx                 # browser-only extract + upload

latentscope/server/                   # Python studio server (Flask)
  app.py                              # Flask app — datasets_bp + search_bp now studio-only
  jobs.py                             # facade (routes + runner split into modules; hardened job execution)
  datasets.py                         # -295 LOC: graph endpoints deleted, scope parquet + cluster labels remain (studio-only)

latentscope/scripts/                  # Python pipeline scripts
  twitter_import.py                   # (unchanged)
  scope.py                            # 454 LOC: export_lance extracted, intermediate parquet eliminated
  export_lance.py                     # NEW: extracted from scope.py (84 LOC)
  build_links_graph.py                # +68 LOC: now writes to LanceDB tables with indexes (731 LOC total)

tools/                                # Repo-level operational scripts (formerly scripts/)
  eval_hierarchy_labels.py            # pipeline eval + bakeoff comparison
  backfill_lancedb_table_id.py        # backfill scope JSONs with lancedb_table_id
  sync_cdn_r2.py                      # sync artifacts to Cloudflare R2
  validate_scope_artifacts.py         # scope artifact validation
  twitter/                            # twitter data utilities

contracts/                            # JSON schemas + shared type contracts
documentation/                        # docs, deploy guides, internal notes + plans
  notes/                              # planning docs (refactor-plan, deploy-file-plan, etc.)
  plans/                              # structured plans (repo-structure-plan)
experiments/                          # prototypes and scratch apps
  prototype/                          # carousel feed prototype (formerly prototype/)
```

### 3.9.2 Why this is cognitively expensive

Typical feature edits currently cross too many unrelated concerns:

1. Thread/quote behavior change:
   - `api/src/routes/data.ts`
   - `latentscope/scripts/build_links_graph.py`
   - `web/src/hooks/useThreadData.js`
   - `web/src/hooks/useNodeStats.js`
2. Import privacy/policy change:
   - `web/src/components/Home.jsx`
   - `latentscope/server/jobs.py`
   - `latentscope/scripts/twitter_import.py`
3. Bootstrap data contract change:
   - `latentscope/scripts/scope.py`
   - `api/src/routes/data.ts`
   - `web/src/contexts/ScopeContext.jsx`

This is exactly the kind of distributed coupling that drives cognitive complexity and regression risk.

### 3.9.3 Target file map (current state → remaining target)

```text
api/                                    # DONE: domain split + graph repository
  src/routes/data.ts                    #   DONE: thin router (25 LOC)
  src/routes/catalog.ts                 #   DONE: datasets/views metadata (141 LOC)
  src/routes/views.ts                   #   DONE: LanceDB-first bootstrap (173 LOC)
  src/routes/graph.ts                   #   DONE: LanceDB via graphRepo (174 LOC)
  src/routes/query.ts                   #   DONE: indexed/query/filter/search (202 LOC)
  src/routes/dataShared.ts              #   DONE: barrel exports over focused modules
  src/lib/lancedb.ts                    #   DONE: connection + local DB + graph table helpers
  src/lib/graphRepo.ts                  #   DONE: LanceGraphRepo repository (222 LOC)
  src/__tests__/graph-parity.test.ts    #   DONE: contract shape tests (206 LOC)
  src/routes/import.ts                  # TODO: extracted payload ingest entry
  src/contracts/*.ts                    # TODO: request/response + schema contracts (lower priority)

web/src/                                # DONE: domain clients + context cleanup
  api/baseClient.ts                     #   base URL + shared fetch (23 LOC)
  api/catalogClient.ts                  #   catalog domain (76 LOC)
  api/viewClient.ts                     #   view domain (25 LOC)
  api/graphClient.ts                    #   graph domain (34 LOC)
  api/queryClient.ts                    #   query domain (132 LOC)
  api/types.ts                          #   shared types
  hooks/useNodeStats.ts                 #   server-contract only (98 LOC)
  components/Home.jsx                   #   extracted-json-only upload path for hosted mode

latentscope/scripts/                    # Pipeline scripts (Python package)
  export_lance.py                       #   DONE: extracted from scope.py (84 LOC)
  build_links_graph.py                  #   DONE: writes to LanceDB + parquet (731 LOC)

latentscope/pipeline/                   # TODO: new package boundary for stage code
  stages/normalize.py
  stages/upsert_records.py
  stages/upsert_edges.py
  stages/embed_delta.py
  stages/recompute_node_stats.py
  stages/build_view.py
  io/export_bundle.py                   #   optional parquet/json exports only

tools/                                  # DONE: repo-level operational scripts (formerly scripts/)
  eval_hierarchy_labels.py              #   pipeline eval + bakeoff comparison
  backfill_lancedb_table_id.py          #   backfill scope JSONs with lancedb_table_id
  sync_cdn_r2.py                        #   sync artifacts to Cloudflare R2
  validate_scope_artifacts.py           #   scope artifact validation
  twitter/                              #   twitter data utilities

contracts/                              # JSON schemas + shared type contracts
documentation/                          # DONE: user docs, deploy guides, notes + plans
  notes/                                #   planning docs (refactor-plan, deploy-file-plan, etc.)
  plans/                                #   structured plans (repo-structure-plan)
experiments/                            # DONE: prototypes (formerly prototype/)
```

### 3.9.4 File action matrix (keep/rewrite/new/delete)

| File | Status | Notes |
|---|---|---|
| `api/src/routes/data.ts` | **DONE** — thin router (25 LOC) | Split into `catalog.ts` (141), `views.ts` (173), `graph.ts` (174), `query.ts` (202), `dataShared.ts` (504) |
| `api/src/routes/search.ts` | Merge into `query.ts` | Overlaps query/search contract logic |
| `api/src/routes/dataShared.ts` | **DONE** — reduced to 504 LOC | Graph helpers removed (`getEdges`, `getNodeStatsRows`, `getLinksMeta`); remaining: file I/O, proxy, SQL helpers |
| `api/src/lib/lancedb.ts` | **DONE** — expanded | Added `getLocalDb()`, `getGraphTable()` for local LanceDB access |
| `api/src/lib/graphRepo.ts` | **DONE** — new (222 LOC) | `LanceGraphRepo`: graph data access layer via LanceDB tables |
| `latentscope/server/app.py` | **DONE** — studio-only gating | `datasets_bp` + `search_bp` registered only when `APP_MODE == "studio"` |
| `latentscope/server/datasets.py` | **DONE** — studio-only, graph endpoints deleted | -295 LOC: all `/links/*` endpoints removed; scope parquet + cluster labels remain |
| `latentscope/server/search.py` | **DONE** — studio-only | Registered only when `APP_MODE == "studio"` |
| `latentscope/server/jobs.py` | Rewrite/split | Policy + orchestration + command assembly coupled → `import.ts` + pipeline runner |
| `latentscope/scripts/scope.py` | Partially done — decompose further | `export_lance` extracted, intermediate parquet eliminated; 454 LOC orchestration remains |
| `latentscope/scripts/export_lance.py` | **DONE** — new (84 LOC) | Extracted from scope.py; standalone LanceDB export function |
| `latentscope/scripts/build_links_graph.py` | **DONE** — LanceDB writer | +68 LOC: writes `{dataset}__edges` + `__node_stats` tables with indexed columns |
| `latentscope/scripts/twitter_import.py` | Split responsibilities | Import source parsing coupled to full pipeline run → ingest route + stage orchestrator |
| `web/src/lib/apiService.js` | **DONE** — deleted | Replaced by `web/src/api/{base,catalog,view,graph,query}Client.ts`; thin `.ts` re-export for legacy consumers |
| `web/src/contexts/ScopeContext.jsx` | **DONE** — deleted | Bootstrap/mutation/aggregation removed; consumers updated |
| `web/src/hooks/useNodeStats.js` | **DONE** — rewritten as `.ts` (98 LOC) | Was 201 LOC with client-side graph recompute; now strict server-contract consumer |
| `web/src/components/Home.jsx` | Rewrite branch logic | Hosted path enforces extracted-only source |
| `api/src/routes/resolve-url.ts` | Keep | URL resolution utility (62 LOC) |
| `api/src/lib/voyageai.ts` | Keep | Embedding client used by `query.ts` |
| `latentscope/server/admin.py` | Studio-only | Admin routes for local dev (353 LOC) |
| `latentscope/server/bulk.py` | Studio-only | Bulk operations (174 LOC) |
| `latentscope/server/models.py` | Studio-only | Model listing/config (102 LOC) |
| `latentscope/server/tags.py` | Studio-only | User tags (237 LOC); tags could become Lance column later |
| `web/src/hooks/useThreadData.js` | Rewrite | Currently couples to links parquet API shape → strict `graph.ts` consumer |
| `web/src/hooks/useCarouselData.js` | Keep + adapt | Updated to use domain clients |
| `web/src/components/Explore/V2/DeckGLScatter.jsx` | Keep + adapt | Update data contract to match `view_points` shape |
| `web/src/components/Explore/V2/Carousel/FeedCarousel.jsx` | Keep + adapt | Update data fetching to new API clients |
| `web/src/contexts/FilterContext.jsx` | Rewrite | 5 filter types tightly coupled to scope shape → adapt to view-based contracts |
| `web/src/lib/twitterArchiveParser.js` | **DONE** | `quoted_status_id_str`/`conversation_id_str` extraction added |
| `latentscope/scripts/toponymy_labels.py` | Keep | Cluster labeling with audit loop |
| `latentscope/scripts/cluster.py` | Keep | Clustering logic |
| `latentscope/scripts/embed.py` | Keep + adapt | Adapt for incremental-only embedding |

### 3.9.5 Deletion policy (important)

Two deletion classes:

1. Runtime deletion (P0/P1)
   - endpoint no longer reachable in hosted production
   - contract removed from frontend clients
2. Repository deletion (P2)
   - remove dead files only after:
     - traffic confirms no usage
     - benchmark and regression suites pass
     - rollback strategy no longer depends on old file paths

This avoids “delete now, rediscover hidden dependency later.”

## 4. Target Architecture (LanceDB-Primary)

## 4.1 Principle

Use LanceDB as source-of-truth for serving data and incremental updates. Keep flat files only for:

- pipeline checkpoints,
- optional export bundles,
- offline backup/debug.

## 4.2 Entity model

Separate stable identity from view-dependent rendering.

### Table: `records`

One row per canonical record.

Core columns:

- `dataset_id` (string)
- `record_id` (string, stable primary id; tweet id or synthetic like id)
- `record_type` (`tweet|note_tweet|like`)
- `created_at` (timestamp/string normalized)
- `text` (string)
- `username` (string nullable)
- `display_name` (string nullable)
- `reply_to_record_id` (string nullable)
- `quoted_record_id` (string nullable, when known from native fields)
- `urls_json` (json string)
- `media_urls_json` (json string)
- `lang` (string nullable)
- `favorites`, `retweets`, `replies` (ints)
- `archive_source` (string)
- `import_batch_id` (string)
- `deleted` (bool default false)
- `vector` (embedding vector)

Indexes:

- scalar BTREE: **`record_id`** (merge key for `merge_insert`), `dataset_id`, `created_at`
- scalar BITMAP: `record_type` (3 values), `deleted` (2 values)
- scalar/label: `username` (optional)
- FTS: `text`
- vector: `vector`

Note: `record_id` BTREE index is mandatory — `merge_insert` joins on this key, and LanceDB returns HTTP 400 when unindexed rows exceed 10,000 during merge operations.

### Table: `edges`

Graph relationships independent of view coordinates.

The parquet implementation (`links/edges.parquet`) already uses the target column names and schema version `links-v2`. The LanceDB table will mirror this schema with added `dataset_id` and `import_batch_id` columns.

Current parquet columns (implemented):

- `edge_id` (deterministic SHA-256 hash of `src|dst|kind|provenance`, first 16 hex chars)
- `edge_kind` (`reply|quote`)
- `src_tweet_id`, `dst_tweet_id`
- `src_ls_index`, `dst_ls_index` (nullable)
- `internal_target` (bool)
- `provenance` (`native_field|url_extract`)
- `source_url` (nullable)

Gotcha: the current `edge_id` hash does NOT include `dataset_id` because edges are per-dataset parquet files. When edges move to a shared LanceDB table, `dataset_id` must be added to the hash to ensure cross-dataset uniqueness.

Target LanceDB columns (adds to the above):

- `dataset_id`
- `src_record_id` (renamed from `src_tweet_id` for generality)
- `dst_record_id` (renamed from `dst_tweet_id`)
- `edge_kind` expands to (`reply|quote|tweet_link|mention_link`)
- `direction` (`forward`)
  Note: bidirectional traversal comes from querying incoming and outgoing edges; do not duplicate rows unless needed for performance.
- `import_batch_id`

Indexes:

- scalar BTREE: **`edge_id`** (merge key for `merge_insert`), `dataset_id`, `src_record_id`, `dst_record_id`
- scalar BITMAP: `edge_kind` (4 values), `is_internal_target` (2 values)

Note: `edge_id` BTREE index is mandatory for the same reason as `record_id` above. `src_record_id` and `dst_record_id` BTREE indexes are critical for graph traversal query performance.

### Table: `node_stats` (optional materialization)

Precomputed stats for fast UI badges:

- reply/quote in/out counts
- thread root/depth/size

This can be computed per view or globally; global preferred with optional view overlays.

### Table: `views`

Metadata for each map build.

Columns:

- `view_id` (primary)
- `dataset_id`
- `label`, `description`
- `build_mode` (`full|year_range|filtered_subset`)
- `filter_spec_json`
- `embedding_model`
- `umap_params_json`
- `cluster_params_json`
- `labeling_params_json`
- `created_at`
- `status`

### Table: `view_points`

Per-view projection/cluster assignment.

Columns:

- `view_id`
- `dataset_id`
- `record_id`
- `x`, `y`
- `cluster_id`
- `raw_cluster`
- `label` (optional denormalized)
- `deleted`

Indexes:

- scalar: `view_id`, `record_id`, `cluster_id`, `deleted`

### Table: `cluster_nodes` (hierarchical labels)

Per-view cluster tree.

Columns:

- `view_id`
- `cluster_id`
- `layer`
- `parent_cluster_id`
- `children_json`
- `label`
- `description`
- `topic_specificity`
- `count`
- `centroid_x`, `centroid_y`
- `hull_json`

## 4.3 Why this model works for progressive imports

### 4.3.1 Stable keys

- `record_id` is immutable identity.
- `ls_index` becomes an internal, derived concern in view computations only.

### 4.3.2 Incremental import behavior

- New import batches upsert into `records` and `edges`.
- Missing edge targets remain valid as external references (`is_internal_target=false`).
- Once target record arrives later, only `is_internal_target` / linkage metadata needs refresh.

### 4.3.3 What is actually incremental vs. full-rebuild (critical realism)

Progressive import does NOT mean everything is incremental. Here is the honest breakdown:

**Truly incremental (O(delta) work):**
- **Record ingest:** `merge_insert` new records into `records` table. Only new rows are written. Existing rows untouched.
- **Edge ingest:** `merge_insert` new edges. Existing edges untouched.
- **Embedding:** Only embed records with missing vectors (`WHERE vector IS NULL`). This is the biggest time savings — embedding is the most expensive per-record operation.
- **Node stats refresh:** Recompute only for records with new/changed edges (delta-aware).

**Full-rebuild required (O(n) on entire dataset/view subset):**
- **UMAP projection:** UMAP is a global manifold — adding 10k records to a 50k-record dataset changes EVERY point's (x, y) coordinates. There is no incremental UMAP. The entire view subset must be re-projected.
- **Clustering:** Cluster assignments depend on the full point cloud. Adding records changes cluster boundaries and composition. Full re-cluster is required.
- **Cluster labeling:** Labels depend on cluster membership, which changed. Full re-label is required.
- **View materialization:** `view_points` and `cluster_nodes` must be fully rewritten for the new projection.

**Implication for the user experience:**
- After importing a new year-chunk, the user gets new records and edges immediately visible (for individual record lookup, thread traversal, search).
- But the map/scatter/cluster view is stale until a view rebuild completes.
- View rebuild is O(n) and cannot be avoided. For 200k records, expect minutes (UMAP + cluster + label).

**Implication for the pipeline:**
- Import and view-build are decoupled stages. Import is fast (seconds-minutes). View-build is expensive (minutes).
- Multiple imports can accumulate before triggering a view rebuild.
- The system should clearly surface "view is stale, N new records since last build" state.

### 4.3.4 View invalidation semantics

When records are added to a dataset that has existing views:
- Existing views remain valid as snapshot projections of their original record subset. They do not become "wrong" — they are just incomplete.
- A view's `status` field should track: `current` (up-to-date with dataset), `stale` (dataset has newer records), `building` (rebuild in progress).
- The frontend should show stale state clearly: "This map was built from 50k records. 10k new records available. Rebuild?"

### 4.3.5 Progressive test mode

- `build_view` with `filter_spec_json: {"year_range": [2018, 2019]}` creates a view over a subset.
- This is useful for fast iteration: build a 5k-record view in seconds, test the UI, then build the full 200k-record view overnight.
- Each year-range view is independent — its own UMAP, clusters, labels. Not a progressive refinement of the same map.

## 5. Link Building Redesign (Twitter-native)

## 5.1 Extraction contract updates

Extend browser-minimized payload with explicit link semantics (still privacy-safe):

For tweets/note tweets include if present:

- `in_reply_to_status_id_str` — extracted by `twitterArchiveParser.js`
- `quoted_status_id_str` — extracted by `twitterArchiveParser.js`, flattened to `quoted_status_id` column in `input.parquet`
- `conversation_id_str` — extracted by `twitterArchiveParser.js`, flattened to `conversation_id` column in `input.parquet` (stored for future thread-root discovery, no edge-builder consumer yet)
- `entities.urls[]` (expanded) — extracted

## 5.2 Edge classification

Edge kinds with strict precedence:

1. `reply`: from `in_reply_to_status_id` field → `provenance: native_field`. Implemented.
2. `quote`: from `quoted_status_id` field → `provenance: native_field`. Implemented. Falls back to URL parsing → `provenance: url_extract` when native field is absent. Native field takes precedence via `seen_edges` dedup in `_build_edges_for_sources()`.
3. `tweet_link`: status URLs in text/entities not already captured as quote. Not yet implemented as a separate edge kind.
4. optional `mention_link`: user mentions (future; lower priority).

Provenance annotation is implemented on every edge (`provenance` column in `links/edges.parquet`).

## 5.3 Bidirectional UX without duplicate storage

For a target tweet T, UI/API should fetch:

- outgoing neighbors: `src_record_id = T`
- incoming neighbors: `dst_record_id = T`

This yields natural “replies to / replied by” and “quotes / quoted by” behavior.

If latency requires, we can add a materialized reverse-edge table later.

## 5.4 Thread model

Thread traversal should not depend only on one parent chain from a scoped subset.

Plan:

- compute/refresh thread metadata globally from full dataset edges
- allow view-local thread rendering via intersection with `view_points`
- optionally expose “outside current view” thread members as external context cards

## 6. API Surface (Target)

Keep TS API as primary serving layer.

### 6.1 Ingest/build

- `POST /api/import/extracted`
  - accepts only extracted payload contract in hosted mode
  - creates `import_batch_id`
- `POST /api/jobs/build-view`
  - params: `dataset_id`, optional `year_range`, optional filter spec
  - outputs `view_id`

### 6.2 Explore bootstrap

- `GET /api/datasets/:dataset_id/views`
- `GET /api/views/:view_id/meta`
- `GET /api/views/:view_id/cluster-tree`
- `GET /api/views/:view_id/points` — single materialized Arrow IPC response with all (x, y, cluster_id, record_id, label, deleted) tuples. Not paged. Requires Brotli/gzip transport compression. CDN-cacheable by view_id + version. See Fence B payload budget for size analysis.

### 6.3 Graph navigation

- `GET /api/datasets/:dataset_id/records/:record_id/neighbors?kinds=reply,quote&dir=in|out|both`
- `GET /api/datasets/:dataset_id/records/:record_id/thread`
- `GET /api/datasets/:dataset_id/records/:record_id/quotes`

### 6.4 Search/filter

- `POST /api/views/:view_id/search` (vector/fts/hybrid + filters)
- `POST /api/views/:view_id/filter-indices`

## 7. Pipeline and Job Orchestration

## 7.1 Stage graph

1. `extract` (client-side only)
2. `normalize` (server)
3. `upsert_records`
4. `build_edges`
5. `embed_records` (new/unembedded only)
6. optional `recompute_node_stats`
7. `build_view` (subset selection -> layout -> cluster -> labels -> view tables)

## 7.2 Idempotency and reruns

- Each stage keyed by `dataset_id + import_batch_id`.
- Use deterministic ids (`record_id`, `edge_id`) to avoid duplicates.
- Reruns should be safe and produce identical outputs for same input + params.

## 7.3 LanceDB/Lance operational requirements (docs-driven)

These are implementation constraints derived from current LanceDB/Lance docs and are now part of the architecture contract.

1. Upsert path must use indexed merge keys.
   - `merge_insert` performs a join on the `on` key; without scalar index this can force expensive scans.
   - Docs explicitly call out 400 failures when unindexed rows exceed thresholds for merge operations.
2. Scalar and FTS index builds are asynchronous.
   - API should gate readiness-sensitive flows (especially FTS/scalar-dependent queries) on index status (`wait_for_index` / explicit status checks).
3. Reindex/optimize cadence is mandatory for sustained latency.
   - During reindex windows, queries may hit brute-force on unindexed rows, increasing latency.
   - In OSS, schedule `optimize`; in Cloud, still monitor unindexed rows via stats APIs.
4. Vector index tuning should start from documented heuristics, then benchmark.
   - `num_partitions` baseline heuristic: roughly `num_rows / 8192`.
   - Query tuning starts with `nprobes` covering roughly 5–10% of partitions, then adjust with `refine_factor`.
5. FTS tokenizer settings must be Twitter-aware.
   - Set `max_token_length` deliberately to avoid URL/base64 noise dominating token space.
   - Enable phrase queries only when needed (`with_position=true`) due index size/runtime tradeoff.
6. Compaction/version hygiene must be first-class.
   - Lance versioning retains metadata per version; large version counts increase metadata overhead and can slow queries.
   - Periodic compaction and old-version retention policy are required, not optional.
7. Deletion semantics are soft-first.
   - Deletes remain recoverable by version until compaction/cleanup windows complete; privacy and retention policy must account for this.
8. Cloud consistency semantics must be validated with integration tests before hard cutover.
   - LanceDB docs pages currently describe consistency in multiple places; production assumptions should be based on explicit read-after-write tests in our environment.
9. Format stability policy: production uses stable Lance format only.
   - Do not use `next`/unstable format versions for production datasets.

## 7.4 Lance format: why this changes everything (deep dive)

This redesign depends on Lance as a **format**, not just LanceDB as an API. Understanding the format mechanics is what makes this architecture viable and what constrains our operational model.

### 7.4.1 Lance vs Parquet: the fundamental motivation

Lance was designed to solve Parquet's limitations for AI workloads (ref: [LanceDB FAQ](https://docs.lancedb.com/faq/faq-oss.md)):

| Property | Parquet | Lance |
|---|---|---|
| Random access | Row-group scan required; 10-100ms per lookup | Metadata-located pages; benchmarked at **up to 1000x faster** random access |
| Mutation | Immutable; full rewrite for any update | MVCC versioning; append/update/delete without full rewrite |
| Vector support | Bolt-on (stored as fixed-size binary lists) | First-class vector columns with native ANN index integration |
| Incremental indexing | Not supported (index is external) | Built-in incremental index maintenance via `optimize()` |
| Versioning | None (file is a snapshot) | Every write creates a new version; readers see consistent snapshots |

This is why we can replace the current "rebuild parquet artifacts on every pipeline run" model with "upsert records into Lance tables and incrementally maintain indexes."

### 7.4.2 Core format concepts

**Columnar fragments:**
- Data is divided into **fragments** — physical chunks that each contain a subset of rows across multiple column files.
- Each fragment is self-contained and immutable once written.
- This is what enables concurrent reads during writes: readers see the fragments in their version's manifest; writers create new fragments without touching existing ones.

**MVCC versioning:**
- Every write operation (insert, update, delete) creates a new **version** — an immutable manifest that references the current set of fragments + deletion files.
- This provides read isolation: a query in progress will not see concurrent writes.
- This is what enables safe incremental import: upsert a batch, readers continue serving the previous version until the new version commits.
- **Operational constraint:** Each version carries metadata overhead. 100 versions = 100x metadata, which degrades query performance. Version retention policy is mandatory.

**Soft deletion:**
- Deletes mark rows in a deletion file attached to the fragment, not physical removal.
- Rows remain recoverable by accessing older versions until compaction runs.
- Privacy implication: a "deleted" tweet is still physically present until compaction + version retention cleanup completes. LanceDB Cloud default retention is 30 days.

**Compaction (critical for sustained performance):**
- Merges small fragments into larger ones (reducing file-open and metadata overhead).
- Physically removes soft-deleted rows.
- Removes dropped columns.
- In LanceDB Cloud: automated background process.
- In OSS: manual `optimize()` call required.
- **Without compaction, query latency degrades as import batches accumulate.** This is not optional — it is a first-class operational requirement.

### 7.4.3 Storage architecture implications

LanceDB separates storage and compute (ref: [Storage Architecture](https://docs.lancedb.com/storage/index.md)):

| Backend | Latency profile | Our usage |
|---|---|---|
| Object storage (S3/R2) | Hundreds of ms p95 | Current R2 path; adequate for artifact distribution, not for runtime queries |
| LanceDB Cloud (managed) | Low ms (managed infra, strong consistency for readers) | **Target runtime backend** — eliminates storage backend management |
| Local NVMe | Sub-10ms p95 | Studio/dev only |

Consistency: LanceDB Cloud docs state strong consistency for readers (ref: [Consistency docs](https://docs.lancedb.com/tables/consistency.md)), meaning after a write commits, subsequent reads should see the new data. **However, this must be validated with read-after-write integration tests on our actual table patterns before cutover** (see 7.3 item 8). Docs-stated behavior is the hypothesis; measured behavior under our workload is the acceptance gate.

### 7.4.4 Index mechanics for our workload

**Scalar indexes** (ref: [Scalar Index docs](https://docs.lancedb.com/indexing/scalar-index.md)):
- BTREE: sorted column data for binary search. Best for `record_id`, `created_at`, `src_record_id`, `dst_record_id` — columns with many unique values.
- BITMAP: bitmaps for value presence. Best for `edge_kind` (4 values), `record_type` (3 values), `deleted` (2 values) — low cardinality.
- Both support: `<`, `=`, `>`, `in`, `between`, `is null` filters.
- **`merge_insert` requires scalar index on the join key.** Without it, merge_insert scans the entire column. Docs warn of HTTP 400 when unindexed rows exceed 10,000 during merge operations. This means we MUST create and maintain BTREE indexes on `record_id` and `edge_id` before any upsert workloads.

**Incremental reindexing** (ref: [Reindexing docs](https://docs.lancedb.com/indexing/reindexing.md)):
- After adding data, new rows are **not yet in the index** but still appear in query results via exhaustive/flat search on the unindexed portion.
- LanceDB Cloud automates background reindexing. In OSS, manual `optimize()` is required.
- `index_stats()` exposes `unindexed_rows` count — monitor this to detect index staleness.
- Use `fast_search=True` to search only indexed data when latency matters more than completeness during reindex windows.

**FTS index:**
- BM25-based full-text search on `text` column.
- **Does not support boolean operators (OR, AND) in search strings** — this limits keyword search expressiveness.
- Phrase queries require `with_position=True` which increases index size and build time.
- For our use case, vector search (Voyage embeddings → ANN) remains the primary search mode; FTS is a secondary "exact keyword" path.
- Twitter-specific: set `max_token_length` to filter URL/base64 noise, enable stemming for English.

**Vector index:**
- `num_partitions` heuristic: ~`num_rows / 8192`. For 200k records → ~24 partitions.
- Query tuning: start with `nprobes` covering 5-10% of partitions, adjust with `refine_factor` (5-50 range).
- For datasets under ~100k records, brute-force kNN is fast enough (<20ms for 100k × 1000-dim) and a vector index may not be necessary.

### 7.4.5 Data types for our entity model (ref: [Lance Data Types](https://lance.org/guide/data_types/))

Lance uses the full Apache Arrow type system. Our entity columns map to:

| Our column | Arrow/Lance type | Notes |
|---|---|---|
| `record_id`, `dataset_id`, `edge_id` | `Utf8` (string) | BTREE-indexable; tweet IDs are string-safe |
| `text` | `Utf8` | FTS-indexable; no length limit |
| `created_at` | `Timestamp` | BTREE-indexable for range queries |
| `favorites`, `retweets`, `replies` | `Int64` | Standard numeric; sortable |
| `deleted`, `is_internal_target` | `Boolean` | BITMAP index candidate (2 values) |
| `record_type` | `Utf8` | BITMAP index candidate (3 values: tweet/note_tweet/like) |
| `edge_kind` | `Utf8` | BITMAP index candidate (4 values: reply/quote/tweet_link/mention_link) |
| `urls_json`, `media_urls_json` | `Utf8` | Stored as JSON strings; no struct decomposition needed |
| `vector` | `FixedSizeList(Float32, dim)` | dim depends on embedding model (Voyage-4-lite = 512). Dimensions divisible by 8 enable SIMD optimization |
| `x`, `y` | `Float32` | UMAP coordinates for scatter plot |
| `cluster_id` | `Int32` or `Utf8` | BTREE or BITMAP depending on cardinality |
| `hull_json`, `children_json` | `Utf8` | JSON strings for complex nested data |

Key constraints from docs:
- Use `Float32` for embeddings (standard); `Float16` halves storage but may reduce recall.
- `FixedSizeList` is the recommended type for vector columns, not `List`.
- Struct columns are supported for nested data but **updating nested columns is not yet supported** — this is why we use JSON strings for `urls_json` etc. rather than native structs.

### 7.4.6 Schema evolution (ref: [Lance Data Evolution](https://lance.org/guide/data_evolution/))

Lance supports schema changes without full data rewrites:
- **Adding columns:** Metadata-only operation (fast); can backfill via SQL expressions or Python UDFs.
- **Dropping columns:** Metadata-only; physical removal requires `compact_files()` + `cleanup_old_versions()`.
- **Renaming columns:** Via `alter_columns()`, supports nested dot-notation.
- **Type casting:** Rewrites only the affected column, but **drops any index on that column**.

Critical constraint: **Schema changes conflict with most concurrent write operations.** Perform schema migrations when no import/upsert is running.

This matters for our progressive import model: if we need to add a column to `records` (e.g., a new metadata field from a future archive format), we can do it as a metadata-only operation without rebuilding the table. But we must coordinate with the import worker.

### 7.4.7 Concurrency model

- Concurrent reads scale horizontally — limited by storage backend throughput, not by Lance itself.
- Concurrent writes are supported but too many concurrent writers can cause commit failures (limited retry budget).
- Our model: **single writer (pipeline/import worker), many readers (API serving layer)** — this is the ideal pattern for Lance.

### 7.4.8 Why this means we can drop the parquet serving path

The current architecture serves from parquet because:
1. Parquet + CDN provides static-file simplicity (no database dependency)
2. LanceDB was introduced only for vector search endpoints

With Lance format providing:
- 1000x faster random access than Parquet
- MVCC for safe concurrent reads during imports
- Incremental index maintenance (no full rebuild)
- Strong read consistency in Cloud
- Native support for all our query patterns (vector, scalar filter, FTS)

...these format characteristics indicate that Lance should match or exceed parquet serving performance for all our workloads. **This is the hypothesis that benchmarks in Section 10.5.1 must confirm before cutover.** Parquet remains valuable as a pipeline checkpoint and export artifact, but should not be a production data source once benchmarks pass.

## 8. Cutover Strategy (No Backward Compatibility)

Given your explicit requirement, this is a hard cutover plan, not a migration-with-fallback plan.

## 8.0 Scope → View rename (atomic, codebase-wide)

Before any architectural work begins, rename "scope" to "view" everywhere in one atomic pass:

- Frontend: URL routes (`/explore/:dataset/:scope` → `/explore/:dataset/:view`), context names (`ScopeContext` → `ViewContext`), hook names, component props
- API: route parameters, response fields, variable names
- Pipeline: script names, function names, file artifact names (`scope.json` → `view.json`, `scope-input.parquet` → `view-input.parquet`)
- Data model: `scope_id` → `view_id` in all metadata JSON and table schemas

Why before, not during:
- Doing the rename mid-refactor creates confusion at every boundary where old and new terminology coexist.
- A pure rename PR is easy to review, easy to revert, and eliminates one axis of cognitive overhead from all subsequent work.
- The rename itself has zero semantic risk — it changes names, not behavior.

## 8.1 Build v2 contracts first (no dual runtime) — DONE

- Extracted payload schema versioning: `archive_format: x_native_extracted_v1` enforced by `validate_extracted_archive_payload()`.
- Hosted raw-zip rejection: `jobs.py` returns 400 for `source_type=zip`.
- Edge schema: `links-v2` with `edge_kind`, `edge_id`, `provenance` columns.

## 8.2 Build v2 serving on LanceDB as sole source

- Write `records`, `edges`, `node_stats`, `views`, `view_points`, `cluster_nodes` in LanceDB.
- Route graph/query/search endpoints directly to LanceDB tables (no `links/*.parquet` read path).
- Keep flat files only as optional export/debug outputs, not runtime dependencies.

## 8.3 Switch API/frontend contracts atomically

- Replace legacy route contracts with view/record/graph contracts in one release window.
- Remove endpoint-local legacy proxy/fallback branches from the production path.
- Remove frontend semantic fallbacks that recompute server contracts.

## 8.4 One-time dataset rebuild/backfill for canonical state

- Rebuild canonical tables from source archives/import batches once.
- Validate row counts, edge counts, cluster coverage, and representative query parity.
- Tag table versions pre/post cutover for fast rollback inside LanceDB (not legacy API rollback).

## 8.5 Decommission legacy paths

- Remove legacy `scope-input.parquet` and `links/*.parquet` runtime reads from API.
- ~~Remove hosted raw zip path (`source_type=zip`) from server-side import endpoint.~~ **DONE.**
- ~~Remove dead frontend toggles/branches that exist only for legacy ingestion path.~~ **DONE** (`processArchiveLocally` toggle removed).

## 8.6 Progressive import as first-class

- Add incremental import batches and view rebuild policies.
- Add year-range build UI for internal testing flow.
## 9. Progressive Import + View Policies

Need explicit policy decisions:

1. Cluster policy:
   - Option A: global clusters from full dataset; year is only a filter.
   - Option B: per-view clustering for each subset/year range.

Recommendation:

- Use both: global default for user consistency, plus optional subset views for testing and demos.

2. Likes behavior:

Decision: **Likes get their own separate map, not mixed with posted tweets. Likes visualization is post-launch.**

- Likes are ~80% of archive volume but dilute cluster quality when mixed with authored content.
- Likes are stored in `records` (same table, `record_type='like'`) from day one.
- Default `build_view` excludes likes: `record_type IN ('tweet', 'note_tweet')`.
- Likes-specific visualization (separate map, own UMAP/clusters/labels) is a post-launch feature. See `documentation/notes/likes-view-plan.md` for detailed implementation plan.

## 10. Testing and Validation Plan

## 10.1 Contract tests

- Extracted payload validator accepts only whitelisted shape.
- Hosted API rejects zip uploads.

## 10.2 Graph correctness tests

- Reply edges from native reply fields.
- Quote edges from native quote fields.
- URL-derived status links classified separately.
- Incoming/outgoing neighbor queries are symmetric and complete.

## 10.3 Progressive merge tests

- Import 2018 only -> validate counts.
- Import 2019 incremental -> ensure no duplicates, edges update correctly.
- Build views for 2018, then 2018-2019, then full; compare expected growth and connectivity.

## 10.4 Performance targets

Initial practical targets (to refine with benchmarks):

- Thread/quote panel fetch p95 < 400ms on 200k record dataset.
- Search p95 < 600ms for top-k query with filters.
- View bootstrap (meta + cluster tree + first page points) p95 < 1.5s.

## 10.5 Parquet vs Lance tables (workload comparison)

This is the comparison that matters for this product. Numbers below are directional expectations; final acceptance is from benchmark runs on target datasets.

| Workload | Current parquet/file path | Lance table path | Expected impact | Why |
|---|---|---|---|---|
| Thread panel load | API reads cached edges parquet and rebuilds traversal maps per request | Query `edges`/`node_stats` by `record_id` + edge kind + direction | Faster p95, lower CPU variance | Avoid per-request whole-edge scans and repeated in-memory graph reconstruction |
| Quote/reply neighbors | Filter in-memory edge arrays | Indexed `src_record_id`/`dst_record_id` lookups | Faster and more stable on large graphs | Scalar index prefilter instead of scanning loaded arrays |
| Explore bootstrap | Read scope metadata + large scope-input parquet payload | Read `views` + single materialized `view_points` response | Comparable or faster TTFI (no parquet decode overhead) | Single fetch preserved; format changes from parquet to JSON/Arrow IPC but pattern stays |
| Filtered retrieval | Mix of parquet bootstrap + Lance query endpoints | Single Lance query path | Lower contract overhead | Removes cross-store joins/re-normalization between files and table rows |
| Incremental import | Rebuild artifacts and keep file contracts aligned | `merge_insert` on indexed keys + incremental index maintenance | Record/edge/embedding ingest is incremental (O(delta)); view rebuild remains O(n) full-rebuild (UMAP + cluster + label) | No re-embed for existing records; but map projection must be fully recomputed |
| Deletes/privacy | Soft deletes in file-derived state, cleanup spread across artifacts | Soft delete + versioned table + explicit compaction/retention | More controllable but policy-critical | Lance versioning/deletion-file model is explicit; must manage retention windows |

### 10.5.1 Benchmark protocol (required before cutover)

Run this benchmark suite on `sheik-tweets` and `visakanv`:

1. `thread(record_id)` p50/p95/p99 and CPU per request
2. `neighbors(record_id, kinds=reply,quote, dir=both)` p50/p95
3. bootstrap payload bytes + first-render time
4. filtered query latency under concurrent reads
5. incremental year import time and post-import query latency
6. index freshness impact (`indexed_rows`, `unindexed_rows`, latency deltas)

Accept cutover only if Lance path meets p95 targets and has lower tail variance than parquet/file path.

## 11. Risks and Mitigations

1. Risk: table design drift and over-normalization increase query complexity.
   Mitigation: start with light denormalization in `view_points` (store display fields needed by UI).

2. Risk: link semantics still noisy due historical archive inconsistencies.
   Mitigation: provenance tagging + edge kind split + quality metrics dashboard.

3. Risk: hard-cutover regression without legacy fallback.
   Mitigation: pre-cutover replay tests + Lance table version tagging + rapid rollback to previous table version.

4. Risk: expensive full view rebuilds after each import batch.
   Mitigation: async rebuild queue + cheap subset builds for test loops.

## 12. Implementation Milestones (Execution-Ready)

### Milestone A: Privacy + contracts — DONE except tests

Implemented:
- Strict extracted payload validator (`validate_extracted_archive_payload` with `archive_format: x_native_extracted_v1`, field presence, count consistency).
- Server-side zip rejection (`jobs.py` returns 400 for `source_type=zip`).
- Frontend privacy toggle removed; always extracts in-browser.

Remaining:
- **Tests for acceptance/rejection paths.** The validator and zip rejection have zero test coverage. This is the top priority remaining item.

### Milestone B: Link model v2 — DONE (schema, LanceDB tables, serving)

Implemented:
- Edge schema: `edge_kind`, `edge_id` (deterministic hash), `provenance` columns. Schema version `links-v2`.
- Edge builder decomposed into single-responsibility functions (`_build_edges_for_sources`, `_refresh_edge_targets`, `_build_node_stats_df`, `_canonicalize_edges_df`).
- Incremental edge rebuild (`--incremental` + `--changed_tweet_id` flags).
- Browser extractor passes `quoted_status_id_str` and `conversation_id_str` through JS extractor → Python flattener → `input.parquet`.
- Native-field quote edges (`provenance: native_field`) produced by edge builder with precedence over URL-extracted quotes.
- **NEW (2026-02-15):** `build_links_graph.py` writes `{dataset}__edges` and `{dataset}__node_stats` LanceDB tables with BTREE/BITMAP indexes.
- **NEW:** `graphRepo.ts` (222 LOC) provides `LanceGraphRepo` — repository-pattern access to LanceDB graph tables.
- **NEW:** `graph.ts` routes use `lanceGraphRepo` as primary data source. Flask graph endpoints deleted from `datasets.py`.
- **NEW:** `dataShared.ts` cleaned of `getEdges`, `getNodeStatsRows`, `getLinksMeta` and their in-memory caches (-57 LOC).

Remaining:
- Add `tweet_link` as a separate edge kind for status URLs not captured as quotes.
- Remove legacy TS API proxy mode (`DATA_URL` ending `/api`). **DONE (2026-02-15)** — proxy routes removed; `DATA_URL=/api` rejected at startup.
- Graph correctness + latency benchmarks (section 10.5.1).

### Milestone C: Progressive import core — upsert done, tests remaining

Implemented:
- `_upsert_import_rows()` with id-based merge, stable `ls_index` assignment, per-batch manifests.
- `import_batch_id` threading through `twitter_import.py` and `jobs.py`.
- Incremental links rebuild wired into the import flow.

Remaining:
- **Incremental import tests (year-by-year).** No test coverage exists.

Gotcha: upsert currently rewrites full `input.parquet` on every import. This is O(n) for the write step — acceptable for now but must be replaced by LanceDB `merge_insert` in Milestone D.

### Milestone D: View tables + serving pivot — PARTIALLY STARTED

Implemented:
- `views.ts` now tries LanceDB first for scope parquet bootstrap (`resolveLanceTableId` → `getTable` → query columns), falls back to `scope-input.parquet`.
- `export_lance.py` extracted as standalone module (84 LOC); called from `scope.py` to write scope data to LanceDB.
- `scope.py` no longer writes intermediate `{scope_id}.parquet` — goes straight to `-input.parquet`.

Remaining:
- Materialize `views`, `view_points`, `cluster_nodes` as separate LanceDB tables (currently all data in one scope table).
- Add view-specific endpoints (view meta, cluster tree, points).
- Remove parquet fallback from `views.ts` production path.
- Remove legacy `scope-input.parquet` as runtime serving contract.

### Milestone E: Performance + cleanup (1 week)

- Add indexes and query tuning based on p95 metrics.
- Remove all runtime dependencies on flat files.
- Finalize exports as optional artifacts.

## 13. Complexity exit criteria (definition of done)

Do not mark this refactor complete until all are true:

1. Each production endpoint has one authoritative data-source decision and no endpoint-local legacy proxy fallback chain.
2. ~~Serving modules are split by domain boundary (`catalog`, `views`, `graph`, `query`) with no mixed-domain ownership in one module.~~ **DONE** — `data.ts` split into `catalog.ts`, `views.ts`, `graph.ts`, `query.ts`. Frontend clients split into `web/src/api/` by domain.
3. ~~Hosted import rejects raw zip by policy at API boundary.~~ **DONE** — `jobs.py` rejects `source_type=zip` with 400; `validate_extracted_archive_payload()` enforces contract on all uploads.
4. `scope()` orchestration is decomposed and independently testable by stage. *(Partially done: `export_lance` extracted, intermediate parquet eliminated. 454 LOC orchestration remains.)*
5. ~~Graph endpoints run on LanceDB edges/node-stats as primary data source.~~ **DONE** — `graphRepo.ts` reads from `{dataset}__edges` and `{dataset}__node_stats` LanceDB tables. Flask graph endpoints deleted.
6. Progressive import tests prove incremental equivalence against full import baselines.
7. Flat-file artifacts are explicitly classified as either bootstrap/export, not hidden runtime dependencies. *(Partially done: graph parquet is now write-only from build step, no TS API consumer. `scope-input.parquet` still consumed as fallback by `views.ts`.)*
8. ~~Frontend no longer recomputes core graph semantics as fallback for missing backend contracts.~~ **DONE** — `ScopeContext.jsx` deleted; `useNodeStats.ts` rewritten as strict server-contract consumer.

## 14. Immediate Next Steps

### P0: Structural prerequisites

1. **Scope → View rename** (Section 8.0) — pure terminology rename across frontend, API, and pipeline. Must happen before further structural refactoring.
2. **Tests for Milestone A** — validator acceptance/rejection, zip rejection endpoint, extracted payload round-trip. Contract gate with zero coverage.

### P1: File refactoring — DONE

All four P1 targets completed and committed:

- ~~Split `api/src/routes/data.ts`~~ → `catalog.ts`, `views.ts`, `graph.ts`, `query.ts`, `dataShared.ts`. Monolith is now a 25-line thin router.
- ~~Split `web/src/lib/apiService.js`~~ → `web/src/api/{base,catalog,view,graph,query}Client.ts` + `types.ts`. Thin `.ts` re-export for legacy consumers.
- ~~Rewrite `web/src/contexts/ScopeContext.jsx`~~ → deleted. Consumers updated.
- ~~Rewrite `web/src/hooks/useNodeStats.js`~~ → rewritten as `useNodeStats.ts` (98 LOC). Strict server-contract consumer.

### P1.5: Graph LanceDB pivot — DONE (2026-02-15)

Graph serving fully migrated to LanceDB as primary data source:

- ~~Write edges + node stats to LanceDB tables~~ → `build_links_graph.py` writes `{dataset}__edges`, `{dataset}__node_stats` with BTREE/BITMAP indexes.
- ~~Create graph repository abstraction~~ → `graphRepo.ts` (222 LOC) `LanceGraphRepo` class.
- ~~Switch graph.ts to LanceDB~~ → all 5 graph routes use `lanceGraphRepo` as primary.
- ~~Remove Flask graph endpoints~~ → deleted from `datasets.py` (-295 LOC).
- ~~Clean dataShared.ts graph helpers~~ → removed `getEdges`, `getNodeStatsRows`, `getLinksMeta` + caches (-57 LOC).
- ~~Gate Flask read blueprints~~ → `datasets_bp` + `search_bp` studio-only in `app.py`.
- ~~LanceDB-first views bootstrap~~ → `views.ts` tries LanceDB scope table before parquet fallback.
- ~~Extract export_lance~~ → standalone `export_lance.py` (84 LOC).
- ~~Eliminate intermediate parquet~~ → `scope.py` no longer writes `{scope_id}.parquet`.

Net impact: **-35 lines of real code**, -295 lines of Flask graph duplication, graph domain fully on LanceDB.

### P2: Pipeline decomposition (next)

3. **Decompose `latentscope/scripts/scope.py`** (454 LOC) — metadata assembly, label-tree transforms, parquet builds, and Lance export in one path. Split into stage modules under `latentscope/pipeline/stages/` (Target E).
4. **Split `latentscope/server/jobs.py` (architecture)** — routes/runner have been decomposed and hardened (argv + safe deletes), but moving write orchestration into a dedicated service (`api/src/routes/import.ts` + pipeline runner) remains.
5. **Split `latentscope/scripts/twitter_import.py`** — import source parsing coupled to full pipeline run. Separate ingest route from stage orchestrator.

### P3: Validation

6. **Incremental import tests** — import 2018 only, then 2019 incremental, verify no duplicates, verify edge counts, verify batch manifests.
7. **Graph correctness tests** — reply/quote edge provenance, thread traversal, bidirectional neighbor symmetry. Shape tests exist (`graph-parity.test.ts`); functional/integration tests needed.

### P4: Hard cutover prerequisites

8. ~~Remove proxy fallback chains~~ — **DONE** — TS API no longer supports `DATA_URL` ending with `/api`; upstream proxy routes removed; `buildFileUrl()` assumes `DATA_URL` is a file base URL.
9. **Benchmark Lance vs parquet** (section 10.5.1) — p95 latency validation on `sheik-tweets` and `visakanv` datasets.
10. ~~Decompose `dataShared.ts`~~ — **DONE** — split into `routes/dataShared/{env,paths,storage,contracts,sql,transforms,types}.ts` with a stable `dataShared.ts` barrel.

## 15. Lance/LanceDB docs used for constraints

### LanceDB (database layer)
- `merge_insert`/upsert behavior and unindexed-row 10k limit: https://docs.lancedb.com/tables/update.md
- Scalar indexes (BTREE, BITMAP, LABEL_LIST) and query optimization: https://docs.lancedb.com/indexing/scalar-index.md
- Vector indexing/tuning heuristics (`num_partitions`, `nprobes`, `refine_factor`): https://docs.lancedb.com/indexing/vector-index.md
- FTS options (`max_token_length`, `with_position`, no boolean operators): https://docs.lancedb.com/search/full-text-search.md
- Hybrid search behavior and reranking context: https://docs.lancedb.com/search/hybrid-search.md
- Incremental reindexing and `optimize()`: https://docs.lancedb.com/indexing/reindexing.md
- Index readiness and async build behavior: https://docs.lancedb.com/indexing/index.md
- Consistency model (Cloud docs state strong consistency; must validate): https://docs.lancedb.com/tables/consistency.md
- Storage architecture (S3/R2 vs local vs Cloud): https://docs.lancedb.com/storage/index.md
- OSS FAQ (Lance vs Parquet, 1000x random access, concurrency, dataset scale): https://docs.lancedb.com/faq/faq-oss.md

### Lance (format layer)
- Format overview (columnar fragments, MVCC versioning, compaction, soft deletion): https://docs.lancedb.com/lance.md
- Data types (Arrow type system, FixedSizeList for vectors, Blob for large objects): https://lance.org/guide/data_types/
- Schema evolution (add/drop/rename columns, type casting, concurrency constraints): https://lance.org/guide/data_evolution/
- Table format specification: https://lance.org/format/
- Table versioning model: https://lance.org/format/#versioning
