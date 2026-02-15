from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from datetime import datetime
from typing import Any

from . import jobs_store


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


TIMEOUT = _env_int("LATENT_SCOPE_JOB_TIMEOUT_SEC", 60 * 30)  # default 30 minutes

# Shared mutable state across request threads and job threads.
# `run_job()` registers processes here; the `/kill` route reads from it.
PROCESSES: dict[str, subprocess.Popen[str]] = {}


def update_job_from_output_line(job: dict[str, Any], output: str) -> None:
    if "RUNNING:" in output:
        run_id = output.strip().split("RUNNING: ")[1]
        job["run_id"] = run_id
    if "FINAL_SCOPE:" in output:
        job["scope_id"] = output.strip().split("FINAL_SCOPE:")[1].strip()
    if "IMPORTED_ROWS:" in output:
        imported_rows = output.strip().split("IMPORTED_ROWS:")[1].strip()
        try:
            job["imported_rows"] = int(imported_rows)
        except ValueError:
            job["imported_rows"] = imported_rows


def kill_process(job_id: str) -> bool:
    proc = PROCESSES.get(job_id)
    if not proc:
        return False
    proc.kill()
    return True


def run_job(dataset: str, job_id: str, command: str, cleanup_paths: list[str] | None = None) -> None:
    if not jobs_store.DATA_DIR:
        raise RuntimeError("LATENT_SCOPE_DATA must be set")

    jobs_store.ensure_job_dir(dataset)
    progress_file = os.path.join(jobs_store.DATA_DIR, dataset, "jobs", f"{job_id}.json")  # type: ignore[arg-type]
    print("command", command)

    job_name = command.split(" ")[0]
    if "ls-" in job_name:
        job_name = job_name.replace("ls-", "")
    job: dict[str, Any] = {
        "id": job_id,
        "dataset": dataset,
        "job_name": job_name,
        "command": command,
        "status": "running",
        "last_update": str(datetime.now()),
        "progress": [],
        "times": [],
    }

    with open(progress_file, "w") as f:
        json.dump(job, f)

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        shell=True,
        encoding="utf-8",
        env=env,
        bufsize=1,
    )
    PROCESSES[job_id] = process

    last_output_time = time.time()
    timed_out = False

    while True:
        output = process.stdout.readline()  # type: ignore[union-attr]
        current_time = time.time()
        print(current_time, current_time - last_output_time, TIMEOUT)
        print("output", output)

        if output == "" and process.poll() is not None:
            break
        if output:
            print(output.strip())
            update_job_from_output_line(job, output)
            job["progress"].append(output.strip())
            job["times"].append(str(datetime.now()))
            job["last_update"] = str(datetime.now())
            with open(progress_file, "w") as f:
                json.dump(job, f)
            last_output_time = current_time
        elif current_time - last_output_time > TIMEOUT:
            print(f"Timeout: No output for more than {TIMEOUT} seconds.")
            print("OUTPUT", output)
            job["progress"].append(output.strip())
            job["progress"].append(f"Timeout: No output for more than {TIMEOUT} seconds.")
            job["status"] = "error"
            timed_out = True
            try:
                process.terminate()
                process.wait(timeout=10)
            except Exception:
                process.kill()
            break

    if process.returncode is None:
        process.wait()

    if not timed_out:
        job["status"] = "completed" if process.returncode == 0 else "error"

    if cleanup_paths:
        cleanup_errors: list[str] = []
        for path in cleanup_paths:
            if not path:
                continue
            try:
                if os.path.isdir(path):
                    shutil.rmtree(path, ignore_errors=False)
                elif os.path.exists(path):
                    os.remove(path)
            except Exception as err:
                cleanup_errors.append(f"{path}: {err}")
        if cleanup_errors:
            job["progress"].append("Cleanup errors:")
            job["progress"].extend(cleanup_errors)
        else:
            job["progress"].append("Cleaned up temporary upload files.")

    PROCESSES.pop(job_id, None)
    jobs_store.write_job(dataset, job_id, job)
