# Item 6 — Harden jobs execution (no `shell=True`, safe deletes)

Date: 2026-02-15

Problem:
Even after decomposing `jobs.py`, job execution still relies on:
- `subprocess.Popen(..., shell=True)` with a string command
- delete routes generating `rm -rf` shell strings (with globs and `;` chaining)

This increases cognitive complexity (quoting + parsing + shell semantics), makes behavior harder to
reason about, and expands the blast radius for injection/path bugs.

Goal:
Keep the same HTTP routes and job JSON UX, but harden execution:
- Run subprocess jobs with `shell=False` and explicit `argv`
- Run delete jobs as **Python filesystem operations** restricted to `{DATA_DIR}/{dataset}/...`

Also reduce dead surface area:
- Remove SAE training/delete job routes (`/api/jobs/sae`, `/api/jobs/delete/sae`) if unused.

Non-goals:
- Full auth/permission system for jobs
- Introducing a job queue/worker (keep current thread-per-job model)
- Changing response shapes or endpoint paths

---

## Plan

### Phase A — Introduce explicit job specs (internal)

In `latentscope/server/jobs_runner.py`:
- Support a structured `job_spec`:
  - `kind="subprocess"`: `{ argv: string[], display_command: string }`
  - `kind="delete"`: `{ globs: string[], display_command: string }`
- Persist `argv` into the job JSON for subprocess jobs (keep `command` as the human-readable string).
- Keep parsing of `RUNNING:`, `FINAL_SCOPE:`, `IMPORTED_ROWS:` output lines unchanged.

Backward compatibility:
- Rerun should prefer `argv` if present; otherwise parse legacy `command` via `shlex.split`.
- Legacy delete `command` strings starting with `rm -rf` (and `; rm -rf ...`) should be translated into a delete spec.

### Phase B — Routes build `argv` instead of shell strings

In `latentscope/server/jobs_routes.py`:
- Replace string command construction for non-delete routes with `argv` lists.
- Compute `display_command` with `shell_join(argv)` for job JSON/debug output.
- Replace delete routes (`/delete/*`) to use delete specs (globs), not `rm -rf` subprocesses.
- Remove SAE-only job routes (`/sae`, `/delete/sae`) and associated delete-cascade helpers if confirmed unused.
- SAE note:
  - No backward compatibility for historical SAE layouts.
  - Assume current `{DATA_DIR}/{dataset}/saes/` layout and UMAP JSON including `embedding_id`.

### Phase C — Implement safe delete execution

In `jobs_runner.py` delete execution:
- Expand `globs` to concrete paths.
- For each match, enforce `realpath(match).startswith(realpath(DATA_DIR/dataset) + os.sep)` before deletion.
- Delete files with `os.remove` and directories with `shutil.rmtree`.
- Record progress lines (what was deleted / what was skipped).

### Phase D — Tests

Add unit tests:
- `job_spec` translation for legacy `incremental_links` behavior stays unchanged.
- Legacy `rm -rf ...; rm -rf ...` command translates into the expected delete globs.
- Delete executor refuses to delete paths outside `{DATA_DIR}/{dataset}`.

Acceptance checks:
- `uv run --with pytest pytest -q latentscope/tests` passes.
- `latentscope/server/app.py` imports still work unchanged (`from .jobs import jobs_bp, jobs_write_bp`).
- No `shell=True` remains in `latentscope/server/jobs_runner.py`.

### Phase E — CC review + commit

1) CC reviews this plan.
2) Implement + tests.
3) CC reviews diff for behavior parity + safety.
4) Commit.
