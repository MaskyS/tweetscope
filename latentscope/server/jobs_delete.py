from __future__ import annotations

import json
import os
from typing import Any

from . import jobs_store


def _escape_rm_glob(p: str) -> str:
    # Preserve legacy behavior: escape spaces but do not shell-quote.
    return p.replace(" ", "\\ ")


def build_rm_rf_command(path_glob: str) -> str:
    return f"rm -rf {_escape_rm_glob(path_glob)}"


def find_clusters_to_delete_for_umap(dataset: str, umap_id: str) -> list[str]:
    if not jobs_store.DATA_DIR:
        return []
    cluster_dir = os.path.join(jobs_store.DATA_DIR, dataset, "clusters")  # type: ignore[arg-type]
    clusters_to_delete: list[str] = []
    for file in os.listdir(cluster_dir):
        if not file.endswith(".json"):
            continue
        try:
            with open(os.path.join(cluster_dir, file), "r") as f:
                cluster_data = json.load(f)
            if cluster_data.get("umap_id") == umap_id:
                clusters_to_delete.append(file.replace(".json", ""))
        except Exception:
            # Preserve legacy behavior: swallow malformed cluster JSON.
            print("ERROR LOADING CLUSTER", file)
    return clusters_to_delete


def build_delete_umap_command(dataset: str, umap_id: str) -> str:
    if not jobs_store.DATA_DIR:
        return build_rm_rf_command("")
    path = os.path.join(jobs_store.DATA_DIR, dataset, "umaps", f"{umap_id}*")  # type: ignore[arg-type]
    command = build_rm_rf_command(path)
    for cluster in find_clusters_to_delete_for_umap(dataset, umap_id):
        cpath = os.path.join(jobs_store.DATA_DIR, dataset, "clusters", f"{cluster}*")  # type: ignore[arg-type]
        command += f"; {build_rm_rf_command(cpath)}"
    return command


def find_umaps_to_delete_for_sae(dataset: str, sae_id: str) -> list[str]:
    if not jobs_store.DATA_DIR:
        return []
    umap_dir = os.path.join(jobs_store.DATA_DIR, dataset, "umaps")  # type: ignore[arg-type]
    umaps_to_delete: list[str] = []
    for file in os.listdir(umap_dir):
        if not file.endswith(".json"):
            continue
        with open(os.path.join(umap_dir, file), "r") as f:
            umap_data = json.load(f)
        if umap_data.get("sae_id") == sae_id:
            umaps_to_delete.append(file.replace(".json", ""))
    return umaps_to_delete


def build_delete_sae_command(dataset: str, sae_id: str) -> str:
    if not jobs_store.DATA_DIR:
        return build_rm_rf_command("")
    path = os.path.join(jobs_store.DATA_DIR, dataset, "saes", f"{sae_id}*")  # type: ignore[arg-type]
    return build_rm_rf_command(path)


def find_umaps_to_delete_for_embedding(dataset: str, embedding_id: str) -> list[str]:
    if not jobs_store.DATA_DIR:
        return []
    umap_dir = os.path.join(jobs_store.DATA_DIR, dataset, "umaps")  # type: ignore[arg-type]
    umaps_to_delete: list[str] = []
    for file in os.listdir(umap_dir):
        if not file.endswith(".json"):
            continue
        with open(os.path.join(umap_dir, file), "r") as f:
            umap_data = json.load(f)
        if umap_data.get("embedding_id") == embedding_id:
            umaps_to_delete.append(file.replace(".json", ""))
    return umaps_to_delete


def find_saes_to_delete_for_embedding(dataset: str, embedding_id: str) -> list[str]:
    """
    Preserve legacy behavior: looks under `{DATA_DIR}/{dataset}/sae` (singular),
    not `saes`. This effectively no-ops for most datasets but keeps parity.
    """
    if not jobs_store.DATA_DIR:
        return []
    sae_dir = os.path.join(jobs_store.DATA_DIR, dataset, "sae")  # type: ignore[arg-type]
    if not os.path.exists(sae_dir):
        os.makedirs(sae_dir)
    saes_to_delete: list[str] = []
    for file in os.listdir(sae_dir):
        if not file.endswith(".json"):
            continue
        with open(os.path.join(sae_dir, file), "r") as f:
            sae_data = json.load(f)
        if sae_data.get("embedding_id") == embedding_id:
            saes_to_delete.append(file.replace(".json", ""))
    return saes_to_delete


def build_delete_embedding_command(dataset: str, embedding_id: str) -> str:
    if not jobs_store.DATA_DIR:
        return build_rm_rf_command("")
    path = os.path.join(jobs_store.DATA_DIR, dataset, "embeddings", f"{embedding_id}*")  # type: ignore[arg-type]
    return build_rm_rf_command(path)
