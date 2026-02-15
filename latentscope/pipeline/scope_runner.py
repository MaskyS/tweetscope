from __future__ import annotations

import json
import os
import uuid
from typing import Any

import pandas as pd

from latentscope import __version__
from latentscope.pipeline.stages.scope_ids import resolve_scope_id
from latentscope.pipeline.stages.scope_labels import (
    build_cluster_labels_lookup,
    is_hierarchical_labels,
)
from latentscope.pipeline.stages.scope_materialize import (
    build_scope_points_df,
    finalize_scope_meta,
    write_scope_input_parquet,
)
from latentscope.pipeline.stages.scope_meta import (
    load_cluster_labels_meta,
    load_cluster_meta,
    load_dataset_meta,
    load_embedding_meta,
    load_sae_meta,
    load_umap_meta,
)
from latentscope.scripts.export_lance import export_lance
from latentscope.util import get_data_dir


def run_scope(
    *,
    dataset_id: str,
    embedding_id: str,
    umap_id: str,
    cluster_id: str,
    cluster_labels_id: str,
    label: str,
    description: str,
    scope_id: str | None = None,
    sae_id: str | None = None,
) -> str:
    data_dir = get_data_dir()
    print("DATA DIR", data_dir)
    scopes_dir = os.path.join(data_dir, dataset_id, "scopes")

    resolved_scope_id = resolve_scope_id(scopes_dir, scope_id)
    print("RUNNING:", resolved_scope_id)

    scope_meta: dict[str, Any] = {
        "ls_version": __version__,
        "id": resolved_scope_id,
        "embedding_id": embedding_id,
        "umap_id": umap_id,
        "cluster_id": cluster_id,
        "cluster_labels_id": cluster_labels_id,
        "label": label,
        "description": description,
    }
    if sae_id:
        scope_meta["sae_id"] = sae_id

    # Collision-proof LanceDB table naming: {dataset_id}__{scope_uid}
    scope_uid = str(uuid.uuid4())
    lancedb_table_id = f"{dataset_id}__{scope_uid}"
    scope_meta["scope_uid"] = scope_uid
    scope_meta["lancedb_table_id"] = lancedb_table_id

    scope_meta["dataset"] = load_dataset_meta(data_dir, dataset_id)
    scope_meta["embedding"] = load_embedding_meta(data_dir, dataset_id, embedding_id)
    if sae_id:
        scope_meta["sae"] = load_sae_meta(data_dir, dataset_id, sae_id)
    scope_meta["umap"] = load_umap_meta(data_dir, dataset_id, umap_id)
    scope_meta["cluster"] = load_cluster_meta(data_dir, dataset_id, cluster_id)

    effective_labels_id, labels_meta = load_cluster_labels_meta(
        data_dir, dataset_id, cluster_id, cluster_labels_id
    )
    scope_meta["cluster_labels_id"] = effective_labels_id
    scope_meta["cluster_labels"] = labels_meta

    cluster_labels_path = os.path.join(
        data_dir, dataset_id, "clusters", f"{effective_labels_id}.parquet"
    )
    cluster_labels_df = pd.read_parquet(cluster_labels_path)

    hierarchical = is_hierarchical_labels(cluster_labels_df)
    umap_df = pd.read_parquet(os.path.join(data_dir, dataset_id, "umaps", f"{umap_id}.parquet"))
    umap_row_count = len(umap_df) if hierarchical else 0

    lookup, unknown_count = build_cluster_labels_lookup(
        cluster_labels_df=cluster_labels_df,
        hierarchical=hierarchical,
        umap_row_count=umap_row_count,
    )
    scope_meta["cluster_labels_lookup"] = lookup
    scope_meta["hierarchical_labels"] = bool(hierarchical)
    if hierarchical:
        scope_meta["unknown_count"] = int(unknown_count)

    scope_points_df = build_scope_points_df(
        umap_df=umap_df,
        data_dir=data_dir,
        dataset_id=dataset_id,
        cluster_id=cluster_id,
        cluster_labels_df=cluster_labels_df,
        hierarchical=hierarchical,
        scope_id=resolved_scope_id,
        overwrite_scope_id=scope_id,
    )

    parquet_path = write_scope_input_parquet(
        data_dir=data_dir,
        dataset_id=dataset_id,
        scopes_dir=scopes_dir,
        scope_id=resolved_scope_id,
        scope_points_df=scope_points_df,
    )

    scope_meta = finalize_scope_meta(
        scope_meta=scope_meta,
        scope_points_df=scope_points_df,
        scope_input_parquet_path=parquet_path,
    )

    json_path = os.path.join(scopes_dir, f"{resolved_scope_id}.json")
    with open(json_path, "w") as f:
        json.dump(scope_meta, f, indent=2)

    print("exporting to lancedb")
    export_lance(data_dir, dataset_id, resolved_scope_id)

    print("wrote scope", resolved_scope_id)
    return resolved_scope_id
