# Reply + Quote Edges Plan (Detailed)

## Goal
Add a practical edge layer to Explore that shows:
1. Reply relationships (`tweet -> parent tweet`)
2. Quote relationships (`tweet -> referenced tweet URL status id`)

This should fit the existing map + feed UI, not create a new product surface.

## Non-goals
- No follower/following graph.
- No mention/domain/like graph in this phase.
- No separate graph page.

## User outcomes
1. From a selected tweet, see its local thread context immediately.
2. See what it quotes and what quotes it (when both tweets are in dataset).
3. Visualize these links directly on the existing scatter map.

---

## 1) Data inputs and exact source fields

## Dataset row source
Use normalized dataset rows already produced by import + ingest (`input.parquet` / scope rows).

Required columns (already present for tweets):
- `id`
- `in_reply_to_status_id`
- `tweet_type`
- `urls_json`
- `ls_index` (from scope rows / lookup)

Where they come from today:
- Reply ids and url lists are created in `latentscope/importers/twitter.py` (`in_reply_to_status_id`, `urls_json`).
- Privacy-mode browser import preserves URL structure via `web/src/lib/twitterArchiveParser.js`.

## Quote target derivation source
Quote edges are derived from URLs in:
- tweet `entities.urls[].expanded_url`
- note tweet `core.urls[].expandedUrl`

These are already flattened into `urls_json`.

---

## 2) Edge derivation spec

## 2.1 Canonical tweet id rules
- Normalize all tweet ids to string.
- Ignore rows where `id` is empty.
- For edge overlay on map, only use rows where `tweet_type in ('tweet', 'note_tweet')`.

Build maps:
- `tweet_id_to_ls_index`
- `ls_index_to_point` (from scope rows: x/y)

## 2.2 Reply edges
For each source row:
- `src_tweet_id = row.id`
- `dst_tweet_id = row.in_reply_to_status_id` (if present)
- Emit `edge_kind='reply'`

Fields:
- `src_tweet_id`, `dst_tweet_id`
- `src_ls_index` (required)
- `dst_ls_index` (nullable if target not in dataset)
- `internal_target = dst_tweet_id in tweet_id_to_ls_index`

Dedupe key:
- `(edge_kind, src_tweet_id, dst_tweet_id)`

## 2.3 Quote edges
For each source row:
1. Parse `urls_json` (array of expanded URLs).
2. For each URL, normalize:
- lowercase host
- strip query and fragment
3. Match status patterns:
- `https://x.com/<user>/status/<id>`
- `https://twitter.com/<user>/status/<id>`
- `https://twitter.com/i/web/status/<id>`
4. Extract `<id>` as `dst_tweet_id`.
5. Ignore self-links (`src_tweet_id == dst_tweet_id`).
6. Emit `edge_kind='quote'`.

Fields:
- `src_tweet_id`, `dst_tweet_id`
- `src_ls_index`, `dst_ls_index` (nullable)
- `internal_target`
- `source_url` (original normalized URL used)

Dedupe key:
- `(edge_kind, src_tweet_id, dst_tweet_id)`

## 2.4 Thread metadata (for feed UX)
Derived from reply edges:
- `thread_root_id`
- `thread_depth`
- `thread_size`
- `reply_child_count`

Rules:
- If parent chain exits dataset, last known parent is external root boundary.
- Keep thread metrics for internal component only.

---

## 3) Output artifacts on disk

Create dataset folder:
- `<DATA_DIR>/<dataset>/links/`

Files:
1. `edges.parquet`
- `edge_kind` (`reply|quote`)
- `src_tweet_id`, `dst_tweet_id`
- `src_ls_index`, `dst_ls_index`
- `internal_target` (bool)
- `source_url` (null for reply)

2. `node_link_stats.parquet`
- `tweet_id`
- `ls_index`
- `reply_out_count`, `reply_in_count`
- `quote_out_count`, `quote_in_count`
- `thread_root_id`, `thread_depth`, `thread_size`, `reply_child_count`

3. `meta.json`
- counts by edge type
- internal/internal edge counts
- build timestamp and version

---

## 4) Backend/API plan

## 4.1 Build script
Add:
- `latentscope/scripts/build_links_graph.py`

Input:
- dataset id
- optional scope id (if needed for ls_index mapping)

Output:
- writes `links/` artifacts above.

Add optional hook in twitter import pipeline:
- after scope creation, run links build automatically.

## 4.2 API endpoints
Add to datasets/search API:

1. `GET /api/datasets/<dataset>/links/meta`
- returns edge counts, availability.

2. `POST /api/datasets/<dataset>/links/by-indices`
- body: `{ indices: number[], edge_kinds: ['reply','quote'], include_external: false }`
- returns edges touching these indices (internal targets only for graph drawing by default).

3. `GET /api/datasets/<dataset>/links/thread/<tweet_id>`
- returns parent chain + descendants in same thread component.

4. `GET /api/datasets/<dataset>/links/quotes/<tweet_id>`
- returns outgoing and incoming quote neighbors.

---

## 5) Frontend integration (existing Explore)

## 5.1 Data flow
In `ScopeContext` or Explore container:
1. fetch `links/meta` on scope load.
2. fetch `node_link_stats` (or include via hover/indexed data path).
3. fetch edge subsets on demand based on selection/hover/filter.

