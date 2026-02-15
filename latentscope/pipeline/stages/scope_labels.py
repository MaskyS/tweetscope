from __future__ import annotations

from typing import Any

import pandas as pd


def is_hierarchical_labels(cluster_labels_df: pd.DataFrame) -> bool:
    return "layer" in cluster_labels_df.columns


def build_cluster_labels_lookup(
    *,
    cluster_labels_df: pd.DataFrame,
    hierarchical: bool,
    umap_row_count: int,
) -> tuple[list[dict[str, Any]], int]:
    if hierarchical:
        return _build_hierarchical_lookup(cluster_labels_df, umap_row_count)
    return _build_flat_lookup(cluster_labels_df), 0


def _build_hierarchical_lookup(
    cluster_labels_df: pd.DataFrame, umap_row_count: int
) -> tuple[list[dict[str, Any]], int]:
    full_df = cluster_labels_df.copy()

    assigned_indices: set[int] = set()
    if "indices" in full_df.columns:
        layer0 = full_df[full_df["layer"] == 0]
        for indices in layer0["indices"]:
            if indices is None:
                continue
            if hasattr(indices, "tolist"):
                indices = indices.tolist()
            assigned_indices.update(indices)

    unknown_count = max(0, int(umap_row_count) - len(assigned_indices))

    df = full_df.drop(columns=[col for col in ["indices"] if col in full_df.columns])

    if "hull" in df.columns:
        df["hull"] = df["hull"].apply(lambda x: x.tolist() if hasattr(x, "tolist") else x)
    if "children" in df.columns:
        df["children"] = df["children"].apply(
            lambda x: x.tolist() if hasattr(x, "tolist") else x
        )

    labels_list = df.to_dict(orient="records")
    labels_list.append(
        {
            "cluster": "unknown",
            "layer": 0,
            "label": "Unclustered",
            "description": "Points not assigned to any cluster",
            "hull": [],
            "count": unknown_count,
            "parent_cluster": None,
            "children": [],
            "centroid_x": 0,
            "centroid_y": 0,
        }
    )
    return labels_list, unknown_count


def _build_flat_lookup(cluster_labels_df: pd.DataFrame) -> list[dict[str, Any]]:
    df = cluster_labels_df.drop(
        columns=[
            col
            for col in ["indices", "labeled", "label_raw"]
            if col in cluster_labels_df.columns
        ]
    )
    df = df.copy()
    df["hull"] = df["hull"].apply(lambda x: x.tolist())
    df["cluster"] = df.index
    return df.to_dict(orient="records")


def build_layer0_point_mappings(
    cluster_labels_df: pd.DataFrame,
) -> tuple[dict[int, str], dict[int, str]]:
    """
    For hierarchical labels: map point index -> (cluster_id_str, label).
    """
    layer0 = cluster_labels_df[cluster_labels_df["layer"] == 0].copy()
    point_to_cluster: dict[int, str] = {}
    point_to_label: dict[int, str] = {}

    for _, row in layer0.iterrows():
        cluster_id_str = row["cluster"]
        label = row["label"]
        indices = row["indices"]
        for idx in indices:
            point_to_cluster[int(idx)] = cluster_id_str
            point_to_label[int(idx)] = label

    return point_to_cluster, point_to_label

