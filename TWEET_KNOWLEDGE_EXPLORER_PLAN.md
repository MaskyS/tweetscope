# Tweet & Likes Knowledge Explorer Plan

## Implementation Update (February 7, 2026)

Completed in current codebase:

1. Product surface simplified toward tweet knowledge exploration:
   - Import-first routing (`/` redirects to `/import`).
   - Legacy routes (`setup`, `jobs`, `compare`, `export`, `plot`) now redirected out of primary flow.
   - Subnav simplified to archive context + switch action (removed dataset/scope dropdown flow).
2. UI simplification:
   - Floating logo/header badge now overlays graph area instead of consuming top layout space.
   - Vertical icon rail in explore view removed.
   - Wording shifted from “pipeline” language to “knowledge index” language in import UX.
3. Likes ingestion added end-to-end:
   - Native X zip import now parses `data/like.js`.
   - Browser-side local extraction now includes likes in extracted JSON.
   - Community extracted JSON import path now ingests likes.
   - Normalized schema includes `tweet_type=like`, `liked_tweet_id`, and `is_like`.
4. Dead product surfaces removed:
   - Deleted old setup/settings/jobs/export/compare/datamap pages and setup-related components/contexts.
   - Removed legacy model/settings/huggingface utility components tied to deleted flows.
   - Removed the old left icon rail and old dataset/scope dropdown pattern from active UX.
5. Header/navigation simplification:
   - Logo/header now floats as an overlay badge on top of the graph area.
   - Explore subnav now shows archive context and `Switch Archive` only.

## Direction
Reposition this project as a Twitter/X personal knowledge product with one core loop:

`import -> explore -> curate -> export/use`

The goal is to optimize for practical outcomes and data ownership, not general-purpose experimentation.

---

## 1) What to remove or reorganize

### Remove from product surface (keep internal if needed)
1. Generic file ingest UI (CSV/Parquet/JSON/XLSX) in hosted mode.
2. Setup wizard steps as separate user-visible phases (`embed`, `umap`, `cluster`, `label`).
3. Model/provider selection UI for end users.
4. Compare view, datamap plot view, SAE-specific UI, and settings page for hosted/public builds.
5. Any route not directly supporting tweet/likes explorer outcomes.

### Reorganize UX
1. Route model:
   - `/import`
   - `/explore/:dataset/:scope`
   - `/collections`
   - `/exports`
2. Single-profile mode:
   - hard-lock to one explore route
   - optionally allow collections/export for that profile.
3. Rename product language:
   - from `dataset/scope/pipeline`
   - to `archive/index/views`.

### Reorganize backend/code
1. Split modules by product function:
   - `twitter_import` (zip/community/local-extracted JSON)
   - `twitter_normalize` (tweets, likes, notes)
   - `index_builder` (embedding/umap/cluster)
   - `explorer_api` (query, filter, neighbors, graph)
   - `ownership_api` (export/delete)
2. Keep pipeline internals but expose one job type: `build_index`.
3. Add a versioned schema contract for normalized records (`schema_version`).

### Hard product cut
1. Focus entity types:
   - `tweet`
   - `like`
   - `note_tweet`
2. Defer everything else until these are strong.

---

## 2) What to add for interoperability and data ownership

### Interoperability
1. Add first-class likes ingestion from native archive (`data/like.js`).
2. Add stable export formats:
   - `normalized.parquet`
   - `normalized.jsonl`
   - `curated_lists.json`
   - `scope_bundle.json` (view config + labels + cluster metadata)
3. Add “knowledge pack” zip export containing all outputs.
4. Add simple external APIs:
   - `/api/records`
   - `/api/search`
   - `/api/collections`
   - `/api/export/knowledge-pack`
5. Add Markdown export for Obsidian-compatible workflows.

### Data ownership
1. Default to deleting raw uploads after normalization/indexing.
2. Add one-click “delete all my data” per dataset.
3. Show explicit retention policy at import time.
4. Add “download my full pack” button on dataset pages.
5. Include provenance metadata in exports:
   - import source
   - import timestamp
   - filters used
   - pipeline version

### Make outputs useful (not just visual)
1. Collections workflow:
   - save tweets/likes to named collections
   - attach notes/tags
   - export as markdown/jsonl
2. Action views:
   - resurfaced ideas
   - recurring topics over time
   - most-liked-by-you by theme
3. Publish outputs:
   - thread draft packs
   - reading-list packs
   - periodic knowledge digest exports

---

## Suggested execution plan

### Sprint A: Focus + cuts
1. Hide/remove non-core routes in hosted/public.
2. Add likes ingestion.
3. Unify record model (`tweet|like|note_tweet`).

### Sprint B: Ownership
1. Add knowledge-pack export.
2. Add retention/deletion controls.
3. Add provenance metadata to all exports.

### Sprint C: Usefulness
1. Build collections UI + API.
2. Add Markdown/Obsidian export.
3. Add action views (resurfacing + topic timelines).

---

## Optional next step
Convert this into an implementation backlog with P0/P1/P2 priorities, effort estimates, and file-level task mapping.
