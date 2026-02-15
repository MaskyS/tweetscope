import importlib
import io
import json
import os
import sys

from flask import Flask


def _valid_extracted_payload():
    return {
        "archive_format": "x_native_extracted_v1",
        "profile": {"username": "alice"},
        "tweets": [{"tweet": {"id_str": "1", "full_text": "hello"}}],
        "likes": [{"like": {"tweetId": "2"}}],
        "tweet_count": 1,
        "likes_count": 1,
        "total_count": 2,
    }


def test_import_twitter_passes_cleanup_paths_for_upload_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    import latentscope.server.jobs_store as jobs_store
    importlib.reload(jobs_store)

    import latentscope.server.jobs_routes as jobs_routes
    importlib.reload(jobs_routes)

    import latentscope.server.jobs as jobs
    importlib.reload(jobs)

    captured = {"cleanup_paths": None}

    def _capture_start(*, dataset, job_id, job_spec, cleanup_paths=None):  # type: ignore[no-untyped-def]
        captured["cleanup_paths"] = cleanup_paths

    monkeypatch.setattr(jobs_routes, "_start_job_thread", _capture_start)

    app = Flask(__name__)
    app.testing = True
    app.register_blueprint(jobs.jobs_write_bp, url_prefix="/api/jobs")

    client = app.test_client()
    res = client.post(
        "/api/jobs/import_twitter",
        data={
            "dataset": "test-dataset",
            "source_type": "community_json",
            "file": (
                io.BytesIO(json.dumps(_valid_extracted_payload()).encode("utf-8")),
                "payload.json",
            ),
            "run_pipeline": "false",
        },
        content_type="multipart/form-data",
    )
    assert res.status_code == 200

    cleanup_paths = captured["cleanup_paths"]
    assert isinstance(cleanup_paths, list)
    assert len(cleanup_paths) == 1
    assert "uploads" in cleanup_paths[0]


def test_rerun_uses_argv_when_available(tmp_path, monkeypatch):
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    import latentscope.server.jobs_store as jobs_store
    importlib.reload(jobs_store)

    import latentscope.server.jobs_routes as jobs_routes
    importlib.reload(jobs_routes)

    import latentscope.server.jobs as jobs
    importlib.reload(jobs)

    captured = {"job_spec": None}

    def _capture_start(*, dataset, job_id, job_spec, cleanup_paths=None):  # type: ignore[no-untyped-def]
        captured["job_spec"] = job_spec

    monkeypatch.setattr(jobs_routes, "_start_job_thread", _capture_start)

    dataset = "ds"
    jobs_store.ensure_job_dir(dataset)
    jobs_store.write_job(
        dataset,
        "job-1",
        {
            "id": "job-1",
            "dataset": dataset,
            "run_id": "run-123",
            "argv": ["ls-embed", dataset, "text", "model"],
        },
    )

    app = Flask(__name__)
    app.testing = True
    app.register_blueprint(jobs.jobs_write_bp, url_prefix="/api/jobs")

    client = app.test_client()
    res = client.get("/api/jobs/rerun", query_string={"dataset": dataset, "job_id": "job-1"})
    assert res.status_code == 200

    job_spec = captured["job_spec"]
    assert isinstance(job_spec, dict)
    assert job_spec.get("kind") == "subprocess"
    assert job_spec.get("argv")[-2:] == ["--rerun", "run-123"]


def test_rerun_splits_legacy_command_when_argv_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    import latentscope.server.jobs_store as jobs_store
    importlib.reload(jobs_store)

    import latentscope.server.jobs_routes as jobs_routes
    importlib.reload(jobs_routes)

    import latentscope.server.jobs as jobs
    importlib.reload(jobs)

    captured = {"job_spec": None}

    def _capture_start(*, dataset, job_id, job_spec, cleanup_paths=None):  # type: ignore[no-untyped-def]
        captured["job_spec"] = job_spec

    monkeypatch.setattr(jobs_routes, "_start_job_thread", _capture_start)

    dataset = "ds"
    jobs_store.ensure_job_dir(dataset)
    jobs_store.write_job(
        dataset,
        "job-legacy",
        {
            "id": "job-legacy",
            "dataset": dataset,
            "run_id": "run-456",
            "command": "ls-embed ds text model",
        },
    )

    app = Flask(__name__)
    app.testing = True
    app.register_blueprint(jobs.jobs_write_bp, url_prefix="/api/jobs")

    client = app.test_client()
    res = client.get("/api/jobs/rerun", query_string={"dataset": dataset, "job_id": "job-legacy"})
    assert res.status_code == 200

    job_spec = captured["job_spec"]
    assert isinstance(job_spec, dict)
    assert job_spec.get("kind") == "subprocess"
    assert job_spec.get("argv")[-2:] == ["--rerun", "run-456"]


def test_cleanup_paths_skip_outside_dataset_root(tmp_path, monkeypatch):
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    import latentscope.server.jobs_store as jobs_store
    importlib.reload(jobs_store)

    import latentscope.server.jobs_runner as jobs_runner
    importlib.reload(jobs_runner)

    dataset = "ds"
    (tmp_path / dataset).mkdir()

    outside = tmp_path / "outside.txt"
    outside.write_text("nope")

    inside_dir = tmp_path / dataset / "uploads" / "tmp"
    inside_dir.mkdir(parents=True)
    (inside_dir / "inside.txt").write_text("ok")

    jobs_runner.run_job(
        dataset,
        "job-cleanup",
        {"kind": "subprocess", "argv": [sys.executable, "-c", "print('hi')"], "display_command": "py -c hi"},
        cleanup_paths=[str(outside), str(inside_dir)],
    )

    assert outside.exists()
    assert not os.path.exists(str(inside_dir))
