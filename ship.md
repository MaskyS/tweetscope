# Ship Plan: visakanv Demo + Production Path

Date: February 8, 2026

## 1. Goal
Ship a public demo that shows only `visakanv` posted tweets in Explore (no visible `/import` route in deploy), while keeping local/studio import workflows for continued development toward multi-user tweets + likes.

## 2. Current State (Code Audit)

### What already works
- App mode switching exists in backend and frontend:
  - `studio`, `hosted`, `single_profile` in `latentscope/server/app.py`.
  - Frontend route lock for single profile in `web/src/App.jsx`.
- In `single_profile`, write blueprints are disabled by `READ_ONLY`, so import endpoints are not active.
- Scope creation exports LanceDB tables for semantic NN search (`latentscope/scripts/scope.py`).
- Community archive `like`/`likes` mismatch is fixed in importer.
- Scope data served as direct parquet via hyparquet (column-selective, no server-side pandas/JSON).
- Search cache key bug fixed in `search.py`.

### Critical findings to address
1. “Entirety” of posted tweets is not fully normalized yet.
- Raw community import still does not normalize `note-tweet` / `community-tweet` in `load_community_archive_raw`.

2. Browser memory/load path is a major bottleneck at visakanv scale.
- Client fetches full scope rows at mount and builds large in-memory structures (`web/src/contexts/FilterContext.jsx`).

5. Known ScopeContext mutation bug is still live.
- `scope.cluster_labels_lookup` is mutated directly during `fetchScopeRows` with TODO noted in code; can inflate counts on re-fetch.

6. Initial load errors are not user-visible.
- Scope fetch failures are only logged to console; UI can appear blank without actionable error state.

8. Security baseline gaps remain.
- Job execution uses `subprocess.Popen(..., shell=True)` in write mode; mitigated in single-profile but unsafe for broader hosted/studio modes.

10. Architecture boundary is single-server demo only.
- Current filesystem storage model (`input.parquet`, `scopes`, `lancedb`, jobs JSON, tags files) is acceptable for one read-only demo server, not a scalable production baseline.

12. Cluster filtering has no index — O(n) scan on every filter.
- `useClusterFilter.js:8` runs `scopeRows.filter(d => d.cluster === cluster.cluster)` — full 259k-row linear scan per cluster click.
- Trivially fixable with a pre-built `Map<clusterId, ls_index[]>` at load time.

13. Label placement runs O(n^2) collision detection on every zoom/pan.
- `DeckGLScatter.jsx:766-771`: each of up to 1500 labels checks against all previously placed labels (~1.1M collision checks worst case).
- This is a `useMemo` dependency of `controlledViewState`, so it triggers on every zoom/pan frame.

14. Search requires VoyageAI API key in deploy env.
- Embedding model is VoyageAI (cloud API). Needs `VOYAGE_API_KEY` at query time to embed search queries in TS API.

15. Carousel fetches data that already exists in ScopeContext.
- `useCarouselData.js:108` makes HTTP requests for tweet rows via `fetchDataFromIndices`, creating object copies of data already in `scopeRows`.
- Minor memory impact but a design smell for the data flow.

## 3. visakanv Archive Reality Check (validated)
Using the current community archive blob URL for `visakanv`:
- Raw archive size: `498,124,170` bytes (~498MB)
- `tweets`: `259,083`
- `like`: `533,890`
- `note-tweet`: `362`
- `community-tweet`: `109`

Implication for this demo:
- Use tweets-only import (`--exclude_likes`) per requirement.
- Still add `note-tweet` / `community-tweet` normalization soon to truly include all posted tweet types.

## 4. Demo Ship Plan (Concrete)

### 4.1 Build/import dataset locally (tweets only)
```bash
ls-twitter-import visakanv \
  --source community \
  --username visakanv \
  --exclude_likes \
  --run_pipeline
```

### 4.2 Deploy target (decided)

Split architecture. No persistent disk needed — all state lives in LanceDB Cloud, object storage, and Postgres.

| Layer | Platform | Cost |
|---|---|---|
| Frontend (static) | Vercel or Cloudflare Pages | Free |
| Data files (parquet, metadata JSON) | Cloudflare R2 or S3 | ~$0.015/GB-month |
| Serving API (TS) | Vercel Functions or Cloudflare Workers | Free–$20/mo |
| Vector search | LanceDB Cloud | Usage-based ($100 free credit) |
| Pipeline compute | Modal | Pay-per-second |

See section 5.4 for full architecture details.

