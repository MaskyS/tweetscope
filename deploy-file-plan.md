# Deploy File Plan

Reference audit. Numbers from sheik-tweets (9,943 tweets) with scale projections for visakanv-tweets (212K tweets, the demo target). Applies to any dataset going through the pipeline.

---

## Pipeline Lineage

**Correct pipeline for any demo scope:**
```
embedding (voyage-4-lite, 1024-dim)
  → UMAP display manifold (2D; purpose=display)
  → UMAP clustering manifold (10D; purpose=cluster, min_dist=0.0)
    → cluster (HDBSCAN on 10D manifold via clustering_umap_id)
      → toponymy (hierarchical labels; async naming + audit relabel loop)
        → scope (scope.py assembles JSON + parquet + -input.parquet)
          → export_lance(cloud=True) syncs to LanceDB Cloud
```

**Lineage verification checklist (before deploy):**
- Embedding is `voyage-4-lite` (1024-dim)
- Display UMAP metadata includes `purpose=display` and `n_components=2`
- Cluster metadata includes `clustering_umap_id` pointing to a 10D UMAP
- Toponymy rows include `topic_specificity`
- Scope `-input.parquet` passes `scripts/validate_scope_artifacts.py`
- LanceDB Cloud table matches scope via `export_lance(cloud=True)`

---

## 1. meta.json (4.6KB)

**Purpose:** Dataset-level metadata. Defines dataset identity, column schema, and text column for embedding.

**Shape:** JSON object — id, length (9943), columns (21 names), text_column, column_metadata (types/categories per column).

**Consumers:** TS API (GET /datasets/:dataset/meta), Python pipeline (ingest step), frontend ScopeContext.

**Constraints:** None notable. Small file, always needed.

**Verdict:** Keep as-is. This is a lightweight descriptor. No format change needed. For hosted multi-user, the `_meta/datasets` LanceDB table supersedes per-directory meta.json, but the file itself works fine for single-profile demo.

---

## 2. input.parquet (1.7MB)

**9,943 rows, 21 columns**

**Purpose:** Raw ingested tweet data. Source-of-truth for the full record before any pipeline processing.

**Shape:** id, liked_tweet_id, text, created_at, created_at_raw, favorites, retweets, replies, lang, source, username, display_name, in_reply_to_status_id, in_reply_to_screen_name, is_reply, is_retweet, is_like, urls_json, media_urls_json, tweet_type, archive_source.

**Consumers:** Python pipeline only (embed, cluster, label, scope, ingest, build_links, toponymy). Never read by TS API or frontend.

**Constraints:**
- `id` is int64 — but tweet IDs exceed JS Number.MAX_SAFE_INTEGER, risking precision loss in frontend

**Recommendations:**
- scope.py casts id to string via SERVING_COLUMNS. JS can't safely handle tweet IDs > 2^53.
- No format change needed (parquet is correct). This file doesn't need to be on CDN since TS API never reads it.

---

## 4. Embeddings: embedding-NNN.h5 + .json

```
┌──────────────────┬─────────────┬──────┬───────────────┬──────┐
│       File       │    Shape    │ Dim  │     Model     │ Size │
├──────────────────┼─────────────┼──────┼───────────────┼──────┤
│ embedding-001.h5 │ 9943 x 1024 │ 1024 │ voyage-4-lite │ 39MB │
└──────────────────┴─────────────┴──────┴───────────────┴──────┘
```

Scales linearly: ~4KB per row × 1024 dims × float32. At 212K rows: ~800MB.

**Purpose:** Dense vector embeddings of tweet text, consumed by UMAP and exported into LanceDB for search.

**Consumers:** Python pipeline only (UMAP, scope export → LanceDB). Never read by TS API (TS uses LanceDB Cloud vectors directly). Frontend never touches these.

**JSON metadata:** model name, dimensions, min/max value arrays for normalization.

**Recommendations:**
- Use voyage-4-lite for demo. All downstream artifacts (UMAP, clusters, labels, scope, LanceDB) must chain from the same embedding.
- Consider parquet instead of H5 for embeddings. Pros: consistent tooling (hyparquet in TS if ever needed), better compression. Cons: H5 is fine for Python-only consumers and supports memory-mapped access well.
- For production: embeddings don't need to be on CDN. They're only consumed during pipeline runs (which happen server-side). LanceDB Cloud holds the vectors for serving.
- Tradeoff: H5→parquet migration would require changing scope.py and embed scripts. Low priority since these files never leave the pipeline.

---

## 5. UMAPs: dual-manifold artifacts (`.parquet` + `.json`, PNG for display only)

```
┌────────────────────────────────┬──────┬─────────────────────────────┬───────┐
│           Artifact             │ Rows │            Cols             │ Size  │
├────────────────────────────────┼──────┼─────────────────────────────┼───────┤
│ umap-001.parquet (display)     │ 9943 │ 2 (x, y float32 normalized) │ 114KB │
│ umap-002.parquet (cluster)     │ 9943 │ 10 (dim_0..dim_9 float32)   │ 564KB │
└────────────────────────────────┴──────┴─────────────────────────────┴───────┘
```

> **Contract (implemented):** each correct lineage has two UMAP outputs from the same embedding:
> - display manifold: `purpose=display`, `n_components=2`, normalized `x,y`
> - clustering manifold: `purpose=cluster`, `n_components=10`, `min_dist=0.0`, raw `dim_*`
> `cluster.py` clusters on `clustering_umap_id` (kD) while hulls/centroids are computed on display `x,y`.

**Purpose:** Separate visualization and clustering concerns: 2D for plotting, 10D for semantically stronger HDBSCAN input.

**Consumers:** Python pipeline only (cluster/toponymy/scope stages). TS API/frontend do not read UMAP files directly.

**JSON:** UMAP hyperparameters (n_neighbors, min_dist, metric, n_components).
**PNG:** Generated only for display UMAP (dev-time QA only).

**Constraints:** At 212K rows, display UMAP parquet is ~2.4MB; 10D clustering manifold ~12MB.

**Recommendations:**
- Keep both manifolds; do not cluster on 2D display coordinates.
- Keep parquet format.
- Exclude UMAP PNGs from CDN (dev artifacts).
- UMAP artifacts remain pipeline-side; serving uses scope artifacts, not raw UMAP files.

---

## 6. Clusters

| File | Rows | Cols | Size | Purpose |
| ---- | ---- | ---- | ---- | ------- |
| cluster-001.parquet | 9943 | 2 (`cluster`, `raw_cluster`) | 26KB | HDBSCAN assignments from `clustering_umap_id` (10D manifold) |
| cluster-001-labels-default.parquet | 257 | 4 (`label`, `description`, `indices[]`, `hull[]`) | 74KB | Auto labels (superseded by toponymy) |
| toponymy-001.parquet | 246 | 12 | 96KB | Toponymy hierarchical labels (semantic; includes `topic_specificity`) |

**Consumers:**
- Cluster parquets: Python pipeline (scope assembly), not directly by TS API.
- Labels parquets: TS API reads these via GET /clusters/:cluster/labels/:labelId using hyparquet.
- Hierarchical/toponymy: Consumed during scope assembly, results baked into scope JSON's cluster_labels_lookup.

**Hierarchical schema:** cluster, layer, label, description, hull (polygon coords array), count, parent_cluster, children (array), centroid_x, centroid_y, indices (array), topic_specificity (nullable float).

