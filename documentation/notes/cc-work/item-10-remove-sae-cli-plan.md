# Item 10 — Remove SAE CLI/script surface (unused)

Date: 2026-02-15

Problem:
We no longer use SAE training/jobs in this repo, but the codebase still ships:
- `latentscope/scripts/sae.py` (training script)
- `ls-sae` console entry point
- `latentsae` dependency

This adds dead surface area and creates mental overhead when navigating the pipeline.

Goal:
Remove SAE training CLI surface cleanly:
- Delete `latentscope/scripts/sae.py`
- Remove `ls-sae` from `setup.py` console scripts
- Remove `latentsae` from `requirements.txt`
- Remove any unused imports that referenced `latentsae` (e.g. `latentscope/server/search.py`)

Non-goals:
- Removing all SAE read/serving support (`sae_id` parameters, reading `saes/*.h5` artifacts) — that can be a follow-up if desired.

---

## Plan

1) CC reviews this plan.
2) Implement deletions/cleanup.
3) Run Python validation:
   - `python -m py_compile` on touched modules
   - `uv run --with pytest pytest -q latentscope/tests`
   - `uv run python3 -c "from latentscope.server.search import search_bp"`
4) CC reviews the diff.
5) Commit.
