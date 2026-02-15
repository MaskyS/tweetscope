import importlib
import os


def test_delete_job_refuses_paths_outside_dataset_root(tmp_path, monkeypatch):
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    import latentscope.server.jobs_store as jobs_store
    importlib.reload(jobs_store)
    import latentscope.server.jobs_runner as jobs_runner
    importlib.reload(jobs_runner)

    dataset = "ds"
    dataset_dir = tmp_path / dataset
    dataset_dir.mkdir()

    outside = tmp_path / "outside.txt"
    outside.write_text("nope")

    job_id = "job-1"
    jobs_runner.run_job(
        dataset,
        job_id,
        {
            "kind": "delete",
            "globs": [str(outside)],
            "display_command": f"rm -rf {outside}",
        },
    )

    assert outside.exists()

    progress_path = jobs_store.job_progress_path(dataset, job_id)
    assert os.path.exists(progress_path)


def test_delete_job_deletes_paths_inside_dataset_root(tmp_path, monkeypatch):
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    import latentscope.server.jobs_store as jobs_store
    importlib.reload(jobs_store)
    import latentscope.server.jobs_runner as jobs_runner
    importlib.reload(jobs_runner)

    dataset = "ds"
    dataset_dir = tmp_path / dataset
    dataset_dir.mkdir()

    target = dataset_dir / "to-delete.txt"
    target.write_text("bye")

    job_id = "job-2"
    jobs_runner.run_job(
        dataset,
        job_id,
        {
            "kind": "delete",
            "globs": [str(target)],
            "display_command": f"rm -rf {target}",
        },
    )

    assert not target.exists()

    progress_path = jobs_store.job_progress_path(dataset, job_id)
    assert os.path.exists(progress_path)
