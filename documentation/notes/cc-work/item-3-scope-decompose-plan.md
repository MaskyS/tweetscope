# Item 3 — Decompose `scope.py` into pipeline stages

Date: 2026-02-15

Problem:
`latentscope/scripts/scope.py` mixes multiple bounded concerns in one linear procedure:
- ID allocation + overwrite semantics
- scope meta assembly (dataset/embedding/umap/cluster/labels files)
- hierarchical vs flat cluster-label transformation (+ unknown count derivation)
- tile index generation for map rendering
- view row materialization (`*-input.parquet`) + schema normalization + contract validation
- side effects (writes scope JSON, writes parquet, exports to LanceDB)

This forces engineers to reason about many independent invariants at once and makes
targeted changes risky.

Goal:
Reduce cognitive complexity by extracting single-purpose stage modules and keeping
`latentscope/scripts/scope.py` as a thin CLI + backwards-compatible wrapper.

Non-goals:
- Changing the external CLI or the `scope()` signature (twitter_import depends on it).
- Changing behavior/outputs (aside from superficial ordering/formatting).
- Fixing semantic questions (e.g. whether overwriting a scope should reuse scope_uid).

---

## Plan (Implementation)

### Phase A — Create stage modules (pure-ish helpers)

Add a new package:
- `latentscope/pipeline/`
  - `contracts/scope_input.py`
  - `stages/tiles.py`
  - `stages/scope_ids.py`
  - `stages/scope_meta.py`
  - `stages/scope_labels.py`
  - `stages/scope_materialize.py`
  - `scope.py` (orchestrator)

Responsibilities:
- `contracts/scope_input.py`: `load_contract()`, `normalize_serving_types()`, `validate_scope_input_df()`
  (moved out of `scope.py` unchanged).
- `stages/tiles.py`: `make_tiles(x, y, num_tiles)` (moved out unchanged).
- `stages/scope_ids.py`: `resolve_scope_id(scopes_dir, scope_id=None)` (keeps existing numbering scheme).
- `stages/scope_meta.py`: functions to load and assemble the scope JSON metadata
  (dataset/embedding/umap/cluster/cluster_labels(+default)/optional sae).
- `stages/scope_labels.py`: build `cluster_labels_lookup` for both flat + hierarchical (Toponymy) labels,
  including `unknown_count` derivation.
- `stages/scope_materialize.py`: build `scope_parquet` (umap+cluster+tiles+deleted+ls_index) and
  build/write the serving parquet `*-input.parquet` with contract normalization + validation.
- `pipeline/scope.py`: `run_scope(...)` orchestrates the above and performs side effects.

Acceptance checks:
- `latentscope/scripts/scope.py` retains `main()` + `scope()` entrypoints with identical args.
- `latentscope/scripts/twitter_import.py` continues to import/call `latentscope.scripts.scope.scope`.
- Running `ls-scope` still writes the same output artifacts (scope JSON + `*-input.parquet`) and calls
  `export_lance(DATA_DIR, dataset_id, scope_id)` as before.

### Phase B — Tests for extracted logic

Add small unit tests to lock in behavior for the extracted pieces that are easy to test locally:
- `make_tiles()` mapping invariants and edge clamping.
- Contract normalization + validation for a tiny DataFrame (types + non-nullable defaults).

Acceptance checks:
- `uv run --with pytest pytest -q latentscope/tests` passes.

### Phase C — CC review loop

1) CC reviews this plan.
2) Implement refactor + tests.
3) CC reviews the diff for behavioral risk and import compatibility.
4) Commit.

---

## Rollout note (future)

Once stable, later pipeline work can introduce explicit stage CLI commands (ingest/embed/umap/cluster/scope/export)
that call the orchestrator stages directly, but this item only decomposes internals.