## 5.2 Graph rendering
Use existing DeckGL pipeline:
- `DeckGLScatter` currently uses `ScatterplotLayer`, `PolygonLayer`, `TextLayer`.
- Add `LineLayer` for edges.

Edge rendering rules:
- `reply`: neutral thin line.
- `quote`: accent line (different color/alpha).
- Draw only when both endpoints have internal coordinates.
- Default mode: render edges only for selected/hovered neighborhood, not global full graph.

### Deck.gl implementation constraints (from docs)
- Use core `LineLayer` from `@deck.gl/layers` (stable core layer catalog).
- Use documented accessors:
  - `getSourcePosition`
  - `getTargetPosition`
  - `getColor`
  - `getWidth`
- Keep widths in pixel space for this UI:
  - `widthUnits: 'pixels'` (default in docs)
  - `widthScale` for global edge-thickness control (efficient global scaling)
  - clamp with `widthMinPixels` / `widthMaxPixels` to keep lines readable across zoom.
- Rely on base layer props inherited by `LineLayer` (e.g. visibility/picking/update behavior) instead of custom hacks.

### Proposed `LineLayer` profile
- `id: 'reply-edges-layer' | 'quote-edges-layer'`
- `data: edgeRenderData`
- `pickable: false` initially (turn on later only if edge-hover UX is added)
- `getSourcePosition: d => d.sourcePosition`
- `getTargetPosition: d => d.targetPosition`
- `getColor: d => d.color`
- `getWidth: d => d.width`
- `widthUnits: 'pixels'`
- `widthScale: edgeWidthScale`
- `widthMinPixels: 1`
- `widthMaxPixels: 6`
- `visible: showReplyEdges/showQuoteEdges`
- `updateTriggers` tied to edge toggles + style state

## 5.3 Controls in Explore
Add controls near existing map config:
- `Show reply edges` (toggle)
- `Show quote edges` (toggle)
- `Edge scope`: `selected only` | `hovered + selected` | `filtered set`
- `Max edges` slider (safety cap)

## 5.4 Feed/card integration
In `TweetCard` / hover card:
- badges: `Thread`, `Quotes`, `Quoted by`
- click `Thread` -> call thread endpoint and show inline chain in feed pane
- click `Quotes` -> show quote neighbors

### React integration note (from DeckGL docs)
- Keep using `<DeckGL layers={[...layerInstances]}>` pattern (same as current code).
- Avoid JSX layer syntax for this feature; docs mark JSX layer semantics as experimental and limited to direct children.
- Continue treating layer instances as memoized objects in React `useMemo`, matching current `DeckGLScatter` architecture.

---

## 6) Performance strategy

Default constraints:
1. Never render all edges globally by default.
2. Fetch/render neighborhood edges for:
- selected tweet
- hovered tweet
- optionally current filtered set (capped)
3. Cap draw count (for example 1k-5k edges configurable).
4. Cache recent neighborhoods client-side keyed by `(dataset, tweet_id, edge_kinds)`.

Server-side:
- Keep `edges.parquet` indexed in memory by `src_ls_index` and `dst_ls_index` when loaded.
- Return compact payload: only ids + coordinates needed for line layer.

---

## 7) Validation and QA plan

## Unit/data tests
For `build_links_graph.py`:
1. Reply extraction accuracy on fixture.
2. Quote URL regex extraction for `x.com`, `twitter.com`, `i/web/status`.
3. Dedupe correctness.
4. Internal/external target classification.

## Integration checks
1. Import a known archive, build links, assert non-zero reply and quote edges.
2. Spot-check a tweet with known reply parent.
3. Spot-check a tweet with known status URL quote.

## UX acceptance
1. Selecting a tweet shows connected reply/quote edges in <300ms from cache or <1s uncached.
2. `Thread` and `Quotes` actions open correct neighbors from the same dataset.
3. Edge toggles do not degrade normal map interaction.

---

## 8) Implementation sequence (file-level)

## Phase A: Data build (backend only)
1. Add `latentscope/scripts/build_links_graph.py`.
2. Hook into import pipeline (`latentscope/scripts/twitter_import.py`) after scope creation.
3. Add read endpoints in `latentscope/server/datasets.py` or `latentscope/server/search.py`.

Deliverable:
- `links/edges.parquet`, `links/node_link_stats.parquet`, `links/meta.json`
- API endpoints functional.

## Phase B: Map edges (frontend)
1. Add link API calls in `web/src/lib/apiService.js`.
2. Add link state + fetch orchestration in `web/src/pages/V2/FullScreenExplore.jsx` (or context).
3. Extend `web/src/components/Explore/V2/DeckGLScatter.jsx` with `LineLayer`.
4. Add controls in map config panel.

Deliverable:
- Reply/quote lines visible for selection/hover neighborhoods.

## Phase C: Feed actions
1. Add badges and actions in `web/src/components/Explore/V2/TweetFeed/TweetCard.jsx`.
2. Add thread/quote detail panel behavior in feed/sidebar.

Deliverable:
- One-click thread and quote traversal from cards.

---

## 9) Final scope for this plan
Commit to shipping now:
1. Reply edges
2. Quote edges (URL-derived)
3. Thread metadata for UX
4. Graph overlay on existing Explore

Everything else stays out until this proves useful.
