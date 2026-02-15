# tweetscope

Turn Twitter/X archives into multiscale knowledge bases. Embed, project, cluster, label with LLMs, and explore interactively.

Fork of [enjalot/latent-scope](https://github.com/enjalot/latent-scope) + [datamapplot](https://github.com/TutteInstitute/datamapplot) + [toponymy](https://github.com/TutteInstitute/toponymy) — specialised for Twitter/X archive analysis.

## How it works

The core mental model: take unstructured text, embed it into a high-dimensional vector space, reduce to 2D for display (and kD for clustering), cluster the points with HDBSCAN, then label each cluster with an LLM. The result is an interactive scatter plot where every point is a document and every region has a human-readable topic name.

<picture>
  <img src="documentation/pipeline-flow.svg" alt="Data pipeline: ingest → embed → UMAP → cluster → label → scope → explore">
</picture>

Each pipeline step writes flat files (Parquet, HDF5, JSON) to a dataset directory. Steps are idempotent and parameterised — you can re-run any step with different settings and compare the results via scopes.

## System architecture

Two servers, one frontend. In local/studio mode the Flask server handles everything. In production the Hono TypeScript API serves read paths from pre-built artifacts on R2/CDN, with vector search via LanceDB Cloud + VoyageAI.

<picture>
  <img src="documentation/system-architecture.svg" alt="System architecture: React frontend, typed API clients, Flask studio + Hono production, Python pipeline, flat file storage">
</picture>

### Runtime modes

| Mode | `LATENT_SCOPE_APP_MODE` | Purpose |
|------|------------------------|---------|
| **Studio** | `studio` | Local dev: full pipeline UI, settings, jobs, export |
| **Hosted** | `hosted` | Multi-user: explore + Twitter import, no admin |
| **Single Profile** | `single_profile` | Read-only: one public scope, no import |

Mode is set via environment variable. One frontend build adapts to all modes via feature flags from `/api/app-config`.

## Explore UI

The explore interface is a 3-panel layout: topic tree (left), scatter plot (center), feed/carousel (right). The right panel has 5 states managed by `useSidebarState`: collapsed, normal feed, expanded carousel, thread view, and quote view.

<picture>
  <img src="documentation/explore-ui.svg" alt="Explore UI: ScopeContext + FilterContext feed into VisualizationPane, TopicTree, TweetFeed, FeedCarousel, ThreadView">
</picture>

### Key frontend concepts

| Concept | Where | What it does |
|---------|-------|--------------|
| **ScopeContext** | `web/src/contexts/ScopeContext.tsx` | Loads scope metadata, builds `clusterMap`, `clusterHierarchy`, provides `scopeRows` |
| **FilterContext** | `web/src/contexts/FilterContext.jsx` | Manages active filter (cluster, search, feature, column), `filteredIndices`, pagination |
| **DeckGLScatter** | `web/src/components/Explore/V2/DeckGLScatter.jsx` | Deck.GL ScatterplotLayer + TextLayer, categorical hue per cluster |
| **TopicTree** | `web/src/components/Explore/V2/TopicTree.jsx` | Hierarchical cluster tree, sorted by cumulative engagement |
| **FeedCarousel** | `web/src/components/Explore/V2/Carousel/` | Multi-column expanded view with per-column data from `useCarouselData` |
| **ThreadView** | `web/src/components/Explore/V2/ThreadView/` | Reply chain visualisation via graph edges |

### Typed API clients

The frontend uses domain-split API clients (`web/src/api/`):

- `catalogClient` — scope/embedding/cluster metadata
- `viewClient` — scope rows (Parquet via hyparquet)
- `graphClient` — reply/quote edges and node stats
- `queryClient` — row fetching by indices with pagination
- `baseClient` — shared HTTP helpers, `apiUrl` from `VITE_API_URL`

## Quick start

### Local development (studio mode)

```bash
# Python backend
pip install -e .
ls-init ~/latent-scope-data --openai_key=XXX --voyage_key=YYY
ls-serve ~/latent-scope-data  # Flask on :5001

# Frontend (separate terminal)
cd web && npm install && npm run dev  # Vite on :5174
```

### Twitter/X archive import

```bash
# Native X export zip — runs full pipeline (embed → UMAP → cluster → scope)
ls-twitter-import visakanv --source zip --zip_path archives/archive.zip --run_pipeline

# Community archive by username
ls-twitter-import visakanv --source community --username visakanv --run_pipeline
```

### Progressive import (large archives)

For large archives (100k+ tweets), import year by year. Each run ingests only — no pipeline — deduplicating by tweet ID and appending new rows while preserving existing `ls_index` values. A batch manifest is written to `imports/` after each run. Once all years are imported, run the pipeline once on the full dataset.

```bash
# Step 1: Ingest year by year (no --run_pipeline, ingest only)
for year in 2018 2019 2020 2021 2022 2023 2024; do
  ls-twitter-import visakanv-tweets --source zip --zip_path archives/archive.zip \
    --year $year --import_batch_id "visakanv-$year"
done

# Step 2: Run pipeline once on the full dataset
ls-twitter-import visakanv-tweets --source zip --zip_path archives/archive.zip \
  --run_pipeline --import_batch_id "visakanv-final"
```

Additional filters can be combined with `--year`:

| Flag | Purpose | Example |
|------|---------|---------|
| `--lang` | Filter by language | `--lang en` |
| `--min_favorites` | Minimum engagement | `--min_favorites 10` |
| `--min_text_length` | Skip short tweets | `--min_text_length 50` |
| `--exclude_replies` | Drop replies | |
| `--exclude_retweets` | Drop retweets | |
| `--exclude_likes` | Skip likes | |
| `--top_n` | Limit row count | `--top_n 5000` |
| `--sort` | Order by `recent` or `engagement` | `--sort engagement` |

### CLI pipeline (step by step)

```bash
ls-ingest-csv "my-dataset" ~/data.csv
ls-embed my-dataset "text" voyageai-voyage-4-lite
ls-umap my-dataset embedding-001 25 0.1                           # 2D display
ls-umap my-dataset embedding-001 25 0.1 --purpose cluster --n_components 10  # kD for clustering
ls-cluster my-dataset umap-001 50 5 --clustering_umap_id umap-002
ls-scope my-dataset cluster-001-labels-default "My scope" "Description"

# Hierarchical labels via Toponymy (the default for twitter imports)
uv run python3 -m latentscope.scripts.toponymy_labels my-dataset scopes-001 \
    --llm-provider openai --llm-model gpt-5-mini

ls-build-links-graph my-dataset                                    # reply/quote edges
ls-serve ~/latent-scope-data
```

### Python interface

```python
import latentscope as ls
import pandas as pd

ls.init("~/latent-scope-data", openai_key="XXX")
df = pd.read_parquet("my_data.parquet")
ls.ingest("my-dataset", df, text_column="text")
ls.embed("my-dataset", "text", "voyageai-voyage-4-lite")
ls.umap("my-dataset", "embedding-001", 25, 0.1)
ls.cluster("my-dataset", "umap-001", 50, 5)
ls.scope("my-dataset", "cluster-001-labels-default", "My scope", "Description")
# Then run toponymy_labels.py for hierarchical labels
ls.serve()
```

### Hosted / production deployment

See [documentation/vercel-deployment.md](documentation/vercel-deployment.md) for Vercel setup with four projects (web-demo, api-demo, web-app, api-app) from a single branch.

```bash
# Production API (Hono)
cd api && npm install && npm run dev   # tsx watch on :3000
cd api && npm run build && npm start   # compiled

# Frontend production build
cd web && npx vite build --mode production
```

## Test datasets

Three datasets are used for development and testing. Archive zips live in `archives/` (gitignored).

| Dataset | Source | Size | Pipeline | Purpose |
|---------|--------|------|----------|---------|
| **visakanv-tweets** | Community archive (1k sample) | ~1,000 tweets | Current | Dev test corpus; full 200k+ archive will power the public demo |
| **sheik-tweets** | Native X export (`archives/my-twitter-archive.zip`) | ~10k tweets | Current | Primary dev corpus |
| **patrick-tweets** | Native X export | 50 tweets | Outdated — needs re-import | Future read-only public dataset |

"Current pipeline" means: voyage-4-lite embeddings, split UMAP (2D display + 10D clustering), HDBSCAN on kD manifold, hierarchical toponymy labels with audit loop.

To set up from scratch:

```bash
# Copy masky's archive into the repo (gitignored)
cp ~/Downloads/my-twitter-archive.zip archives/

# Import visakanv: 1k sample from the community archive
ls-twitter-import visakanv-tweets \
  --source community --username visakanv \
  --top_n 1000 --sort recent --run_pipeline

# Import masky's archive
ls-twitter-import sheik-tweets \
  --source zip --zip_path archives/my-twitter-archive.zip --run_pipeline
```

## Repository structure

```
.
├── api/                   # Production serving API (Hono + TypeScript)
│   ├── src/routes/        #   search, data, catalog, graph, resolve-url
│   └── src/lib/           #   lancedb, voyageai, graphRepo
├── web/                   # React frontend (Vite + Deck.GL)
│   ├── src/api/           #   Typed API clients (catalog, view, graph, query)
│   ├── src/contexts/      #   ScopeContext, FilterContext
│   ├── src/hooks/         #   useSidebarState, useCarouselData, useClusterFilter, ...
│   ├── src/components/    #   Explore/V2 (DeckGLScatter, TopicTree, Carousel, ThreadView)
│   ├── src/lib/           #   apiService, DuckDB, twitterArchiveParser, colors
│   └── src/pages/V2/      #   FullScreenExplore (main page)
├── latentscope/           # Python package
│   ├── server/            #   Flask app, blueprints (datasets, jobs, search, tags, admin)
│   ├── scripts/           #   Pipeline CLI (ingest, embed, umap, cluster, label, scope, ...)
│   ├── models/            #   Embedding + chat model providers
│   ├── importers/         #   Twitter archive parser
│   └── util/              #   Config, data directory management
├── toponymy/              # Git submodule: hierarchical cluster labeling
│   └── toponymy/          #   cluster_layer, llm_wrappers, prompt_construction, audit
├── archives/              # Twitter archive zips (gitignored)
├── contracts/             # JSON schemas (scope_input, links)
├── tools/                 # Operational scripts (eval, backfill, validate, sync)
├── documentation/         # Diagrams, deploy guides, notes
├── experiments/           # Prototypes
└── reports/               # Eval output artifacts
```

## Data pipeline: step by step

### 0. Ingest

Converts CSV/Parquet/JSON/XLSX into `input.parquet` + `meta.json`. For Twitter archives, `ls-twitter-import` handles zip extraction, deduplication, and optional full-pipeline execution.

### 1. Embed

Encodes the text column into high-dimensional vectors stored as HDF5. Supports local models (HuggingFace sentence-transformers) and API providers (VoyageAI, OpenAI, Cohere, Mistral, Together). Default: `voyageai-voyage-4-lite`.

Resumable — if interrupted, re-running picks up from the last completed batch.

### 2. UMAP

Reduces embeddings to lower dimensions. Two purposes:

- **Display** (`--purpose display`, default): 2D x,y coordinates for the scatter plot
- **Cluster** (`--purpose cluster --n_components 10`): kD manifold for better HDBSCAN clustering

### 3. Cluster

HDBSCAN clustering on the UMAP output. When a clustering UMAP is available, use `--clustering_umap_id` to cluster on the kD manifold while plotting on the 2D display UMAP.

### 4. Label (Toponymy hierarchical)

The twitter pipeline uses **hierarchical Toponymy labeling** exclusively (enabled by default in `ls-twitter-import --hierarchical-labels`). Multi-layer cluster naming with:

- Adaptive exemplar counts by cluster size
- Keyphrase extraction via VoyageAI embeddings
- Sibling context in prompts for disambiguation
- Post-fit audit loop (flag vague labels → relabel → re-audit)
- Async LLM wrappers for OpenAI and Anthropic

Flat `ls-label` exists as an upstream CLI command but is not used in the tweetscope pipeline.

### 5. Scope

A scope is a named combination of embedding + UMAP + clusters + labels. Switching between scopes in the UI is instant. The scope JSON ties together all artifact IDs and includes the full cluster label lookup.

### 5b. Links graph

`ls-build-links-graph` extracts reply and quote edges from the dataset, producing `edges.parquet` and `node_stats.parquet` conforming to the `contracts/links.schema.json` contract. Powers the ThreadView and ConnectionBadges in the UI.

### 6. Serve + Explore

The Flask studio server (`ls-serve`) or Hono production API serves the artifacts. The React frontend loads scope rows, builds the cluster hierarchy, and renders the interactive scatter + sidebar.

## Data contracts

### `contracts/scope_input.schema.json`

Required columns: `id`, `ls_index`, `x`, `y`, `cluster`, `label`, `deleted`, `text`

Optional: `raw_cluster`, `created_at`, `username`, `display_name`, `tweet_type`, `favorites`, `retweets`, `replies`, `is_reply`, `is_retweet`, `is_like`, `urls_json`, `media_urls_json`, `archive_source`

### `contracts/links.schema.json`

Edges: `edge_id`, `edge_kind`, `src_tweet_id`, `dst_tweet_id`, `src_ls_index`, `dst_ls_index`, `internal_target`, `provenance`

Node stats: `tweet_id`, `ls_index`, `thread_root_id`, `thread_depth`, `thread_size`, `reply_child_count`, `quote_in_count`, `quote_out_count`

## Dataset directory structure

```
data/
└── my-dataset/
    ├── input.parquet                          # Source data
    ├── meta.json                              # Dataset metadata
    ├── embeddings/
    │   ├── embedding-001.h5                   # Vectors (HDF5)
    │   └── embedding-001.json                 # Model + params
    ├── umaps/
    │   ├── umap-001.parquet                   # 2D display coordinates
    │   ├── umap-001.json                      # UMAP params
    │   ├── umap-002.parquet                   # kD clustering manifold
    │   └── umap-002.json
    ├── clusters/
    │   ├── cluster-001.parquet                # Cluster assignments
    │   ├── cluster-001.json                   # HDBSCAN params
    │   ├── cluster-001-labels-001.parquet     # LLM-generated labels
    │   └── cluster-001-labels-001.json
    ├── scopes/
    │   └── scopes-001.json                    # Scope config (ties everything together)
    ├── links/
    │   ├── edges.parquet                      # Reply/quote edges
    │   └── node_stats.parquet                 # Thread metrics per node
    ├── tags/
    │   └── ❤️.indices                          # User-tagged indices
    └── jobs/
        └── <job-id>.json                      # Job status + progress
```

## CLI reference

| Command | Purpose |
|---------|---------|
| `ls-init <data_dir>` | Initialise data directory + .env |
| `ls-serve [data_dir]` | Start Flask studio server (:5001) |
| `ls-ingest <dataset_id>` | Ingest from input.csv |
| `ls-ingest-csv <id> <path>` | Ingest from CSV path |
| `ls-embed <id> <text_col> <model>` | Generate embeddings |
| `ls-umap <id> <emb_id> [neighbors] [min_dist]` | UMAP projection |
| `ls-cluster <id> <umap_id> <samples> <min_samples>` | HDBSCAN clustering |
| `ls-label <id> <text_col> <cluster_id> <model>` | LLM cluster labeling |
| `ls-scope <id> <labels_id> <label> <desc>` | Create scope |
| `ls-twitter-import <id> --source zip\|community` | Twitter archive import |
| `ls-build-links-graph <id>` | Build reply/quote edge graph |
| `ls-list-models` | List available models |
| `ls-download-dataset <id>` | Download public dataset |
| `ls-upload-dataset <id>` | Upload to remote storage |

## Toponymy integration

The `toponymy/` git submodule provides hierarchical cluster labeling. Called via `latentscope/scripts/toponymy_labels.py`:

```bash
uv run python3 -m latentscope.scripts.toponymy_labels my-dataset scopes-001 \
    --llm-provider openai --llm-model gpt-5-mini \
    --context "tweets from a tech founder" \
    --adaptive-exemplars
```

Key capabilities:
- **Multi-layer hierarchy**: Automatic cluster tree with configurable minimum cluster count
- **Async LLM wrappers**: Parallel naming with OpenAI and Anthropic
- **Adaptive exemplars**: Exemplar/keyphrase counts scale with cluster size
- **Sibling context**: Prompts include sibling cluster names for disambiguation
- **Audit loop**: Post-fit flag → relabel → re-audit cycle for quality

## Operational tools

```bash
# Evaluate label quality with bakeoff comparison
uv run python3 tools/eval_hierarchy_labels.py --dataset <id> [--compare <labels-id>]

# Validate scope artifact integrity
uv run python3 tools/validate_scope_artifacts.py <dataset_path>

# Backfill LanceDB table IDs
uv run python3 tools/backfill_lancedb_table_id.py <dataset_path>

# Sync to Cloudflare R2 CDN
uv run python3 tools/sync_cdn_r2.py <dataset_id>
```

## Design principles

1. **Multiscale topic hierarchy** — Toponymy builds a tree of topics at multiple granularities. The UI reflects this everywhere: the TopicTree lets you navigate broad themes down to fine subtopics, the FeedCarousel shows per-cluster columns, and the scatter plot colours by hierarchy level.

2. **Twitter-native pipeline** — Archive import (native zip + community archive), thread/reply graph extraction, engagement metrics (likes, retweets) used for cluster ranking and UI sorting. The pipeline understands tweets, threads, quotes, and likes as first-class concepts.

3. **Reproducible artifacts** — Pipeline outputs are Parquet, HDF5, and JSON. Every parameter choice is recorded in metadata JSON alongside its output. LanceDB stores vector indices (cloud in production, local for graph tables). DuckDB WASM handles client-side Parquet queries in the browser.

4. **Scopes for comparison** — A scope ties together one embedding + UMAP + cluster + label combination. You can create multiple scopes with different settings and switch between them instantly in the UI.

5. **Contract-driven data flow** — JSON schemas in `contracts/` define column names, types, and nullability for data flowing between pipeline, API, and frontend. The pipeline normalises types on write; typed API clients enforce shapes on read.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Python pipeline | Flask, Pandas, NumPy, UMAP-learn, HDBSCAN, HuggingFace Transformers |
| Production API | Hono (TypeScript), LanceDB Cloud, VoyageAI, Zod, hyparquet |
| Frontend | React 18, Vite, Deck.GL 9, Framer Motion, TanStack Table, D3, SASS |
| Storage | Parquet (Apache Arrow), HDF5, JSON, LanceDB (vector search + graph), DuckDB WASM (client-side) |
| Deploy | Vercel (web + API), Cloudflare R2 (data artifacts) |

## Contributing

See [CONTRIBUTION.md](CONTRIBUTION.md) for guidelines and [DEVELOPMENT.md](DEVELOPMENT.md) for architecture details.

```bash
# Clone with submodules
git clone --recurse-submodules <repo-url>
# or after clone:
git submodule update --init --recursive
```
