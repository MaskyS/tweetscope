from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any

import pandas as pd

from latentscope.pipeline.contracts.scope_input import (
    SERVING_COLUMNS,
    load_contract,
    normalize_serving_types,
    validate_scope_input_df,
)
from latentscope.pipeline.stages.scope_labels import build_layer0_point_mappings
from latentscope.pipeline.stages.tiles import make_tiles


def build_scope_points_df(
    *,
    umap_df: pd.DataFrame,
    data_dir: str,
    dataset_id: str,
    cluster_id: str,
    cluster_labels_df: pd.DataFrame,
    hierarchical: bool,
    scope_id: str,
    overwrite_scope_id: str | None,
) -> pd.DataFrame:
    umap_df = umap_df.copy()
    umap_df["tile_index_64"] = make_tiles(umap_df["x"], umap_df["y"], 64)
    umap_df["tile_index_128"] = make_tiles(umap_df["x"], umap_df["y"], 128)

    cluster_df = pd.read_parquet(
        os.path.join(data_dir, dataset_id, "clusters", f"{cluster_id}.parquet")
    )
    cluster_df = cluster_df.copy()

    if hierarchical:
        point_to_cluster, point_to_label = build_layer0_point_mappings(cluster_labels_df)
        cluster_df["cluster"] = cluster_df.index.map(point_to_cluster).fillna("unknown")
        cluster_df["label"] = cluster_df.index.map(point_to_label).fillna("Unknown")
    else:
        cluster_df["label"] = cluster_df["cluster"].apply(
            lambda x: cluster_labels_df.loc[x]["label"]
        )

    scope_points = pd.concat([umap_df, cluster_df], axis=1)

    scope_points["deleted"] = False
    if overwrite_scope_id is not None:
        transactions_path = os.path.join(
            data_dir, dataset_id, "scopes", f"{overwrite_scope_id}-transactions.json"
        )
        with open(transactions_path) as f:
            transactions = json.load(f)
            for transaction in transactions:
                if transaction["action"] == "delete_rows":
                    scope_points.loc[transaction["payload"]["row_ids"], "deleted"] = True

    scope_points["ls_index"] = scope_points.index
    return scope_points


def write_scope_input_parquet(
    *,
    data_dir: str,
    dataset_id: str,
    scopes_dir: str,
    scope_id: str,
    scope_points_df: pd.DataFrame,
) -> str:
    input_df = pd.read_parquet(os.path.join(data_dir, dataset_id, "input.parquet"))
    if "id" in input_df.columns:
        input_df["id"] = input_df["id"].astype(str)

    input_df = input_df.reset_index()
    input_df = input_df[input_df["index"].isin(scope_points_df["ls_index"])]
    combined_df = input_df.join(scope_points_df.set_index("ls_index"), on="index", rsuffix="_ls")
    combined_df["ls_index"] = combined_df["index"]

    available = [c for c in SERVING_COLUMNS if c in combined_df.columns]
    combined_df = combined_df[available]

    contract = load_contract()
    combined_df = normalize_serving_types(combined_df, contract)
    validate_scope_input_df(combined_df, contract)

    output_path = os.path.join(scopes_dir, f"{scope_id}-input.parquet")
    combined_df.to_parquet(output_path)
    return output_path


def finalize_scope_meta(
    *,
    scope_meta: dict[str, Any],
    scope_points_df: pd.DataFrame,
    scope_input_parquet_path: str,
) -> dict[str, Any]:
    scope_meta = dict(scope_meta)
    scope_meta["rows"] = int(len(scope_points_df))
    scope_meta["columns"] = scope_points_df.columns.tolist()
    scope_meta["size"] = os.path.getsize(scope_input_parquet_path)
    scope_meta["timestamp"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return scope_meta
