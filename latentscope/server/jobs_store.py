from __future__ import annotations

"""
Job progress persistence.

Each job writes a JSON file at:
  {LATENT_SCOPE_DATA}/{dataset}/jobs/{job_id}.json

The schema is intentionally loose (dict) but the runner and routes coordinate on
these common fields:
- id, dataset, job_name, command
- status: running|completed|error|dead
- last_update, progress (list[str]), times (list[str])
- optional: run_id (from "RUNNING:" output), scope_id (from "FINAL_SCOPE:"), imported_rows
- optional: cause_of_death (set by /kill)
"""

import json
import os
import time
from typing import Any

DATA_DIR = os.getenv("LATENT_SCOPE_DATA")


def _require_data_dir() -> str:
    if not DATA_DIR:
        raise RuntimeError("LATENT_SCOPE_DATA must be set")
    return DATA_DIR


def ensure_job_dir(dataset: str) -> str:
    data_dir = _require_data_dir()
    job_dir = os.path.join(data_dir, dataset, "jobs")
    os.makedirs(job_dir, exist_ok=True)
    return job_dir


def job_progress_path(dataset: str, job_id: str) -> str:
    job_dir = ensure_job_dir(dataset)
    return os.path.join(job_dir, f"{job_id}.json")


def write_job(dataset: str, job_id: str, job: dict[str, Any]) -> None:
    path = job_progress_path(dataset, job_id)
    with open(path, "w") as f:
        json.dump(job, f)


def read_job(dataset: str, job_id: str) -> dict[str, Any]:
    path = job_progress_path(dataset, job_id)
    with open(path, "r") as f:
        try:
            return json.load(f)
        except Exception:
            # Preserve legacy behavior: brief sleep and retry if the file is mid-write.
            time.sleep(0.1)
    with open(path, "r") as f:
        return json.load(f)


def list_jobs(dataset: str) -> list[dict[str, Any]]:
    data_dir = _require_data_dir()
    job_dir = os.path.join(data_dir, dataset, "jobs")
    out: list[dict[str, Any]] = []
    if not os.path.exists(job_dir):
        return out
    for file in os.listdir(job_dir):
        if not file.endswith(".json"):
            continue
        with open(os.path.join(job_dir, file), "r") as f:
            out.append(json.load(f))
    return out