### 4.3 Deploy app mode and runtime env
Set API service env:
```bash
LATENT_SCOPE_APP_MODE=single_profile
LATENT_SCOPE_PUBLIC_DATASET=visakanv
LATENT_SCOPE_PUBLIC_SCOPE=scopes-001
LATENT_SCOPE_READ_ONLY=1
```

Expected behavior:
- `/` redirects to `/datasets/visakanv/explore/scopes-001`
- `/import` is not reachable from routing
- write blueprints are not registered

### 4.4 Phase 0 go-live checklist (must do before public demo)

**Bug fixes:**
1. Fix `ScopeContext` mutation bug — avoid mutating `scope.cluster_labels_lookup` directly; use a fresh object (`web/src/contexts/ScopeContext.jsx:229`).
2. Add visible load-error/empty state for scope fetch failures.

**Performance:**
3. Pre-build cluster index (`Map<clusterId, ls_index[]>`) in ScopeContext to eliminate O(259k) scan per cluster filter.
4. Debounce or cache label placement in DeckGLScatter to prevent frame drops during pan/zoom (~1.1M collision checks per frame currently).

**Data + deploy:**
5. Upload visakanv scope parquet + metadata JSON to R2/S3.
6. Upload visakanv LanceDB table to LanceDB Cloud (`db://tweetscope-mwyfv0`).
7. Update `web/src/lib/apiService.js` to point at TS API + CDN for static data.
8. Deploy frontend to Vercel/Cloudflare Pages.
9. Deploy TS API to Vercel Functions/Cloudflare Workers.
10. Set env: `VOYAGE_API_KEY`, `LANCEDB_API_KEY`, `LANCEDB_URI`.

## 5. Production Implementation Matrix (with options)

## 5.1 Ingestion correctness (tweets + likes + note/community tweet)
What must be implemented:
- Normalize `note-tweet` and `community-tweet` from community raw archive.
- Add explicit schema versioning for imported records.

Options:
1. Minimal patch in existing importer (recommended).
- Extend flatteners in `latentscope/importers/twitter.py`.
- Fastest, lowest effort. The 3 source paths are already well-separated as functions (`load_native_x_archive_zip`, `load_community_archive_raw`, `load_community_extracted_json`).
2. Source-adapter layer.
- Create adapters per source with contract tests.
- Premature for one dataset imported once; revisit when adding a new source type (e.g., Bluesky, Mastodon).
3. External ETL microservice.
- Separate normalization service that outputs canonical parquet/jsonl.
- Best scalability, highest complexity.

Recommendation: Option 1. Source adapters (Option 2) make sense when a second source type is actually needed.

### 5.2 Semantic search / retrieval

#### Current LanceDB state
Each scope exports one LanceDB table with:
- All input columns (text, metadata, engagement)
- Scope geometry: `x`, `y`, `cluster`, `label`, `deleted`, `ls_index`, `tile_index_*`
- Dense embedding: `vector`
- Optional SAE: `sae_indices` (list[int]), `sae_acts` (list[float])

Indexes created:
- ANN vector index on `vector` (cosine)
- Scalar BTREE on `cluster`
- Scalar LABEL_LIST on `sae_indices` (SAE scopes only)

Current request paths in TS API:
- `GET /api/search/nn` for semantic NN search (`deleted = false` filter applied).
- `POST /api/indexed`, `POST /api/query`, `POST /api/column-filter` served from LanceDB table queries.

#### Queries we want next
1. **Filtered vector search in DB** — push `deleted=false`, `cluster in (...)`, `created_at` range, tweet type flags into LanceDB query instead of client post-filter.
2. **Feature-constrained semantic search** — vector similarity + `sae_indices contains <feature_id>` (uses existing LABEL_LIST index).
3. **Hybrid retrieval** — vector + lexical/full-text + metadata filters.
4. **Stable pagination/top-K** — deterministic windowing instead of fixed `limit(100)` server → `slice(20)` client.

#### Decision: LanceDB Cloud
LanceDB Cloud (serverless, `db://tweetscope-mwyfv0`) is the vector DB for demo and production. Credentials stored in `.env` (`LANCEDB_API_KEY`, `LANCEDB_URI`).

Next steps: upgrade query pushdown (filtered ANN, feature constraints, server-side pagination, hybrid retrieval).

## 5.3 Pipeline orchestration: Modal

#### Decision: Modal for all pipeline compute

