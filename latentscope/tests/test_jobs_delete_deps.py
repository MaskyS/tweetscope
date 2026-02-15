import importlib
import json
import os


def test_find_umaps_to_delete_for_embedding(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    # Reload modules to pick up the environment variable.
    import latentscope.server.jobs_store as jobs_store

    importlib.reload(jobs_store)
    import latentscope.server.jobs_delete as jobs_delete

    importlib.reload(jobs_delete)

    dataset = "ds"
    umap_dir = tmp_path / dataset / "umaps"
    umap_dir.mkdir(parents=True)
    (umap_dir / "umap-001.json").write_text(json.dumps({"embedding_id": "emb-1"}))
    (umap_dir / "umap-002.json").write_text(json.dumps({"embedding_id": "emb-2"}))

    assert jobs_delete.find_umaps_to_delete_for_embedding(dataset, "emb-1") == ["umap-001"]


def test_build_delete_umap_command_includes_cluster_deletes(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    import latentscope.server.jobs_store as jobs_store

    importlib.reload(jobs_store)
    import latentscope.server.jobs_delete as jobs_delete

    importlib.reload(jobs_delete)

    dataset = "ds"
    (tmp_path / dataset / "umaps").mkdir(parents=True)
    cluster_dir = tmp_path / dataset / "clusters"
    cluster_dir.mkdir(parents=True)
    (cluster_dir / "cluster-001.json").write_text(json.dumps({"umap_id": "umap-123"}))

    cmd = jobs_delete.build_delete_umap_command(dataset, "umap-123")
    assert "rm -rf" in cmd
    assert "umaps/umap-123*" in cmd
    assert "clusters/cluster-001*" in cmd

