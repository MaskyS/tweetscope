import importlib
import json


def test_find_saes_to_delete_for_embedding_scans_saes_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    import latentscope.server.jobs_store as jobs_store
    importlib.reload(jobs_store)

    import latentscope.server.jobs_delete as jobs_delete
    importlib.reload(jobs_delete)

    dataset = "ds"
    embedding_id = "emb-1"

    (tmp_path / dataset / "saes").mkdir(parents=True)
    (tmp_path / dataset / "saes" / "sae-1.json").write_text(json.dumps({"embedding_id": embedding_id}))
    (tmp_path / dataset / "saes" / "sae-2.json").write_text(json.dumps({"embedding_id": "other"}))

    assert jobs_delete.find_saes_to_delete_for_embedding(dataset, embedding_id) == ["sae-1"]


def test_build_delete_embedding_globs_includes_sae_artifacts(tmp_path, monkeypatch):
    monkeypatch.setenv("LATENT_SCOPE_DATA", str(tmp_path))

    import latentscope.server.jobs_store as jobs_store
    importlib.reload(jobs_store)

    import latentscope.server.jobs_delete as jobs_delete
    importlib.reload(jobs_delete)

    dataset = "ds"
    embedding_id = "emb-1"

    (tmp_path / dataset / "saes").mkdir(parents=True)
    (tmp_path / dataset / "saes" / "sae-1.json").write_text(json.dumps({"embedding_id": embedding_id}))

    globs = jobs_delete.build_delete_embedding_globs(dataset, embedding_id)
    assert any(g.endswith(f"/{dataset}/embeddings/{embedding_id}*") for g in globs)
    assert any(g.endswith(f"/{dataset}/saes/sae-1*") for g in globs)