The data pipeline (import → embed → UMAP → cluster → toponymy → scope) runs as Modal serverless functions. Scripts stay Python — the ML dependencies (umap-learn, hdbscan, toponymy, torch, scipy) have no JS equivalents and don't need one.

#### Twitter pipeline on Modal

| Step | Bound by | Est. duration (259k tweets) | Modal resource |
|---|---|---|---|
| Fetch community archive | Network (~500MB) | ~30s | CPU |
| Normalize tweets | CPU (pandas) | ~10s | CPU |
| Embed via VoyageAI API | I/O (API rate limits) | ~15-30 min | CPU (API-bound) |
| UMAP reduction | CPU (numpy/scipy) | ~5-10 min | CPU (memory) |
| HDBSCAN clustering | CPU | ~1-2 min | CPU |
| Toponymy labeling | I/O (LLM API) | ~5-10 min | CPU (API-bound) |
| Scope assembly + LanceDB Cloud export | CPU + network | ~3-5 min | CPU |

Total: ~30-60 min async per user import.

#### What changes in the scripts

The pipeline logic (`latentscope/scripts/`, `latentscope/importers/twitter.py`) stays as-is. Changes are:

1. **Entrypoint**: CLI `ls-twitter-import` → Modal `@app.function` that calls the same code.
2. **Output destination**: Final artifacts write to object storage (R2/S3) + LanceDB Cloud instead of local `DATA_DIR/`.
3. **Progress reporting**: Instead of stdout markers (`RUNNING:`, `FINAL_SCOPE:`), emit to job status DB or webhook to the TS serving API.
4. **Intermediate files**: Modal Volume (ephemeral, cleaned up after job) instead of local disk.
5. **Triggering**: TS serving API receives user request → creates job record → calls Modal function via webhook/SDK.

#### Multi-user ingestion flow

```
User clicks "Import my archive"
        ↓
TS Serving API (Vercel/Cloudflare)
  → Validates request + auth
  → Creates job record in DB
  → Triggers Modal function
        ↓
Modal (serverless Python container)
  → Fetches community archive (or accepts uploaded ZIP URL)
  → Runs: normalize → embed (VoyageAI) → UMAP → HDBSCAN → toponymy → scope
  → Intermediate files on Modal Volume (ephemeral)
  → Final outputs:
      • scope parquet + metadata JSON → R2/S3
      • vector table → LanceDB Cloud (db://tweetscope-mwyfv0)
  → Updates job status via webhook/DB
        ↓
User gets notified, scope is live
```

#### Scripts NOT relevant to Twitter pipeline (OG latent-scope)
These exist in the repo but are not part of the Twitter product path:
- `ls-ingest` — generic CSV/JSON/XLSX file upload (Twitter import handles its own ingestion)
- `ls-sae` — Sparse Autoencoders (optional research feature, not core)
- `ls-download-dataset` / `ls-upload-dataset` — HuggingFace Hub sync
- `ls-label` — flat LLM cluster labeling (superseded by toponymy for Twitter)
- `ls-embed-debug`, `ls-embed-truncate` — embedding utilities

## 5.4 Deployment topology

#### Decision: Split architecture with TS serving API

| Layer | Technology | Hosts | Cost |
|---|---|---|---|
| **Frontend (static)** | Vite build → Vercel or Cloudflare Pages | CDN, global | Free tier |
| **Data files** | Scope parquet, metadata JSON → R2 or S3 | Object storage, served directly to browser via hyparquet | ~$0.015/GB-month |
| **Serving API** | TypeScript (Hono or Express) | Vercel Functions or Cloudflare Workers | Free–$20/mo |
| **Vector DB** | LanceDB Cloud | Managed | Usage-based ($100 free credit) |
| **Pipeline compute** | Modal (Python) | Serverless containers | Pay-per-second |
| **Job/user state** | Postgres (Neon or Supabase) | Managed | Free tier |

The Flask backend (`latentscope/server/`) is replaced by a thin TS API for serving. Python stays for pipeline scripts on Modal only.

### 5.4.1 TS Serving API — what it replaces

The TS API now covers the read-only serving surface used by Explore. Python server routes remain for local/studio write workflows only (import/jobs/admin).

#### Search → TS + LanceDB Cloud SDK + VoyageAI REST

Implemented: TS function calls VoyageAI REST API to embed query → searches LanceDB (Cloud/local URI) via `@lancedb/lancedb` → returns indices.

```
POST /api/search/nn
  → fetch("https://api.voyageai.com/v1/embeddings", { input: [query], model: "voyage-3" })
  → lanceTable.search(embedding).metricType("cosine").where("deleted = false").limit(100)
  → return { indices }
```

