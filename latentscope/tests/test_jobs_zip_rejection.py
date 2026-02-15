import importlib
import io
import json

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


def test_jobs_import_rejects_raw_zip_uploads(tmp_path, monkeypatch):
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    # jobs.py reads LATENT_SCOPE_DATA at import time; reload after setting env.
    import latentscope.server.jobs as jobs
    importlib.reload(jobs)

    app = Flask(__name__)
    app.testing = True
    app.register_blueprint(jobs.jobs_write_bp, url_prefix="/api/jobs")

    client = app.test_client()
    res = client.post(
        "/api/jobs/import_twitter",
        data={"dataset": "test-dataset", "source_type": "zip"},
    )

    assert res.status_code == 400
    payload = res.get_json()
    assert isinstance(payload, dict)
    assert "Raw zip uploads are disabled" in str(payload.get("error", ""))


def test_jobs_import_rejects_invalid_extracted_payload(tmp_path, monkeypatch):
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    import latentscope.server.jobs as jobs
    importlib.reload(jobs)

    app = Flask(__name__)
    app.testing = True
    app.register_blueprint(jobs.jobs_write_bp, url_prefix="/api/jobs")

    client = app.test_client()
    bad_payload = {"archive_format": "x_native_extracted_v1"}  # missing required fields
    res = client.post(
        "/api/jobs/import_twitter",
        data={
            "dataset": "test-dataset",
            "source_type": "community_json",
            "file": (io.BytesIO(json.dumps(bad_payload).encode("utf-8")), "payload.json"),
        },
        content_type="multipart/form-data",
    )

    assert res.status_code == 400
    payload = res.get_json()
    assert isinstance(payload, dict)
    assert "Invalid extracted archive payload" in str(payload.get("error", ""))


def test_jobs_import_accepts_valid_extracted_payload_without_spawning_job(tmp_path, monkeypatch):
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    import latentscope.server.jobs as jobs
    importlib.reload(jobs)

    started = {"called": False}

    import latentscope.server.jobs_routes as jobs_routes
    # Patch where it's used (jobs_routes starts the thread).
    monkeypatch.setattr(
        jobs_routes,
        "_start_job_thread",
        lambda **_kwargs: started.__setitem__("called", True),
    )

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
            # Ensure we don't try to run the full pipeline in tests.
            "run_pipeline": "false",
        },
        content_type="multipart/form-data",
    )

    assert res.status_code == 200
    payload = res.get_json()
    assert isinstance(payload, dict)
    assert payload.get("dataset") == "test-dataset"
    assert isinstance(payload.get("job_id"), str) and payload["job_id"]
    assert started["called"] is True
