# Item 6 — Tests (Milestone A contract/policy) Implementation Plan

Date: 2026-02-15

Goal: add a minimal regression suite so we can safely delete serving fallbacks and simplify code paths.

Scope (this change):
- Unit tests for `validate_extracted_archive_payload()` acceptance + rejection cases.
- A policy test that `latentscope/server/jobs.py` rejects `source_type=zip` on `/import_twitter`.

Constraints:
- Keep tests runnable without adding new heavyweight infra.
- Use `uv` to provide a consistent test runner without adding repo-wide dev deps.

Steps:
1. Implement validator unit tests (happy path + failure cases for wrong format, missing fields, count mismatches, empty tweets+likes).
2. Implement `/import_twitter` route tests (Flask test client):
   - `source_type=zip` rejects with 400 (policy).
   - `source_type=community_json` rejects invalid payload (proves validator is called from the route).
   - `source_type=community_json` accepts valid payload (patch `threading.Thread` to avoid spawning a real job).
3. Provide a repo-local command to run just these tests:
   - `uv run -p .venv/bin/python --with pytest pytest -q latentscope/tests`

Acceptance checks:
- Tests pass under the repo’s `.venv` Python.
- Route tests do not spawn subprocesses/threads.
