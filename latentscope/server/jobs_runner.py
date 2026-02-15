from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import glob
import shlex
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


def _job_name_from_argv(argv: list[str]) -> str:
    if not argv:
        return "job"
    job_name = argv[0]
    if "ls-" in job_name:
        job_name = job_name.replace("ls-", "")
    return job_name


def _parse_legacy_delete_globs(command: str) -> list[str] | None:
    """
    Translate legacy delete commands like:
      rm -rf /path/pattern*; rm -rf /path/other*
    into a list of glob patterns.
    """
    segments = [seg.strip() for seg in command.split(";") if seg.strip()]
    globs_out: list[str] = []
    for seg in segments:
        try:
            parts = shlex.split(seg)
        except Exception:
            return None
        if len(parts) < 3 or parts[0] != "rm":
            return None
        # Expect: rm -rf <pattern>
        pattern = parts[-1]
        globs_out.append(pattern)
    return globs_out


def _job_spec_from_legacy_command(command: str) -> dict[str, Any] | None:
    if command.strip().startswith("rm -rf"):
        globs_list = _parse_legacy_delete_globs(command)
        if not globs_list:
            return None
        return {"kind": "delete", "globs": globs_list, "display_command": command}

    try:
        argv = shlex.split(command)
    except Exception:
        return None
    return {"kind": "subprocess", "argv": argv, "display_command": command}


def _dataset_root(dataset: str) -> str:
    if not jobs_store.DATA_DIR:
        raise RuntimeError("LATENT_SCOPE_DATA must be set")
    return os.path.join(jobs_store.DATA_DIR, dataset)


def _is_safe_dataset_path(dataset: str, candidate_path: str) -> bool:
    if not jobs_store.DATA_DIR:
        return False
    root = os.path.realpath(_dataset_root(dataset))
    candidate = os.path.realpath(candidate_path)
    return candidate == root or candidate.startswith(root + os.sep)


def _run_delete_job(
    *, dataset: str, job: dict[str, Any], job_id: str, globs_list: list[str], progress_file: str
) -> None:
    deleted: list[str] = []
    skipped: list[str] = []
    errors: list[str] = []

    for pattern in globs_list:
        matches = glob.glob(pattern)
        if not matches:
            skipped.append(f"{pattern}: no matches")
            continue
        for match in matches:
            if not _is_safe_dataset_path(dataset, match):
                skipped.append(f"{match}: outside dataset root")
                continue
            try:
                if os.path.isdir(match) and not os.path.islink(match):
                    shutil.rmtree(match, ignore_errors=False)
                else:
                    os.remove(match)
                deleted.append(match)
                job["progress"].append(f"DELETED: {match}")
                job["times"].append(str(datetime.now()))
                job["last_update"] = str(datetime.now())
                with open(progress_file, "w") as f:
                    json.dump(job, f)
            except Exception as err:
                errors.append(f"{match}: {err}")

    if skipped:
        job["progress"].append("SKIPPED:")
        job["progress"].extend(skipped)
    if errors:
        job["progress"].append("ERRORS:")
        job["progress"].extend(errors)

    job["status"] = "completed" if not errors else "error"
    jobs_store.write_job(dataset, job_id, job)


def run_job(dataset: str, job_id: str, job_spec: Any, cleanup_paths: list[str] | None = None) -> None:
    if not jobs_store.DATA_DIR:
        raise RuntimeError("LATENT_SCOPE_DATA must be set")

    jobs_store.ensure_job_dir(dataset)
    progress_file = os.path.join(jobs_store.DATA_DIR, dataset, "jobs", f"{job_id}.json")  # type: ignore[arg-type]
    spec: dict[str, Any]
    if isinstance(job_spec, str):
        parsed = _job_spec_from_legacy_command(job_spec)
        if not parsed:
            raise ValueError("Unsupported legacy command format")
        spec = parsed
    elif isinstance(job_spec, dict):
        spec = job_spec
    else:
        raise ValueError("Unsupported job spec")

    kind = spec.get("kind")
    display_command = str(spec.get("display_command", ""))
    argv = spec.get("argv") if kind == "subprocess" else None
    delete_globs = spec.get("globs") if kind == "delete" else None

    if kind == "subprocess" and (not isinstance(argv, list) or not all(isinstance(x, str) for x in argv)):
        raise ValueError("Invalid subprocess argv")
    if kind == "delete" and (not isinstance(delete_globs, list) or not all(isinstance(x, str) for x in delete_globs)):
        raise ValueError("Invalid delete globs")

    print("command", display_command)

    job_name = _job_name_from_argv(argv or ["delete"])
    job: dict[str, Any] = {
        "id": job_id,
        "dataset": dataset,
        "job_name": job_name,
        "command": display_command,
        "status": "running",
        "last_update": str(datetime.now()),
        "progress": [],
        "times": [],
        "kind": kind,
    }
    if kind == "subprocess":
        job["argv"] = argv
    if kind == "delete":
        job["globs"] = delete_globs

    with open(progress_file, "w") as f:
        json.dump(job, f)

    if kind == "delete":
        return _run_delete_job(
            dataset=dataset,
            job=job,
            job_id=job_id,
            globs_list=delete_globs or [],
            progress_file=progress_file,
        )

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    process = subprocess.Popen(
        argv,  # type: ignore[arg-type]
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        shell=False,
        encoding="utf-8",
        env=env,
        bufsize=1,
    )
    PROCESSES[job_id] = process  # type: ignore[assignment]

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
        cleanup_skipped: list[str] = []
        for path in cleanup_paths:
            if not path:
                continue
            try:
                if not _is_safe_dataset_path(dataset, path):
                    cleanup_skipped.append(f"{path}: outside dataset root")
                    continue
                if os.path.isdir(path):
                    shutil.rmtree(path, ignore_errors=False)
                elif os.path.exists(path):
                    os.remove(path)
            except Exception as err:
                cleanup_errors.append(f"{path}: {err}")
        if cleanup_skipped:
            job["progress"].append("Cleanup skipped:")
            job["progress"].extend(cleanup_skipped)
        if cleanup_errors:
            job["progress"].append("Cleanup errors:")
            job["progress"].extend(cleanup_errors)
        else:
            job["progress"].append("Cleaned up temporary upload files.")

    PROCESSES.pop(job_id, None)
    jobs_store.write_job(dataset, job_id, job)
