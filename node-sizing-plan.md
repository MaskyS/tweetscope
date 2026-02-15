# Node Sizing Plan

## Goal
Make node size meaningful for exploration and curation in latent space, not just generic popularity.

This app’s purpose is to explore clustered embeddings and inspect representative + surprising examples. Sizing should help answer:
- What is most representative of a cluster?
- What is unusually interesting inside a cluster?
- What changed recently?
- Which points are strongly activated by a selected feature?

## Current State
- Point radius is currently based mainly on engagement (likes/retweets) with log transform + winsorization.
  File: `web/src/components/Explore/V2/DeckGLScatter.jsx`
- Cluster-level metrics (`count`, `likes`) are computed and available.
  File: `web/src/contexts/ScopeContext.jsx`
- Twitter rows include usable metadata for richer scoring:
  `favorites`, `retweets`, `replies`, `tweet_type`, `created_at`, `is_reply`, `is_retweet`, `is_like`.
  File: `latentscope/importers/twitter.py`

## Sizing Principles
1. Size should encode exploration salience, not only social popularity.
2. Normalize within cluster first, then blend with global percentile for comparability.
3. Keep range conservative to avoid overlap noise.
4. Interaction state should still rely on stroke/alpha, not extreme size jumps.
5. Different analytical tasks need different sizing modes.

## Proposed Default: Composite Exploration Salience
Use a weighted composite:

`score = 0.45 * representativeness + 0.35 * engagement + 0.20 * novelty`

- `representativeness`:
  Inverse distance to cluster centroid (or medoid) in UMAP space.
  Higher score means more canonical example for that topic.
- `engagement`:
  Blend of within-cluster percentile and global percentile.
  Example:
  `engagement = 0.6 * engagement_pct_cluster + 0.4 * engagement_pct_global`
- `novelty`:
  Local sparsity/outlier proxy (e.g., kNN distance in 2D UMAP).
  Gives slight prominence to edge cases worth inspection.

## Size Modes (User-Selectable)
Add `nodeSizeMode` in view settings:

1. `Balanced` (default)
- Composite score above.
- Best for day-to-day exploration.

2. `Representative`
- Prioritize centroid proximity.
- Useful for summarizing cluster themes quickly.

3. `Discovery`
- Prioritize novelty/outlierness + recency.
- Useful for finding exceptions/new threads.

4. `Influence`
- Engagement-heavy mode (closest to today’s behavior), but with per-cluster normalization.
- Useful when analyzing reach/attention.

5. `Feature`
- Keep existing feature-activation boost behavior when a feature is selected.
- Useful for SAE/feature-driven analysis.

## Concrete Scoring Details
### Engagement score
- Raw: `log1p(favorites + 0.7 * retweets + 0.4 * replies)`
- Convert to percentiles:
  - Global percentile across all visible points.
  - Cluster percentile within each cluster.
- Blend as above.

### Representativeness score
- Precompute cluster centroids from point coordinates.
- Distance metric: Euclidean in current UMAP space.
- Score: `1 - normalized_distance_to_centroid` (clamped 0..1).

### Novelty score
- Compute kNN radius (`k=8..16`) in UMAP space.
- Higher local radius => more isolated => higher novelty.
- Winsorize and percentile-normalize.

### Recency modifier (optional in Discovery mode)
- Apply mild boost for recent points:
  `recency_boost in [0, 0.15]`
- Keep small to avoid overpowering cluster semantics.

## Radius Mapping
- Convert final score (0..1) with eased mapping:
  `radius = minR + (maxR - minR) * score^0.72`
- Suggested bounds:
  - Dense scopes: `0.8 .. 7.5`
  - Sparse scopes: `1.0 .. 8.5`
- Keep hover boost modest (`+1.5 .. +2.0` max).

## What Should Not Drive Size
- Raw likes alone.
- Cluster count alone.
- Large hardcoded jumps by tweet type.
- Multi-signal stacking without normalization.

## Implementation Plan
1. Add UI control
- Add `nodeSizeMode` to `vizConfig` in `VisualizationPane`.
- Options: `balanced`, `representative`, `discovery`, `influence`, `feature`.

2. Extend point preprocessing
- In `DeckGLScatter`, precompute:
  - cluster centroids
  - engagement global + per-cluster percentile arrays
  - novelty array (kNN approximation)

3. Replace single radius logic
- Replace current engagement-only mapping with mode-based scorer.
- Keep current feature-activation multiplier in `feature` mode and when feature filter is active.

4. Add safe fallback behavior
- Missing metadata => fallback to centroid/cluster-only score.
- Unknown cluster => neutral score.

5. Validate with diagnostics
- Add temporary debug stats in dev:
  - score histograms
  - top-N sized points per cluster
- Ensure no single cluster monopolizes visual area.

## Rollout Strategy
1. Ship `Balanced` + `Influence` first.
2. Add `Representative` and `Discovery` after quick user validation.
3. Tune weights with real datasets (survey, issues/PRs, Twitter imports).

## Success Criteria
- Canonical points in each cluster are easier to spot.
- High-engagement outliers remain visible but not overwhelming.
- Clicking into a cluster shows meaningful size variation inside that cluster.
- Dense regions stay readable (no constant overlap from oversized nodes).
