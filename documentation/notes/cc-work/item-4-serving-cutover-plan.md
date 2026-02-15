# Item 4 — Serving cutover: remove parquet fallback for view/scope rows

Date: 2026-02-15

Problem:
Even after the view-first endpoints exist (`/datasets/:dataset/views/:view/rows`), the legacy
scope bootstrap route (`/datasets/:dataset/scopes/:scope/parquet`) still includes a multi-source ladder:

1) try LanceDB table
2) fall back to `scopes/{scope}-input.parquet`

This keeps an implicit runtime dependency on flat-file artifacts and increases cognitive load:
engineers must reason about two storage contracts and failure modes for the same request path.

Goal:
Complete the read-side cutover by making scope/view row serving **LanceDB-only** (local-first),
removing the parquet fallback path.

Non-goals:
- Removing all scope-named routes (full “Scope → View” rename is separate).
- Removing other parquet uses (e.g. cluster label parquet endpoints).
- Changing the write-side pipeline to stop producing `*-input.parquet` (still required by `export_lance.py`).

---

## Plan

1. In `api/src/routes/views.ts`, change `GET /datasets/:dataset/scopes/:scope/parquet` to:
   - resolve the Lance table id
   - query and return rows from LanceDB
   - on failure, return a typed 404 (no parquet fallback)
2. Keep the view-first endpoints as-is:
   - `/datasets/:dataset/views/:view/rows` already has no parquet fallback
3. Add minimal observability:
   - log the underlying error before returning the 404 (for debugging corrupted/missing tables)
4. CC review the implementation diff and commit.

Acceptance checks:
- In local mode (`LATENT_SCOPE_DATA` set, no `LANCEDB_URI`), both:
  - `/datasets/:dataset/views/:view/rows`
  - `/datasets/:dataset/scopes/:scope/parquet`
  serve from local LanceDB (or 404 if missing).
- No request path reads `scopes/*-input.parquet` at runtime for row serving.

Proxy mode note:
- This change affects only non-proxy mode (local serving). In proxy mode, all `/scopes/*` and `/views/*`
  reads are forwarded to the upstream API. The upstream must already have the LanceDB serving cutover applied,
  and older upstreams may still serve parquet-based responses.