**Constraints:**
- indices and hull columns are nested arrays (lists of ints/floats). hyparquet handles these, but they inflate parquet size.
- At 212K rows with ~500 clusters, label parquets stay small (~50-100KB).
- The cluster_labels_lookup in scope JSON duplicates the hierarchical parquet data — intentional denormalization for fast frontend bootstrap.

**Recommendations:**
- Keep parquet — correct format for tabular cluster data.
- Labels parquets must be on CDN for TS API serving (DATA_URL path).
- Cluster assignment parquets (cluster-001.parquet) don't need CDN — folded into scope parquet.
- PNGs and JSONs: exclude PNGs from CDN; keep JSONs (small metadata, needed for listing endpoints).
- Consider: for hosted multi-user, cluster labels could move into LanceDB as a separate table rather than flat files. But for demo, files are fine.

---

## 7. Scopes (the critical serving files)

Scope files per scope: `{scope}.json`, `{scope}.parquet`, `{scope}-input.parquet`.

**Consumers:**
- `{scope}.json`: TS API (GET /scopes/:scope), frontend ScopeContext — the main bootstrap file.
- `{scope}-input.parquet`: TS API primary data source for GET /scopes/:scope/parquet. Feeds scatter plot and data table.
- `{scope}.parquet`: Pipeline artifact consumed by Python scope assembly (not a serving fallback in hosted mode).

**-input.parquet column set** is standardized via `SERVING_COLUMNS` in scope.py (22 columns, id always string). Type normalization and validation enforced by `contracts/scope_input.schema.json` (see section E).

**TS API column selection** is derived from the contract at runtime — required + optional columns. The API validates required columns are present and returns a structured 500 on missing columns instead of silently dropping.

**Sizes (9,943 rows):**
- scope parquet (9 cols): 234KB
- scope-input parquet (24 cols): 1.7MB
- scope JSON: 124KB

At 212K rows: scope-input ~36MB, scope JSON ~2.6MB.

**Recommendations:**
1. This file MUST be on CDN (DATA_URL). It's the primary serving payload. At 212K rows: ~36MB — consider:
   - Parquet columnar access via hyparquet's range reads (asyncBufferFromUrl) — only selected columns are fetched, so effective transfer is much less than full file size.
   - Or split into scope parquet (plot-only, ~10MB) + row data via LanceDB queries (already done for /indexed and /query endpoints).
2. Scope JSON must be on CDN. Small file (~10-15KB), critical for bootstrap.

---

## 8. Links

| File | Rows | Cols | Size | Purpose |
| ---- | ---- | ---- | ---- | ------- |
| edges.parquet | 2029 | 7 | 92KB | Reply (1507) + quote (522) edges |
| node_link_stats.parquet | 2176 | 10 | 85KB | Per-node link aggregates |
| meta.json | — | — | 400B | Edge counts + schema version |

**Consumers:** TS API (all three files — edges cached, node_stats cached, meta cached). Frontend graph features (thread view, edge lines on scatter).

**Edge schema:** edge_type, src_tweet_id, dst_tweet_id, src_ls_index, dst_ls_index, internal_target, source_url.

**Key stat:** 812/2029 edges are internal (both endpoints in dataset). Remaining have dst_ls_index = null (external targets).

**Constraints:**
- The entire edges file is loaded into memory and cached. At 100K+ edges this is fine (parquet decompressed ~20-30MB).
- tweet_id fields are strings (correct for JS safety).

**Recommendations:**
- Keep parquet — correct format.
- Must be on CDN for TS API serving.
- Consider: for very large datasets, the full in-memory cache approach could be replaced with LanceDB-backed edge queries. But for <500K edges, in-memory is fine.
- No format changes needed.

---

## 9. LanceDB Local Tables

| Table | Rows | Vector Dim | Columns | Indices | Status |
| ----- | ---- | ---------- | ------- | ------- | ------ |
| `lancedb_table_id` | N | embedding dim | SERVING_COLUMNS | IvfPq(vector, sqrt(N) partitions), BTree(cluster) | Created by `export_lance()` |

**Purpose:** Local LanceDB tables created by `export_lance()`. `cloud=True` syncs the table to LanceDB Cloud in the same call.

**Table naming:** `lancedb_table_id` = `{dataset_id}__{scope_uid}` (UUID4), persisted in scope JSON. Falls back to `scope_id` for old scopes without the field. This prevents collisions when multiple datasets each have `scopes-001`.

**Cloud sync:** `export_lance(directory, dataset, scope_id, cloud=True)` reads `LANCEDB_URI` and `LANCEDB_API_KEY` from env, creates/replaces the table in LanceDB Cloud with the same schema and indices.

