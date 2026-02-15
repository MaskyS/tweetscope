from __future__ import annotations

import json
import os
from typing import Any


def _load_json(path: str) -> dict[str, Any]:
    with open(path) as f:
        return json.load(f)


def load_dataset_meta(data_dir: str, dataset_id: str) -> dict[str, Any]:
    return _load_json(os.path.join(data_dir, dataset_id, "meta.json"))


def load_embedding_meta(data_dir: str, dataset_id: str, embedding_id: str) -> dict[str, Any]:
    embedding = _load_json(os.path.join(data_dir, dataset_id, "embeddings", f"{embedding_id}.json"))
    embedding.pop("min_values", None)
    embedding.pop("max_values", None)
    return embedding


def load_sae_meta(data_dir: str, dataset_id: str, sae_id: str) -> dict[str, Any]:
    return _load_json(os.path.join(data_dir, dataset_id, "saes", f"{sae_id}.json"))


def load_umap_meta(data_dir: str, dataset_id: str, umap_id: str) -> dict[str, Any]:
    return _load_json(os.path.join(data_dir, dataset_id, "umaps", f"{umap_id}.json"))


def load_cluster_meta(data_dir: str, dataset_id: str, cluster_id: str) -> dict[str, Any]:
    return _load_json(os.path.join(data_dir, dataset_id, "clusters", f"{cluster_id}.json"))


def load_cluster_labels_meta(
    data_dir: str, dataset_id: str, cluster_id: str, cluster_labels_id: str
) -> tuple[str, dict[str, Any]]:
    """
    Returns (effective_cluster_labels_id, cluster_labels_meta_json).
    """
    if cluster_labels_id == "default":
        effective = f"{cluster_id}-labels-default"
        return effective, {"id": effective, "cluster_id": cluster_id}
    return cluster_labels_id, _load_json(
        os.path.join(data_dir, dataset_id, "clusters", f"{cluster_labels_id}.json")
    )

