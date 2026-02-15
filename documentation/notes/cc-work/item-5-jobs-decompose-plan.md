# Item 5 — Decompose `latentscope/server/jobs.py`

Date: 2026-02-15

Problem:
`latentscope/server/jobs.py` mixes multiple bounded concerns in one file:
- Flask request parsing + endpoint wiring
- command construction (string + quoting)
- subprocess lifecycle + timeouts + output streaming
- job progress persistence to `{DATA_DIR}/{dataset}/jobs/{job_id}.json`
- kill/rerun semantics + temporary upload cleanup

This creates high cognitive load: changing one endpoint risks breaking process management,
and process changes require re-reading route code.

Goal:
Split `jobs.py` into small modules with clear responsibilities while preserving endpoint
paths and behavior.

Non-goals:
- Redesigning the job system (no queue, no new DB).
- Changing URL paths, HTTP methods, or response shapes.
- Hardening shell usage in this item (keep current string-command behavior; safety improvements can be follow-up).

---

## Plan

### Phase A — Extract modules

Create:
- `latentscope/server/jobs_store.py`: job file paths + read/write helpers + list jobs.
- `latentscope/server/jobs_runner.py`: `run_job(...)` subprocess loop, timeout handling, output parsing, cleanup, `PROCESSES`.
- `latentscope/server/jobs_commands.py`: pure helpers to build command strings for each endpoint and parse common flags.
- `latentscope/server/jobs_delete.py`: dependency discovery for cascade deletes (embedding → umaps/saes, umap → clusters) + delete command builders.
- `latentscope/server/jobs_routes.py`: Flask Blueprints + route handlers only (delegates to commands + runner).

Keep `latentscope/server/jobs.py` as a thin facade that re-exports:
- `jobs_bp`, `jobs_write_bp` (for `latentscope/server/app.py`)

Acceptance checks:
- `latentscope/server/app.py` continues to work unchanged (`from .jobs import jobs_bp, jobs_write_bp`).
- All existing routes remain available with the same URL + method.
- `PROCESSES` is a singleton shared between `run_job` and `/kill` (routes import it from `jobs_runner.py`).
- A single canonical `DATA_DIR` value is used across modules (exported from `jobs_store.py`).

### Phase B — Add focused unit tests

Add tests for extracted, deterministic logic:
- Output-line parser updates job fields when encountering:
  - `RUNNING:`
  - `FINAL_SCOPE:`
  - `IMPORTED_ROWS:`
- `kill_job` uses the same `PROCESSES` dict as the runner (unit test via a fake process object).
- Cascade-delete dependency discovery (smoke-level using temp dirs + small JSON fixtures).
- Command builders produce stable strings (smoke-level; no end-to-end subprocess tests).

Acceptance checks:
- `uv run --with pytest pytest -q latentscope/tests` passes.

### Phase C — CC review loop + commit

1) CC reviews this plan.
2) Implement refactor + tests.
3) CC reviews the diff for behavior parity risks.
4) Commit.