**Consumers:** Local Python development only. Production uses LanceDB Cloud (db://tweetscope-mwyfv0). TS API resolves `lancedb_table_id` from scope JSON before querying.

**Notes:**
- Column set standardized via SERVING_COLUMNS in scope.py.
- Local .lance directories don't need CDN — LanceDB Cloud is the serving backend.
- Partition count computed dynamically as `int(sqrt(n_rows))` in export_lance().
- Backfill existing scopes: `uv run python3 scripts/backfill_lancedb_table_id.py <dataset_path> --execute`

---

---

## Summary: What needs to go on CDN (DATA_URL) for demo

These are the files the TS API must access via DATA_URL on Vercel:

| Path | Size (9.9K rows) | Est. 212K rows | Priority |
| ---- | ----------------- | -------------- | -------- |
| meta.json | 4.6KB | ~5KB | Required |
| scopes/{scope}.json | 124KB | ~2.6MB | Required |
| scopes/{scope}-input.parquet | 1.7MB | ~36MB | Required |
| clusters/toponymy-NNN.parquet | 96KB | ~200KB | Required |
| clusters/{cluster}-labels-{labelId}.parquet | 74KB | ~150KB | Required |
| links/meta.json | 400B | ~500B | Required |
| links/edges.parquet | 92KB | ~2MB | Required |
| links/node_link_stats.parquet | 85KB | ~1.8MB | Required |
| clusters/{cluster}.json | ~200B | ~200B | Needed for listing |
| clusters/{cluster}-labels-{labelId}.json | ~200B | ~200B | Needed for listing |
| clusters/toponymy-NNN.json | ~560B | ~560B | Needed for listing |

**Not needed on CDN:** input.parquet, embeddings/.h5, umaps/, cluster assignment parquets, PNGs, backup files.

## Key Format Changes Checklist

| Change | Impact | Priority | Effort |
| ------ | ------ | -------- | ------ |
| Exclude dev artifacts from CDN uploads | Smaller/cheaper CDN | Medium | Trivial — just a manifest/script |

`DATA_URL` is wired to `https://data.maskys.com` (Cloudflare R2 bucket `tweetscope-data`). The TS API's CDN-first read path (`loadJsonFile()`, `loadParquetRows()`, `buildFileUrl()`) reads from this URL. Upload artifacts via `scripts/sync_cdn_r2.py` or `wrangler r2 object put --remote`.
---

## Refinement Addendum

This section is additive. It does not replace the audit above.

### A) Core agreements (code implemented, scope artifacts stale)
1. `id`/tweet identifiers are strings end-to-end — scope.py casts id to str.
2. `scopes/*-input.parquet` schema standardized — SERVING_COLUMNS in scope.py.
3. CDN excludes dev/debug artifacts and backups.
4. Links parquet/json outputs are valid serving artifacts.
5. Float32 embeddings — embed.py uses `dtype=np.float32`.
6. Toponymy labeling defaults to async wrappers for OpenAI/Anthropic and runs an audit-driven relabel loop.
7. Adaptive exemplar/keyphrase sizing is wired through Toponymy fit.
8. `topic_specificity` is persisted as numeric and emitted in hierarchical label rows.
9. Import pipeline no longer silently falls back to generic hierarchical labels on Toponymy failure (fail-fast).
10. No backward-compat requirement for hosted cutover: remove legacy serving fallbacks instead of preserving them.
11. LanceDB is treated as a multimodal, multi-format database layer (not vector-only).

### B) Corrections to original audit

#### B0) LanceDB capability framing correction (docs-backed)
LanceDB docs describe a **multimodal lakehouse for AI** built on Lance format,
with support for:
1. vector search, full-text search, hybrid search, and SQL filtering
2. scalar indexes (`BTREE`, `BITMAP`, `LABEL_LIST`, `FTS`) plus vector indexes
3. namespaces, table versioning/tags, and upsert (`merge_insert`)
4. multimodal blob columns (images/audio/video/PDF bytes) alongside embeddings + metadata

Plan implication: treat per-scope LanceDB tables as general scope tables, not
"vector tables" only.

#### B1) Lance table naming by `{scope_id}` — fixed
`scope_id` repeats (`scopes-001`) across datasets/users. Shared LanceDB Cloud
will collide without indirection.

**Implemented:**
1. `scope.py` generates immutable `scope_uid` (UUID4) and `lancedb_table_id` (`{dataset_id}__{scope_uid}`) at scope creation time, persisted in scope JSON.
2. `export_lance()` reads `lancedb_table_id` from scope JSON (falls back to `scope_id` for old scopes without the field).
3. TS API `data.ts` resolves `lancedb_table_id` from scope JSON via `resolveLanceTableId(dataset, scopeId)` before querying LanceDB (4 call sites: `/indexed`, `/query`, `/column-filter`, `/search/nn`).
4. `lancedb.ts` unchanged — already accepts arbitrary `tableId` string.
5. Backfill script `scripts/backfill_lancedb_table_id.py` adds `scope_uid` + `lancedb_table_id` to existing scope JSONs (dry-run by default, `--execute` to apply).

#### B2) `-input.parquet` is required now, but not forever
Current TS API bootstraps from this file (data.ts:564). Long-term, it can be
split to reduce payload coupling. Near-term: keep on CDN. Mid-term:
`scope-points.parquet` on CDN + row fetch via LanceDB `/indexed`.

#### B3) H5 vs Parquet — format migration only when justified
float32 is done. Migrate H5 to Parquet only when pipeline topology
(e.g. object-storage-first, multi-runtime) justifies it.

### C) Missing pieces for deploy plan

#### C0) Backward-compat removal (P0)
Cutover should be explicit and non-legacy:
1. Remove `DATA_URL + "/files/"` legacy API-proxy mode from serving path.
2. Remove API fallback to `scopes/<scope>.parquet`; require `scopes/<scope>-input.parquet`.
3. Fail fast on missing required artifacts instead of silent fallback behavior (implemented for Toponymy import path; keep as system-wide rule).

#### C1) Hosted control plane (P1)
Filesystem-only discovery won't scale. Add LanceDB Cloud control plane tables
(`_meta/*` namespace) for: datasets, scopes, scope_artifacts, jobs, users, tags.

#### C2) Retention and deletion policies (P2)
Define: raw uploads retention, intermediate artifact retention,
"delete all my data" semantics and SLA.

#### C3) Parquet physical tuning for CDN range reads
1. Row-group target size: ~64MB for large files (enables efficient range reads).
2. Stable types for hot columns (no mixed int64/string for `id`).
3. Avoid nested-heavy columns in hot bootstrap files when possible.

---

## Full Pipeline Diagram

### End-to-end data flow

```
 PHASE 1: DATA PIPELINE (Python — runs server-side, not on Vercel)
 ═══════════════════════════════════════════════════════════════════

 ┌─────────────────────┐
 │  Twitter Archive     │   ZIP from X.com export
 │  Community Archive   │   JSON from community-archive export
 └─────────┬───────────┘
           │
           ▼
 ┌─────────────────────┐     ┌─────────────────────────────────────┐
 │  twitter_import.py   │────▶│  input.parquet  (ALL 21 columns)    │
 │  / ingest.py         │     │  meta.json      (schema, col types) │
 └─────────┬───────────┘     └─────────────────────────────────────┘
           │                   Created dirs: embeddings/ umaps/
           │                   clusters/ scopes/ links/
           ▼
 ┌─────────────────────┐     ┌─────────────────────────────────────┐
 │  embed.py            │────▶│  embeddings/embedding-NNN.h5        │
 │  (VoyageAI / e5 /    │     │    shape: [N_rows, dim] float32     │
 │   OpenAI / local)    │     │  embeddings/embedding-NNN.json      │
 └─────────┬───────────┘     │    model_id, dimensions, min/max    │
           │                  └─────────────────────────────────────┘
           ▼
 ┌─────────────────────┐     ┌─────────────────────────────────────┐
 │  umapper.py          │────▶│  umaps/umap-NNN.parquet             │
 │  (purpose=display,   │     │    cols: x, y (float32; normalized) │
 │   n_components=2)    │     │  umaps/umap-NNN.json (purpose=display)│
 └─────────┬───────────┘     │  umaps/umap-NNN.png (QA plot)        │
           │                  └─────────────────────────────────────┘
           ▼
 ┌─────────────────────┐     ┌─────────────────────────────────────┐
 │  umapper.py          │────▶│  umaps/umap-NNN.parquet             │
 │  (purpose=cluster,   │     │    cols: dim_0..dim_9 (raw manifold)│
 │   n_components=10,   │     │  umaps/umap-NNN.json (purpose=cluster)│
 │   min_dist=0.0)      │     │    no PNG generated                  │
 └─────────┬───────────┘     └─────────────────────────────────────┘
           │
           ▼
 ┌─────────────────────┐     ┌─────────────────────────────────────┐
 │  cluster.py          │────▶│  clusters/cluster-NNN.parquet       │
 │  (HDBSCAN on         │     │    cols: cluster, raw_cluster        │
 │   clustering_umap_id)│     │  clusters/cluster-NNN.json includes  │
 └─────────┬───────────┘     │    clustering_umap_id                 │
           │                  │  clusters/cluster-NNN-labels-       │
           ▼                  │    default.parquet (auto labels)     │
                              └─────────────────────────────────────┘
 ┌─────────────────────┐     ┌─────────────────────────────────────┐
 │  label_clusters.py   │────▶│  clusters/cluster-NNN-labels-       │
 │  (LLM labeling)      │     │    NNN.parquet (LLM labels)         │
 │  ─ ─ ─ ─ ─ ─ ─ ─ ─ │     ├─────────────────────────────────────┤
 │  toponymy_labels.py  │────▶│  clusters/toponymy-NNN.parquet      │
 │  (hierarchical,      │     │    12 cols: cluster, layer, label,   │
 │   async + audit loop │     │    description, hull, count,         │
 │   + adaptive ex.)    │     │    parent_cluster, children,         │
 └─────────┬───────────┘     │    centroid_x/y, indices,            │
           │                  │    topic_specificity                 │
           ▼                  │                                      │
                              └─────────────────────────────────────┘

 ┌─────────────────────┐     ┌─────────────────────────────────────┐
 │  scope.py            │     │  OUTPUTS (3 files + LanceDB):       │
 │                      │     │                                      │
 │  Merges:             │     │  scopes/scopes-NNN.json             │
 │  - input.parquet     │────▶│    scope config + cluster_labels_    │
 │  - umap-NNN.parquet  │     │    lookup (denormalized)             │
 │  - cluster-NNN.pqt   │     │                                      │
 │  - toponymy/labels   │     │  scopes/scopes-NNN.parquet          │
 │                      │     │    9 cols: x, y, tile_index_64/128,  │
 │  scope() function    │     │    cluster, raw_cluster, label,      │
 │  lines 250-340       │     │    deleted, ls_index                  │
 │                      │     │                                      │
 │  Join logic:         │     │  scopes/scopes-NNN-input.parquet    │
 │  input_df            │     │    SERVING_COLUMNS subset (22 cols)  │
 │  .join(scope_df)     │     │    id always string                  │
 │  [SERVING_COLUMNS]   │     │                                      │
 │  → -input.parquet    │     │                                      │
 └─────────┬───────────┘     └─────────────────────────────────────┘
           │
           ▼
 ┌─────────────────────┐     ┌─────────────────────────────────────┐
 │  export_lance()      │     │  lancedb/scopes-NNN.lance/          │
 │  lines 27-95         │────▶│    = -input.parquet columns          │
 │                      │     │    + vector (from embedding H5)      │
 │  Loads:              │     │    + sae_indices, sae_acts (if SAE)  │
 │  - -input.parquet    │     │                                      │
 │  - embedding H5      │     │  Indices:                            │
 │  - SAE H5 (optional) │     │    IvfPq on vector (cosine)         │
 │                      │     │    BTree on cluster                  │
 │  Table name =        │     │    LABEL_LIST on sae_indices         │
 │  lancedb_table_id    │     │                                      │
 │  ({dataset}__{uuid}) │     │                                      │
 │  fallback: scope_id  │     │                                      │
 └─────────────────────┘     └─────────────────────────────────────┘

 ┌─────────────────────┐     ┌─────────────────────────────────────┐
 │  build_links_graph.py│────▶│  links/edges.parquet                │
 │  (reply + quote      │     │    7 cols: edge_type, src/dst tweet  │
 │   edge extraction)   │     │    id, src/dst ls_index,             │
 │                      │     │    internal_target, source_url       │
 │  Reads:              │     │                                      │
 │  - input.parquet     │     │  links/node_link_stats.parquet      │
 │  - scopes parquet    │     │    10 cols: tweet_id, ls_index,      │
 └─────────────────────┘     │    reply/quote in/out counts,        │
                              │    thread_root_id, depth, size       │
                              │                                      │
                              │  links/meta.json                    │
                              │    edge counts, schema_version       │
                              └─────────────────────────────────────┘


 PHASE 2: SERVING (TS API on Vercel — reads from CDN + LanceDB Cloud)
 ═══════════════════════════════════════════════════════════════════════

 ┌─────────────────────────────────────────────────────────────────────┐
 │                     TS API (Hono on Vercel)                         │
 │                                                                     │
 │  Data source resolution (data.ts):                                  │
 │  ┌──────────┐    ┌──────────┐                                        │
 │  │ DATA_DIR │───▶│ DATA_URL │                                        │
 │  │ (local)  │    │ (CDN/R2) │                                        │
 │  └──────────┘    └──────────┘                                        │
 │  Priority 1       Priority 2                                         │
 │  (dev only)       (production)                                       │
 │                                                                     │
 │  ┌─────────────────────────────────────────────────────────────┐   │
 │  │  Routes that read from CDN (via loadJsonFile /              │   │
 │  │  loadParquetRows / buildFileUrl):                            │   │
 │  │                                                              │   │
 │  │  GET /datasets/:dataset/meta                                 │   │
 │  │    → {DATA_URL}/{dataset}/meta.json                         │   │
 │  │                                                              │   │
 │  │  GET /datasets/:dataset/scopes/:scope                        │   │
 │  │    → {DATA_URL}/{dataset}/scopes/{scope}.json               │   │
 │  │                                                              │   │
 │  │  GET /datasets/:dataset/scopes/:scope/parquet                │   │
 │  │    → {DATA_URL}/{dataset}/scopes/{scope}-input.parquet      │   │
 │  │    Columns derived from contracts/scope_input.schema.json     │   │
 │  │    (hyparquet range-reads only requested columns from CDN)   │   │
 │  │                                                              │   │
 │  │  GET /datasets/:dataset/clusters/:cluster/labels/:labelId    │   │
 │  │    → {DATA_URL}/{dataset}/clusters/{cluster}-labels-         │   │
 │  │      {labelId}.parquet                                       │   │
 │  │                                                              │   │
 │  │  GET /datasets/:dataset/links/meta                           │   │
 │  │    → {DATA_URL}/{dataset}/links/meta.json                   │   │
 │  │                                                              │   │
 │  │  GET /datasets/:dataset/links/node-stats                     │   │
 │  │    → {DATA_URL}/{dataset}/links/node_link_stats.parquet     │   │
 │  │                                                              │   │
 │  │  POST /datasets/:dataset/links/by-indices                    │   │
 │  │    → {DATA_URL}/{dataset}/links/edges.parquet               │   │
 │  └─────────────────────────────────────────────────────────────┘   │
 │                                                                     │
 │  ┌─────────────────────────────────────────────────────────────┐   │
 │  │  Routes that query LanceDB Cloud (db://tweetscope-mwyfv0):  │   │
 │  │  vector + scalar + SQL filtering (+ FTS/hybrid ready)        │   │
 │  │                                                              │   │
 │  │  POST /indexed                                               │   │
 │  │    → LanceDB: SELECT * FROM {lancedb_table_id}              │   │
 │  │      WHERE ls_index IN (indices) AND deleted = false         │   │
 │  │    Returns: full row data (text, metadata, engagement)       │   │
 │  │                                                              │   │
 │  │  POST /query                                                 │   │
 │  │    → LanceDB: paginated scan with optional sort/filter       │   │
 │  │                                                              │   │
 │  │  POST /column-filter                                         │   │
 │  │    → LanceDB: WHERE {column} {op} {value}                   │   │
 │  │    Returns: matching ls_index values                         │   │
 │  │                                                              │   │
 │  │  GET /search/nn                                              │   │
 │  │    → VoyageAI embed query → LanceDB vector search            │   │
 │  │    Returns: indices + distances                              │   │
 │  └─────────────────────────────────────────────────────────────┘   │
 │                                                                     │
 │  ┌─────────────────────────────────────────────────────────────┐   │
 │  │  Listing routes (use scope JSON metadata, not raw files):    │   │
 │  │                                                              │   │
 │  │  GET /datasets/:dataset/scopes                               │   │
 │  │  GET /datasets/:dataset/embeddings                           │   │
 │  │  GET /datasets/:dataset/clusters                             │   │
 │  │  GET .../clusters/:cluster/labels_available                   │   │
 │  │    → In single_profile mode: reads from scope JSON directly  │   │
 │  │    → In studio mode: scans DATA_DIR for JSON files           │   │
 │  └─────────────────────────────────────────────────────────────┘   │
 └─────────────────────────────────────────────────────────────────────┘


 PHASE 3: FRONTEND (React on Vercel — talks to TS API only)
 ═══════════════════════════════════════════════════════════════

 ┌─────────────────────────────────────────────────────────────────────┐
 │                     React Frontend (Vite)                           │
 │                                                                     │
 │  ScopeContext bootstrap (in order):                                 │
 │  ┌──────────────────────────────────────────────────────────────┐  │
 │  │ 1. GET /api/datasets/{dataset}/scopes/{scope}                │  │
 │  │    → scope metadata + cluster_labels_lookup                  │  │
 │  │    → builds clusterMap, clusterLabels, clusterHierarchy      │  │
 │  │                                                              │  │
 │  │ 2. GET /api/datasets/{dataset}/scopes/{scope}/parquet        │  │
 │  │    → scopeRows (N rows × selected columns)                  │  │
 │  │    → feeds DeckGLScatter (x, y, cluster for coloring)        │  │
 │  │    → feeds TopicTree (cluster counts, hierarchy)              │  │
 │  │                                                              │  │
 │  │ 3. GET /api/datasets/{dataset}/scopes (list)                 │  │
 │  │ 4. GET /api/datasets/{dataset}/embeddings (list)             │  │
 │  │ 5. GET /api/tags?dataset={dataset}                           │  │
 │  └──────────────────────────────────────────────────────────────┘  │
 │                                                                     │
 │  FilterContext interactions (on demand):                             │
 │  ┌──────────────────────────────────────────────────────────────┐  │
 │  │ Row hydration:                                               │  │
 │  │   POST /api/indexed  (10-20 indices per page)                │  │
 │  │   → LanceDB → full row data for TweetCard rendering          │  │
 │  │                                                              │  │
 │  │ Search:                                                      │  │
 │  │   GET /api/search/nn?query=...&scope_id=...                  │  │
 │  │   → VoyageAI + LanceDB → indices + distances                 │  │
 │  │                                                              │  │
 │  │ Column filter:                                               │  │
 │  │   POST /api/column-filter (e.g. tweet_type = "reply")        │  │
 │  │   → LanceDB → matching indices                               │  │
 │  └──────────────────────────────────────────────────────────────┘  │
 │                                                                     │
 │  Graph/Links (on demand):                                           │
 │  ┌──────────────────────────────────────────────────────────────┐  │
 │  │ GET /api/datasets/{dataset}/links/meta                       │  │
 │  │ GET /api/datasets/{dataset}/links/node-stats                 │  │
 │  │ POST /api/datasets/{dataset}/links/by-indices                │  │
 │  │ GET /api/datasets/{dataset}/links/thread/{tweetId}           │  │
 │  │ GET /api/datasets/{dataset}/links/quotes/{tweetId}           │  │
 │  └──────────────────────────────────────────────────────────────┘  │
 └─────────────────────────────────────────────────────────────────────┘
```

### Consumer map: who reads what

```
 FILE                                    PIPELINE   TS API   FRONTEND
 ──────────────────────────────────────  ────────   ──────   ────────
 input.parquet                           ✓ R        ✗        ✗
 embeddings/*.h5                         ✓ R        ✗        ✗
 embeddings/*.json                       ✓ R        ✓ list   ✗
 umaps/*.parquet                         ✓ R        ✗        ✗
 umaps/*.json                            ✓ R        ✗        ✗
 clusters/cluster-NNN.parquet            ✓ R        ✗        ✗
 clusters/*-labels-*.parquet             ✓ W        ✓ R      ✗
 clusters/toponymy-NNN.parquet           ✓ W        ✗ (1)    ✗
 clusters/*.json                         ✓ W        ✓ list   ✗
 scopes/scopes-NNN.json                  ✓ W        ✓ R      ✗ (2)
 scopes/scopes-NNN.parquet               ✓ W        ✗        ✗
 scopes/scopes-NNN-input.parquet         ✓ W        ✓ R      ✗ (2)
 links/meta.json                         ✓ W        ✓ R      ✗
 links/edges.parquet                     ✓ W        ✓ R      ✗
 links/node_link_stats.parquet           ✓ W        ✓ R      ✗
 lancedb/scopes-NNN.lance                ✓ W        ✗ (3)    ✗
 LanceDB Cloud (db://tweetscope-*)       ✗          ✓ R      ✗

 (1) toponymy data is baked into scope JSON's cluster_labels_lookup
 (2) frontend reads via TS API, not directly
 (3) local lance is synced to LanceDB Cloud for production
```

### CDN vs non-CDN classification

```
 ┌─ MUST BE ON CDN (DATA_URL) ──────────────────────────────────────┐
 │                                                                   │
 │  {dataset}/meta.json .......................... 4.6 KB            │
 │  {dataset}/scopes/{scope}.json ................ 124 KB            │
 │  {dataset}/scopes/{scope}-input.parquet ....... 1.7 MB            │
 │  {dataset}/clusters/toponymy-NNN.parquet ...... 96 KB             │
 │  {dataset}/clusters/{cluster}-labels-                             │
 │    {labelId}.parquet .......................... 74 KB             │
 │  {dataset}/clusters/{cluster}-labels-                             │
 │    {labelId}.json ............................. ~200 B            │
 │  {dataset}/clusters/{cluster}.json ............ ~200 B           │
 │  {dataset}/clusters/toponymy-NNN.json ......... ~560 B           │
 │  {dataset}/links/meta.json .................... 400 B             │
 │  {dataset}/links/edges.parquet ................ 92 KB             │
 │  {dataset}/links/node_link_stats.parquet ...... 85 KB             │
 │                                                                   │
 │  TOTAL (9.9K): ~2.2 MB  |  TOTAL (212K): ~43 MB per dataset      │
 └───────────────────────────────────────────────────────────────────┘

 ┌─ NOT ON CDN (pipeline-only / dev artifacts) ─────────────────────┐
 │                                                                   │
 │  input.parquet                    (Python pipeline only)          │
 │  embeddings/*.h5                  (Python pipeline only)          │
 │  embeddings/*.json                (served from scope JSON)        │
 │  umaps/*.parquet, *.json, *.png   (folded into scope parquet)     │
 │  clusters/cluster-NNN.parquet     (folded into scope parquet)     │
 │  clusters/toponymy-NNN.parquet    (baked into scope JSON)         │
 │  clusters/*.png                   (dev QA only)                   │

 │  lancedb/*.lance/                 (synced to LanceDB Cloud)       │
 └───────────────────────────────────────────────────────────────────┘
```

### Hosted-mode: LanceDB control plane tables

All control plane data lives in LanceDB Cloud (`db://tweetscope-mwyfv0`) as
pure scalar tables in `_meta/*`, while scope tables in LanceDB can hold vectors,
scalar metadata, text-search columns, and optional multimodal blobs. This keeps
the stack on one multimodal database layer. Parquet files stay on CDN for
hyparquet range reads.

LanceDB supports everything these tables need:
- **Multimodal table model** — vectors + metadata + optional binary blob columns in one table
- **Query modes** — vector search, full-text search, hybrid search, SQL filtering
- **CRUD** — `add()`, `update(where=...)`, `delete(predicate)`, `merge_insert()` (upsert)
- **Indexing** — vector indexes plus scalar indexes (`BTREE`, `BITMAP`, `LABEL_LIST`, `FTS`)
- **Namespaces + versions/tags** — separate `_meta/*` tables and support reproducible snapshots

All control plane tables live in a `_meta` namespace to keep them separate from
per-scope LanceDB data tables.

#### 1. `_meta/users`

| Column | Type | Index | Notes |
|--------|------|-------|-------|
| `id` | string | BTREE | ULID |
| `external_id` | string | BTREE | OAuth provider ID, enforce uniqueness via `merge_insert("external_id")` |
| `provider` | string | | `github`, `google`, `twitter` |
| `username` | string | | Display name |
| `email` | string | | |
| `created_at` | timestamp[us] | | |

#### 2. `_meta/datasets`

One row per dataset. TS API `GET /datasets/:dataset/meta` queries this table.

| Column | Type | Index | Notes |
|--------|------|-------|-------|
| `id` | string | BTREE | ULID |
| `slug` | string | BTREE | URL-friendly name, e.g. `visakanv-tweets`. Unique via `merge_insert("slug")` |
| `owner_id` | string | BTREE | References `_meta/users.id` |
| `length` | int32 | | Row count |
| `text_column` | string | | Which column was embedded |
| `columns` | string | | JSON-encoded array of column names |
| `column_metadata` | string | | JSON-encoded types, categories, extents per column |
| `ls_version` | string | | Pipeline version that created it |
| `created_at` | timestamp[us] | | |
| `updated_at` | timestamp[us] | | |

Note: LanceDB doesn't have a native JSON column type. `columns` and
`column_metadata` are stored as JSON strings and parsed in the API layer.
Alternatively, `columns` could be a `list<string>` and `column_metadata` a
nested struct, but JSON strings are simpler for read-heavy metadata.

#### 3. `_meta/scopes`

One row per scope. TS API `GET /scopes/:scope` queries this table. Parquet
files stay on CDN.

| Column | Type | Index | Notes |
|--------|------|-------|-------|
| `id` | string | BTREE | ULID (`scope_uid`) |
| `dataset_id` | string | BTREE | References `_meta/datasets.id` |
| `slug` | string | BTREE | Display ID, e.g. `scopes-002` |
| `label` | string | | Human-readable name |
| `description` | string | | |
| `embedding_id` | string | | Pipeline lineage |
| `umap_id` | string | | |
| `cluster_id` | string | | |
| `cluster_labels_id` | string | | |
| `hierarchical_labels` | bool | | |
| `cluster_labels_lookup` | string | | JSON-encoded labels+hulls+hierarchy |
| `embedding_meta` | string | | JSON-encoded: model_id, dimensions, prefix |
| `umap_meta` | string | | JSON-encoded: neighbors, min_dist, min/max values |
| `cluster_meta` | string | | JSON-encoded: samples, min_samples, n_clusters |
| `cluster_labels_meta` | string | | JSON-encoded: type, num_layers, num_clusters |
| `lancedb_table_id` | string | BTREE | LanceDB scope table name: `{dataset_slug}__{scope_uid}` |
| `rows` | int32 | | |
| `parquet_size` | int64 | | Byte size of scope parquet on CDN |
| `ls_version` | string | | |
| `created_at` | timestamp[us] | | |

#### 4. `_meta/scope_artifacts`

Registry of CDN files per scope. Powers listing endpoints and cleanup.

| Column | Type | Index | Notes |
|--------|------|-------|-------|
| `id` | string | BTREE | ULID |
| `scope_id` | string | BTREE | References `_meta/scopes.id` |
| `artifact_type` | string | BITMAP | `scope_parquet`, `scope_input_parquet`, `cluster_labels_parquet`, `cluster_labels_json`, `edges_parquet`, `node_stats_parquet`, `links_meta_json` |
| `cdn_path` | string | | e.g. `visakanv-tweets/scopes/scopes-002-input.parquet` |
| `byte_size` | int64 | | |
| `checksum` | string | | For cache busting |
| `created_at` | timestamp[us] | | |

#### 5. `_meta/tags`

Per-user tagging of data points. Uniqueness enforced via
`merge_insert(["user_id", "scope_id", "ls_index", "tag"])`.

| Column | Type | Index | Notes |
|--------|------|-------|-------|
| `id` | string | BTREE | ULID |
| `user_id` | string | BTREE | References `_meta/users.id` |
| `dataset_id` | string | BTREE | References `_meta/datasets.id` |
| `scope_id` | string | BTREE | References `_meta/scopes.id` |
| `ls_index` | int32 | BTREE | Row index in the scope |
| `tag` | string | BITMAP | `thumbs_up`, `thumbs_down`, or custom |
| `created_at` | timestamp[us] | | |

#### 6. `_meta/jobs`

Pipeline run tracking. Users see progress and can resume failed jobs.

| Column | Type | Index | Notes |
|--------|------|-------|-------|
| `id` | string | BTREE | ULID |
| `dataset_id` | string | BTREE | References `_meta/datasets.id` |
| `user_id` | string | BTREE | References `_meta/users.id` |
| `job_type` | string | BITMAP | `ingest`, `embed`, `umap`, `cluster`, `label`, `toponymy`, `scope`, `build_links` |
| `status` | string | BITMAP | `pending`, `running`, `completed`, `failed` |
| `config` | string | | JSON-encoded job parameters (model_id, n_neighbors, etc.) |
| `output_artifact_id` | string | | e.g. `embedding-003`, `scopes-002` |
| `error` | string | | Failure message if failed |
| `started_at` | timestamp[us] | | |
| `completed_at` | timestamp[us] | | |

#### Query patterns

```python
import lancedb

db = lancedb.connect("db://tweetscope-mwyfv0", api_key=..., region="us-east-1")

# List datasets for a user
datasets = db.open_table("_meta/datasets")
rows = datasets.search().where(f"owner_id = '{user_id}'").to_list()

# Get scope by slug
scopes = db.open_table("_meta/scopes")
row = scopes.search().where(f"slug = 'scopes-002' AND dataset_id = '{ds_id}'").limit(1).to_list()

# Upsert a tag (thumbs up)
tags = db.open_table("_meta/tags")
tags.merge_insert(["user_id", "scope_id", "ls_index", "tag"]) \
    .when_matched_update_all() \
    .when_not_matched_insert_all() \
    .execute([{"user_id": uid, "scope_id": sid, "ls_index": 42, "tag": "thumbs_up", ...}])

# List artifacts for a scope
artifacts = db.open_table("_meta/scope_artifacts")
files = artifacts.search().where(f"scope_id = '{scope_id}'").to_list()

# Update job status
jobs = db.open_table("_meta/jobs")
jobs.update(where=f"id = '{job_id}'", values={"status": "completed"})
```

#### Why LanceDB instead of Postgres

- **Already in the stack** — LanceDB is the current serving/search data layer
- **Multimodal + multi-format** — one table model for vectors, scalar metadata, text search, and optional blobs
- **Query flexibility** — vector search, full-text search, hybrid retrieval, and SQL filtering
- **Index coverage** — vector indexes + scalar indexes (BTREE/BITMAP/LABEL_LIST/FTS)
- **No ORM needed** — simple dict-in, dict-out via Python/TS SDKs
- **Namespaces + versioning/tags** — `_meta/*` separation and reproducible table snapshots

Tradeoffs vs. Postgres: no foreign keys (enforced at app level), no cross-table
joins (app-level lookups), no unique constraints (use `merge_insert` for upsert
semantics). These are fine for a control plane with tens of datasets and
hundreds of scopes.

---

## CDN Setup: Cloudflare R2

### Current state

| Resource | Value |
| -------- | ----- |
| Bucket | `tweetscope-data` |
| Custom domain | `https://data.maskys.com` (maskys.com zone `63a8cdc7fe78ab3963a7347749a522c4`) |
| `DATA_URL` | `https://data.maskys.com` |
| CORS | `GET`, `HEAD`; headers: `Range`, `Content-Type`; exposed: `Content-Length`, `Content-Range`, `Accept-Ranges`; max-age 86400 |
| CLI | `wrangler` (installed globally via npm) |
| CORS config | `r2-cors.json` at repo root |

- `DATA_URL` is implemented in the TS API (data.ts: `buildFileUrl()`, `loadJsonFile()`,
  `loadParquetRows()`, `asyncBufferFromUrl()`)
- Upload script: `scripts/sync_cdn_r2.py` (implements D1 allowlist, skips D2 denylist; dry-run by default, `--execute` to apply)

### Custom domain vs r2.dev

Custom domain is strictly better when a Cloudflare-managed zone is available:
- **Custom domain**: Cloudflare CDN cache sits in front — repeated range reads for parquet footers/column metadata served from edge. No rate limits. Production-grade URL. CLI-configurable (`wrangler r2 bucket domain add`).
- **r2.dev**: No CDN caching (every request hits R2 origin). Rate-limited (dev/testing only). Dashboard-only toggle. Ugly URL tied to account hash.

### How the TS API reads from CDN

```
buildFileUrl(relativePath):
  DATA_URL + "/" + relativePath    (e.g. https://data.maskys.com/sheik-tweets/meta.json)

loadJsonFile(relPath):
  1. Try local: readFile(DATA_DIR + "/" + relPath)
  2. Try CDN:   fetch(buildFileUrl(relPath)) → JSON.parse
  3. Fail: throw

loadParquetRows(relPath, columns?):
  1. Try local: asyncBufferFromLocalFile(DATA_DIR + "/" + relPath)
  2. Try CDN:   asyncBufferFromUrl({ url: buildFileUrl(relPath) })
  3. Pass to hyparquet: parquetReadObjects({ file, columns })
     → hyparquet uses HTTP Range requests to fetch only requested column chunks
```

### hyparquet range-read behavior
- Makes initial request to get file size (or accepts pre-supplied `byteLength`)
- Reads parquet footer (metadata) from end of file (~few KB range request)
- For each requested column, fetches only the relevant row-group chunks
- For a 36MB parquet (212K rows), selecting 15 of 24 columns may transfer ~22MB
- R2 returns `Accept-Ranges: bytes` (verified)

### Why R2 over alternatives

#### Option A: Cloudflare R2 (chosen)

**Pros:**
- Free egress (no bandwidth charges — critical for parquet range reads)
- S3-compatible API (standard tooling: aws-cli, boto3, rclone)
- Custom domain via Cloudflare CDN (free caching layer in front of R2)
- Public bucket option with custom domain
- Built-in CORS support
- Free tier: 10GB storage, 10M reads/month, 1M writes/month
- Paid: $0.015/GB/month storage, no egress fees

**Cons:**
- R2 is storage, not a CDN — but Cloudflare Cache is free on custom domain
- Slightly less mature tooling than S3

#### Option B: AWS S3 + CloudFront (rejected)

**Pros:**
- Mature, battle-tested infrastructure
- CloudFront edge caching reduces origin hits
- Fine-grained IAM permissions

**Cons:**
- Egress costs: $0.09/GB after first 100GB/month
- CloudFront adds complexity (invalidation, distribution setup)
- A 36MB parquet with range reads could cost ~$0.03 per user session at scale
- More moving parts to configure

**Cost estimate:**
- Storage: $0.023/GB/month → ~$0.003/month
- Egress: $0.09/GB → $3.24 per 1000 sessions (36MB each)
- CloudFront: reduces egress via caching but adds $0.0085/10K requests

#### Option C: Vercel Blob Storage (rejected)

**Pros:**
- Zero-config integration with Vercel
- Globally distributed edge storage
- Simple API: `put()`, `head()`, `del()`

**Cons:**
- Range requests ARE supported (docs confirm with curl examples), but each range request on a cache MISS counts as a Simple Operation + Fast Origin Transfer — hyparquet's multiple range reads per parquet file would amplify costs
- Max file size 5TB; CDN cache limit is 512MB per blob (blobs >512MB always cache MISS with origin transfer charges)
- Expensive at scale: ~$0.05/GB data transfer (regional, e.g. iad1) plus separate Edge Request ($0.40/1M) and Fast Origin Transfer ($0.06/GB on MISS) charges
- Not S3-compatible (proprietary SDK: `put()`, `head()`, `del()`, `list()`, `copy()`)
- Underlying storage is AWS S3 — paying Vercel markup over direct S3/R2 access

**Verdict: Technically viable but cost-prohibitive** — Range headers work, so hyparquet would function. But every range read on cache MISS incurs origin transfer + operation charges. For a 36MB parquet with 10-15 range reads per session, costs compound fast vs. R2's free egress.

### CLI commands

```bash
# Bucket management
wrangler r2 bucket list
wrangler r2 bucket info tweetscope-data

# CORS (config in r2-cors.json at repo root)
wrangler r2 bucket cors set tweetscope-data --file r2-cors.json
wrangler r2 bucket cors list tweetscope-data

# Custom domain
wrangler r2 bucket domain list tweetscope-data
wrangler r2 bucket domain add tweetscope-data --domain data.maskys.com --zone-id 63a8cdc7fe78ab3963a7347749a522c4

# Upload files (--remote required; without it, wrangler targets local dev)
wrangler r2 object put tweetscope-data/{key} --file {local_path} --content-type {mime} --remote

# Upload script (implements D1 allowlist, skips D2 denylist)
uv run --env-file .env python3 scripts/sync_cdn_r2.py <dataset_path>         # dry-run
uv run --env-file .env python3 scripts/sync_cdn_r2.py <dataset_path> --execute
```

### Cost estimate (212K tweets, 1 dataset)
- Storage: ~43MB → free tier (10GB included)
- Reads: ~1000 range requests per user session → free tier (10M reads/month)
- Egress: $0 (always)

---

### D) Refined artifact contract (demo now)

#### D1) Must deploy to CDN
1. `meta.json`
2. `scopes/<scope>.json`
3. `scopes/<scope>-input.parquet` (until split model is implemented)
4. Active label parquet/json artifacts referenced by scope
5. `links/meta.json`
6. `links/edges.parquet`
7. `links/node_link_stats.parquet`

#### D2) Must not deploy to CDN
1. `input.parquet`
2. `embeddings/*`
3. `umaps/*`
4. Cluster assignment parquets not used directly by serving routes
5. Backups, PNGs, tags, temporary uploads

### E) Serving schema contract

**Contract files:** `contracts/scope_input.schema.json` (v1) and `contracts/links.schema.json` (v1).

**`SERVING_COLUMNS`** in `scope.py` defines the canonical column set for `scopes/*-input.parquet`:
1. Identity: `id` (string), `ls_index` (int)
2. Plot: `x`, `y`, `cluster`, `raw_cluster`, `label`, `deleted`, `tile_index_64`, `tile_index_128`
3. Core row: `text`, `created_at`, `username`, `display_name`, `tweet_type`
4. Engagement/filter: `favorites`, `retweets`, `replies`, `is_reply`, `is_retweet`, `is_like`
5. Media/link support: `urls_json`, `media_urls_json`
6. Provenance: `archive_source`

**Required columns** (must exist): `id`, `ls_index`, `x`, `y`, `cluster`, `label`, `deleted`, `text`. All others are optional.

#### E1) Write-time enforcement (pipeline)
Before writing `-input.parquet`, `scope.py` calls:
1. `normalize_serving_types(df, contract)` — casts each column to its contract type (`id→str`, bools→bool, ints→int64, json→`"[]"` default)
2. `validate_scope_input_df(df, contract)` — raises `ValueError` if required columns missing, types wrong, or duplicate column names

#### E2) Read-time enforcement (API)
In `data.ts`, the `/parquet` route:
1. Derives selected columns from the contract (required + optional), not a hardcoded list
2. After loading rows, `validateRequiredColumns()` checks all required columns are present
3. Returns structured 500 with `{ error, dataset, scope, missing_columns, expected_contract_version }` on violation

#### E3) Deploy gate validator
`scripts/validate_scope_artifacts.py` — CLI that checks:
1. Scope JSON exists and references valid cluster label artifacts
2. `-input.parquet` has all required columns with correct Arrow types
3. `id` is string type (not int64)
4. Links parquets (if present) have correct columns and string tweet IDs
5. Exit 0 on pass, exit 1 with error list

Usage: `uv run python3 scripts/validate_scope_artifacts.py <dataset_path> <scope_id>`

#### E4) Runtime acceptance checks
Before switching `DATA_URL` to CDN:
1. Run validator on the dataset to be served.
2. Hit `/datasets/:dataset/scopes/:scope/parquet` and verify non-empty rows + no missing required fields.
3. Validate hover card renders media/quote URLs.
4. Validate cluster stats and filters compute correctly.

### F) Risk checks before production cutover
1. Validate no scope references missing label artifacts on CDN.
2. Validate API bootstraps when only "must deploy" files are present (no local DATA_DIR).
3. Validate all scope JSONs have `lancedb_table_id` (run backfill script, then verify with `export_lance(cloud=True)`).
4. Validate frontend deep-linking for hierarchical cluster IDs (string like "0_8").
5. Validate resolver response contract consistency between Python and TS paths.

### G) Implementation priority

#### P0 — Demo blockers

##### P0.0 — Regenerate demo scope
Test dataset `sheik-tweets` (9,943 rows) has full correct lineage: voyage-4-lite → dual UMAP → HDBSCAN on 10D → toponymy (5-layer, audit loop) → scopes-002. The demo target `visakanv-tweets` (212K rows) will follow the same pipeline.

Pipeline commands for any dataset:
```bash
# 1. Display UMAP (2D) from voyage-4-lite embeddings
uv run python3 -m latentscope.scripts.umapper <dataset> <embedding-id> --purpose display --n_components 2

# 2. Clustering UMAP (10D) from same embeddings
uv run python3 -m latentscope.scripts.umapper <dataset> <embedding-id> --purpose cluster --n_components 10 --min_dist 0.0

# 3. HDBSCAN clustering on 10D manifold
uv run python3 -m latentscope.scripts.cluster <dataset> <display-umap-id> --clustering_umap_id <cluster-umap-id>

# 4. Toponymy hierarchical labels (async naming + audit relabel loop)
uv run python3 -m latentscope.scripts.toponymy_labels <dataset> <cluster-id>

# 5. Assemble scope (generates scope JSON + parquet + -input.parquet, validates against contract)
uv run python3 -m latentscope.scripts.scope <dataset> <embedding-id> <display-umap-id> <cluster-id> <toponymy-labels-id> "<label>" "<description>"

# 6. Validate artifacts
uv run python3 scripts/validate_scope_artifacts.py <dataset-path> <scope-id>

# 7. Sync to LanceDB Cloud
uv run --env-file .env python3 -c "
from latentscope.scripts.scope import export_lance
export_lance('<data-dir>', '<dataset>', '<scope-id>', cloud=True)
"
```

##### P0.1 — LanceDB Cloud sync
`export_lance()` in `scope.py` supports `cloud=True`. When set, it reads `LANCEDB_URI` and `LANCEDB_API_KEY` from env and creates/replaces the table in LanceDB Cloud with the same schema, vector index, and scalar indices as the local table.

##### P0.2 — Schema drift hardening (section E)
See section E for details. Contract files, write-time enforcement, read-time enforcement, and deploy gate validator are in place.

##### P0.3 — CDN setup (R2 bucket + upload)
R2 bucket `tweetscope-data` is created with custom domain `https://data.maskys.com` and CORS configured for range reads. See "CDN Setup: Cloudflare R2" section for details.

**Remaining:**
1. Upload serving artifacts via `scripts/sync_cdn_r2.py` (or `wrangler r2 object put --remote`)
2. Set `DATA_URL=https://data.maskys.com` in Vercel env

##### P0.4 — LanceDB table name resolution — implemented
See section B1 for details. `scope_uid` + `lancedb_table_id` indirection is implemented end-to-end:
- **Write path**: `scope.py` generates `{dataset_id}__{uuid4}` at scope creation, `export_lance()` uses it for both local and cloud tables.
- **Read path**: `data.ts` resolves `lancedb_table_id` from scope JSON via `resolveLanceTableId(dataset, scopeId)` at all 4 LanceDB call sites (`/indexed`, `/query`, `/column-filter`, `/search/nn`).
- **Backfill**: `scripts/backfill_lancedb_table_id.py` adds the field to existing scope JSONs. After backfill, re-run `export_lance(cloud=True)` to create the table under the new name.
- **Backward compat**: Falls back to `scope_id` when `lancedb_table_id` is absent in scope JSON (old scopes).

#### P1 — Pre-hosted

##### P1.1 — Deploy-manifest script (CDN sync) — implemented
`scripts/sync_cdn_r2.py` implements the D1 allowlist:
- Syncs matching files from `DATA_DIR/{dataset}/` to R2 via `boto3` (S3-compat endpoint)
- Skips D2 denylist files (embeddings, umaps, dev artifacts)
- Preserves directory structure: `{dataset}/scopes/{scope}.json` etc.
- Validates scope JSON and resolves cluster_labels_id before upload
- Dry-run by default, `--execute` to apply
- Sets correct Content-Type headers per file extension

##### P1.2 — `_meta/*` control-plane LanceDB tables
Schema defined in section C1 (tables 1-6): `_meta/users`, `_meta/datasets`, `_meta/scopes`, `_meta/scope_artifacts`, `_meta/tags`, `_meta/jobs`.

**Code changes:**
1. New Python module: `latentscope/scripts/init_control_plane.py` — creates all 6 tables with correct schema + indices
2. New TS module: `api/src/lib/control_plane.ts` — typed read/write helpers for each `_meta` table
3. Refactor TS API listing routes (`/scopes`, `/clusters`, `/embeddings`) to query `_meta/scopes` and `_meta/datasets` instead of scanning local filesystem or reading from scope JSON
4. Refactor Python `scope()` to register new scopes in `_meta/scopes` after creation
5. Add `_meta/tags` read/write to existing tags API routes
6. Add `_meta/jobs` tracking to pipeline scripts

Not needed for demo. The demo runs single-dataset with `PUBLIC_SCOPE` env var and CDN files.

#### P2 — Scale/polish
1. Optional split serving model (`scope-points.parquet` + row API fetch).
2. Conditional H5 to Parquet migration for embeddings.
3. Retention/deletion policies.
4. Lakehouse/Iceberg reconsideration only when concurrency/update patterns require it.