No Python needed. No h5py, no sklearn, no `latentscope.models`.

#### Data queries → TS-native LanceDB queries

Implemented in TS:
- `/api/indexed`
- `/api/query`
- `/api/column-filter`

These routes are served from LanceDB in the TS API (no Flask pandas path).

#### Links/graph → TS with pre-computed artifacts

Implemented in TS:
- `/api/datasets/<id>/links/meta`
- `/api/datasets/<id>/links/node-stats`
- `/api/datasets/<id>/links/by-indices`
- `/api/datasets/<id>/links/thread/<tweet_id>`
- `/api/datasets/<id>/links/quotes/<tweet_id>`

These read precomputed `links/*.json|parquet` artifacts from `LATENT_SCOPE_DATA` or `DATA_URL`.

#### Metadata/scope payloads → TS file-backed routes

Implemented in TS:
- `/api/datasets/<id>/meta`
- `/api/datasets/<id>/scopes`
- `/api/datasets/<id>/scopes/<id>`
- `/api/datasets/<id>/scopes/<id>/parquet`
- `/api/datasets/<id>/embeddings`
- `/api/datasets/<id>/clusters/*`

#### URL resolution → TS fetch or remove

Implemented: TS allowlisted resolver for `t.co` (`/api/resolve-url`, `/api/resolve-urls`).

#### Static serving → CDN (already decided)

Current: Flask catch-all serves SPA. New: Vercel/Cloudflare Pages serves the Vite build. No API involvement.

### 5.4.2 TS API tech stack

| Choice | Why |
|---|---|
| **Hono** (preferred) or Express | Hono runs on Vercel, Cloudflare Workers, Node, Deno, Bun. Tiny, fast, edge-compatible. |
| **@lancedb/lancedb** | Official TS SDK for LanceDB Cloud. Vector search + filtered queries. |
| **VoyageAI REST** | No SDK needed — simple `fetch()` to embedding endpoint. |
| **Zod** | Request/response validation. |

The entire serving API is likely <500 lines of TS.

### 5.4.3 New project structure

```
api/                          ← TS serving API
  src/
    index.ts                  ← Hono app, route definitions
    routes/
      search.ts               ← /api/search/nn (LanceDB + VoyageAI)
      data.ts                 ← read/query/links/metadata/file routes
      jobs.ts                 ← /api/jobs (trigger Modal, poll status)
      resolve-url.ts          ← /api/resolve-url (t.co only, allowlisted)
    lib/
      lancedb.ts              ← LanceDB client setup (cloud/local URI)
      voyageai.ts             ← VoyageAI embedding helper
  package.json
  tsconfig.json
  vercel.json / wrangler.toml ← Deploy config

web/                          ← Existing React frontend (unchanged)
  src/
    lib/apiService.js         ← Update base URL to point at TS API + CDN for static data

latentscope/                  ← Existing Python (pipeline only, runs on Modal)
  scripts/                    ← Pipeline scripts (unchanged logic)
  importers/                  ← Twitter importer (unchanged logic)
  server/                     ← DEPRECATED for production serving; kept for local studio/dev
```

The Python `latentscope/server/` stays in the repo for local development (`ls-serve` for studio mode) but is not deployed to production.

## 5.6 Auth / multi-tenancy
What must be implemented:
- User identity, dataset ownership, authz checks on dataset/scope/tag/bulk/job endpoints.
- Tenant isolation in storage paths and query filters.

Options:
1. Supabase Auth + Postgres RLS.
2. Clerk/Auth0 + custom ACL in app DB.
3. Internal auth only (limited growth path).

Recommendation: Option 1.

## 5.7 Security hardening

The TS serving API eliminates most Flask serving security issues (no `shell=True`, no `debug=True` on public serving paths, no open URL resolver SSRF path).

Remaining concerns:
- Rate limits on search and (Phase 2) job submission endpoints.
- Modal: pipeline runs in isolated containers with no inbound network — low attack surface.
- Auth (Phase 2): Supabase Auth tokens validated in TS API middleware before triggering Modal jobs or serving user-scoped data.

Note: Flask `shell=True` and `debug=True` issues remain in `latentscope/server/` but are local-dev-only — not deployed to production.

## 5.8 Observability
- TS API: Vercel/Cloudflare analytics (built-in) + Sentry for error tracking.
- Modal pipeline: Modal dashboard for job logs/metrics. Sentry for crash reporting.
- Key metrics: search query p95, pipeline duration per step, embedding API cost per import.

