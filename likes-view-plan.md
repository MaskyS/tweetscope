# Likes View Plan (Post-Launch)

Date: 2026-02-11
Status: Post-launch feature. Not required for initial refactor cutover.
Parent: `refactor-plan.md` Section 9, item 2.

## 1. Decision

Likes get their own separate map, not mixed with posted tweets.

### Rationale

- Likes are ~80% of archive volume (sheik-tweets: 7,767 likes vs 2,161 tweets; Visa's archive likely 100k+ likes).
- Likes carry no original text, no reply/quote edges, and minimal exploration value when mixed with authored content.
- Mixing likes into the same scatter plot dilutes cluster quality — clusters become "things I liked about X" rather than "things I wrote about X."
- Likes ARE interesting as a separate artifact: "what topics does this person engage with?" is a valid question, but it deserves its own UMAP projection and cluster tree, not a filter on the main map.

## 2. Data Model (launch-ready, no extra work)

Likes are stored in `records` from day one:
- `record_type = 'like'`
- `record_id` = synthetic like ID (from archive)
- `text` = NULL (the liked tweet's text is NOT in the user's archive)
- `reply_to_record_id` = NULL (likes have no edges)
- `quoted_record_id` = NULL
- All edge-related fields are empty for likes.

Default `build_view` filter: `record_type IN ('tweet', 'note_tweet')` — likes excluded from the main map.

## 3. Text Acquisition Problem

The core challenge: **likes in the archive are just tweet IDs. The liked tweet's text is not included in the X/Twitter archive export.**

Without text, likes cannot be meaningfully embedded or clustered.

### Options for text acquisition

| Option | Mechanism | Pros | Cons |
|---|---|---|---|
| **(a) API fetch at import time** | Use X API v2 to fetch liked tweet text by ID during import | Most complete text | Requires API access; rate limits (~100 tweets/15min on free tier); liked tweets may be deleted |
| **(b) Community Archive lookup** | Cross-reference like IDs against community archive (if user has access) | No API needed; covers public tweets | Only works if liked tweet exists in community archive; coverage varies |
| **(c) URL-as-proxy** | Construct `https://x.com/i/status/{tweet_id}` and use it as minimal text | Zero external dependencies | Not real text; embedding quality will be poor |
| **(d) Skip embedding for textless likes** | Likes without resolved text are stored in `records` but excluded from likes view | Clean data; no garbage embeddings | Likes view may be empty or sparse until text is resolved |
| **(e) Deferred enrichment** | Store likes with NULL text; enrich later via API/community in background | Decouples import from enrichment | Likes view is empty until enrichment runs |

### Recommended strategy

**Default: (d) — skip textless likes from the view.**

Likes exist in `records` for completeness (counts, metadata, record_type filtering). But the likes VIEW only includes likes where `text IS NOT NULL`. This ensures clustering consistency — no garbage embeddings from empty or proxy text.

**Enrichment path: (a) or (b) as optional post-import step.**

- `enrich_likes` stage: attempts to resolve liked tweet text via API or community archive.
- Runs asynchronously after import.
- Likes with resolved text become eligible for the likes view on next `build_view`.
- Likes without resolved text remain in `records` but are excluded from visualization.

This means the likes view grows over time as text is resolved — a natural progressive enrichment.

## 4. Likes View Build

Once likes have text, the view build is identical to the tweets view:

1. Filter: `record_type = 'like' AND text IS NOT NULL AND dataset_id = ?`
2. Embed: only likes with missing vectors (incremental, same as tweets)
3. UMAP: project likes into their own 2D manifold
4. Cluster: cluster the likes point cloud
5. Label: generate cluster labels from liked tweet text
6. Materialize: write `view_points` and `cluster_nodes` for the likes view

The likes view has its own `view_id`, independent of the tweets view.

## 5. UI Design

- Two map tabs or a map switcher: "My Tweets" (default) | "My Likes"
- Each tab loads its own view (own scatter, own cluster tree, own labels)
- Thread/quote navigation from the likes map should cross-reference the tweets map: "you liked this tweet; here's where it sits in your tweets map" (if the liked tweet is also in your archive)
- Likes map cluster labels should reflect consumption patterns: "AI/ML papers you engage with", "friends' personal updates", etc.

## 6. Open Questions

1. What fraction of likes in a typical archive can be resolved via community archive vs API?
2. Should the likes view show engagement intensity (like count × recency) as point size?
3. Should likes-of-your-own-tweets be excluded from the likes view (they're already in the tweets view)?
4. Is there value in a combined "engagement graph" that connects liked tweets to authored tweets by topic similarity?