## 6. Recommended Execution Roadmap

### Phase 0 — Ship visakanv demo

Frontend fixes:
- Fix `ScopeContext` mutation of `scope.cluster_labels_lookup`.
- Add visible load-error state for scope fetch failures.
- Pre-build cluster index (`Map<clusterId, ls_index[]>`) in ScopeContext.
- Debounce/cache label placement in DeckGLScatter (O(n^2) per frame).

Data upload:
- Import visakanv tweets-only scope locally (existing Python pipeline).
- Upload scope parquet + metadata JSON to R2/S3.
- Export LanceDB table to LanceDB Cloud.

Deploy:
- Frontend → Vercel or Cloudflare Pages.
- TS API → Vercel Functions or Cloudflare Workers.
- Update `apiService.js` to point at new endpoints.

### Phase 1 — Production correctness + ingestion polish

Pipeline:
- Add `note-tweet` / `community-tweet` normalization in `latentscope/importers/twitter.py`.
- Add importer regression tests for `like` + `likes` dedup.

Links/graph:
- Pre-compute thread/quote adjacency at pipeline time, upload to R2 or LanceDB Cloud edges table.

Search upgrades:
- Filtered vector search in LanceDB Cloud (push `cluster`, `deleted`, `created_at` filters).
- Hybrid retrieval (vector + full-text search via LanceDB).
- Server-side pagination (replace `limit(100)` + client `slice(20)`).

### Phase 2 — Multi-user ingestion

Modal pipeline:
- Wrap Twitter pipeline scripts as Modal `@app.function` chain.
- Output to R2/S3 + LanceDB Cloud (not local disk).
- Progress reporting via webhook to TS API → job status DB.
- Add `/api/jobs` endpoints to TS API (trigger, poll, notify).

Auth:
- Supabase Auth + Postgres RLS for user identity and dataset ownership.
- Tenant isolation in LanceDB Cloud (per-user table namespacing or row-level filter).

Frontend:
- Import flow UI — upload archive or request community archive fetch.
- Job progress tracking.

### Phase 3 — Multi-user productization

- Full tweets + likes imports per user with quotas.
- Hybrid search ranking (semantic + lexical + engagement/time).
- Export packs and retention controls.
- Rate limits and abuse protection on import endpoints.

## 7. Specific code areas to implement/change

### Frontend (modify)
- Scope load + cluster count mutation bug: `web/src/contexts/ScopeContext.jsx`
- Cluster filter O(n) scan: `web/src/hooks/useClusterFilter.js`
- Label placement performance: `web/src/components/Explore/V2/DeckGLScatter.jsx`
- API base URL + static data from CDN: `web/src/lib/apiService.js`
- Frontend build config for CDN split: `web/vite.config.js`

### Python pipeline (modify for Modal, Phase 2)
- Import normalization (`note-tweet`, `community-tweet`): `latentscope/importers/twitter.py`
- Scope export to LanceDB Cloud: `latentscope/scripts/scope.py`
- Modal function wrappers: `latentscope/scripts/twitter_import.py` (or new `modal/` dir)

### Python server (keep for local dev only, no production changes)
- `latentscope/server/` — kept as-is for `ls-serve` studio mode, not deployed

## 8. External references

Data & search:
- Community Archive: https://community-archive.org/
- hyparquet (client-side parquet): https://github.com/hyparam/hyparquet
- Voyage AI embeddings API: https://docs.voyageai.com/reference/embeddings-api

TS API:
- Hono (TS web framework): https://hono.dev/
- @lancedb/lancedb (TS SDK): https://lancedb.github.io/lancedb/js/
- Zod (validation): https://zod.dev/

Vector DB (LanceDB Cloud):
- LanceDB Cloud: https://docs.lancedb.com/cloud/get-started
- LanceDB filtering: https://docs.lancedb.com/search/filtering
- LanceDB full-text search: https://docs.lancedb.com/search/full-text-search
- LanceDB hybrid search: https://docs.lancedb.com/search/hybrid-search
- LanceDB reranking: https://docs.lancedb.com/reranking/index

Hosting:
- Vercel: https://vercel.com/docs
- Cloudflare Pages: https://developers.cloudflare.com/pages/
- Cloudflare R2: https://developers.cloudflare.com/r2/

Pipeline compute:
- Modal: https://modal.com/docs/guide

Auth & observability:
- Supabase Auth: https://supabase.com/docs/guides/auth
- Sentry: https://docs.sentry.io/
