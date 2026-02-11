"""Import Twitter/X archive data and optionally run a full Latent Scope pipeline."""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
from typing import Any

import pandas as pd

from latentscope.importers.twitter import (
    apply_filters,
    fetch_community_archive,
    load_community_archive_raw,
    load_community_extracted_json,
    load_native_x_archive_zip,
    sanitize_dataset_id,
)
from latentscope.scripts.cluster import clusterer
from latentscope.scripts.build_links_graph import build_links_graph
from latentscope.scripts.embed import embed
from latentscope.scripts.ingest import ingest
from latentscope.scripts.scope import scope
from latentscope.scripts.umapper import umapper
from latentscope.util import get_data_dir


def _latest_id(directory: str, pattern: str) -> str:
    matches = [name for name in os.listdir(directory) if re.match(pattern, name)]
    if not matches:
        raise ValueError(f"No matching files in {directory} for pattern {pattern}")
    matches.sort()
    latest = matches[-1]
    return latest.rsplit(".", 1)[0]


def _build_df(rows: list[dict[str, Any]]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    # Drop rows that do not have required id/text fields.
    df = df[df["id"].astype(str).str.len() > 0]
    df = df[df["text"].astype(str).str.len() > 0]
    df = df.reset_index(drop=True)
    return df


def _find_matching_toponymy_labels_id(
    dataset_dir: str,
    *,
    embedding_id: str,
    umap_id: str,
    cluster_id: str,
    llm_provider: str,
    llm_model: str,
    min_clusters: int,
    base_min_cluster_size: int,
) -> str | None:
    """Find latest Toponymy labels generated for the exact pipeline lineage."""
    clusters_dir = os.path.join(dataset_dir, "clusters")
    if not os.path.isdir(clusters_dir):
        return None

    candidates: list[str] = []
    for meta_path in glob.glob(os.path.join(clusters_dir, "toponymy-*.json")):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            continue

        if meta.get("type") != "toponymy":
            continue
        if meta.get("embedding_id") != embedding_id:
            continue
        if meta.get("umap_id") != umap_id:
            continue
        if meta.get("cluster_id") != cluster_id:
            continue
        if meta.get("llm_provider") != llm_provider:
            continue
        if meta.get("llm_model") != llm_model:
            continue
        if int(meta.get("min_clusters", -1)) != int(min_clusters):
            continue
        if int(meta.get("base_min_cluster_size", -1)) != int(base_min_cluster_size):
            continue

        label_id = meta.get("id")
        if isinstance(label_id, str) and label_id:
            candidates.append(label_id)

    if not candidates:
        return None
    return sorted(candidates)[-1]


def _next_hierarchical_fallback_id(dataset_dir: str) -> str:
    clusters_dir = os.path.join(dataset_dir, "clusters")
    existing: list[int] = []
    for name in os.listdir(clusters_dir):
        match = re.match(r"hierarchical-default-(\d+)\.json", name)
        if match:
            try:
                existing.append(int(match.group(1)))
            except ValueError:
                continue
    next_num = (max(existing) + 1) if existing else 1
    return f"hierarchical-default-{next_num:03d}"


def _to_list_safe(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if hasattr(value, "tolist"):
        try:
            converted = value.tolist()
            if isinstance(converted, list):
                return converted
        except Exception:
            pass
    return list(value) if isinstance(value, tuple) else []


def _centroid_from_indices(umap_df: pd.DataFrame, indices: list[int]) -> tuple[float, float]:
    if not indices:
        return 0.0, 0.0
    pts = umap_df.loc[indices, ["x", "y"]]
    return float(pts["x"].mean()), float(pts["y"].mean())


def _hull_from_indices(umap_df: pd.DataFrame, indices: list[int]) -> list[int]:
    uniq = [int(i) for i in dict.fromkeys(indices)]
    if len(uniq) < 3:
        return uniq

    try:
        import numpy as np
        from scipy.spatial import ConvexHull

        pts = umap_df.loc[uniq, ["x", "y"]].to_numpy()
        if pts.shape[0] < 3:
            return uniq
        hull = ConvexHull(pts)
        return [uniq[int(v)] for v in hull.vertices.tolist()]
    except Exception:
        # Graceful fallback: keep a compact representative perimeter.
        return uniq[: min(64, len(uniq))]


def _build_hierarchical_fallback_labels(
    *,
    dataset_id: str,
    dataset_dir: str,
    cluster_id: str,
    umap_id: str,
    min_clusters: int = 2,
) -> str:
    """
    Generate hierarchical labels dynamically from flat clusters.
    Layer count is discovered from data by recursively grouping cluster centroids.
    """
    from sklearn.cluster import KMeans

    clusters_dir = os.path.join(dataset_dir, "clusters")
    flat_labels_path = os.path.join(clusters_dir, f"{cluster_id}-labels-default.parquet")
    if not os.path.exists(flat_labels_path):
        raise FileNotFoundError(f"Missing flat labels parquet: {flat_labels_path}")

    flat_df = pd.read_parquet(flat_labels_path).copy()
    umap_df = pd.read_parquet(os.path.join(dataset_dir, "umaps", f"{umap_id}.parquet"))

    # Build layer 0 from flat clusters.
    layer0_nodes: list[dict[str, Any]] = []
    for cluster_idx, row in flat_df.iterrows():
        indices = [int(i) for i in _to_list_safe(row.get("indices"))]
        centroid_x, centroid_y = _centroid_from_indices(umap_df, indices)
        hull = _to_list_safe(row.get("hull")) or _hull_from_indices(umap_df, indices)
        layer0_nodes.append(
            {
                "label": str(row.get("label") or f"Cluster {cluster_idx}"),
                "description": str(row.get("description") or ""),
                "indices": indices,
                "hull": [int(i) for i in hull],
                "count": int(len(indices)),
                "centroid_x": centroid_x,
                "centroid_y": centroid_y,
                "parent_ref": None,
            }
        )

    layers: list[list[dict[str, Any]]] = [layer0_nodes]
    target_min_clusters = max(2, int(min_clusters))

    # Recursively group each layer's centroids into a smaller parent layer.
    while len(layers[-1]) > target_min_clusters:
        prev_nodes = layers[-1]
        prev_count = len(prev_nodes)
        next_count = max(target_min_clusters, int(round(prev_count * 0.55)))
        if next_count >= prev_count:
            next_count = prev_count - 1
        if next_count < 1:
            break

        centroids = [[node["centroid_x"], node["centroid_y"]] for node in prev_nodes]
        model = KMeans(n_clusters=next_count, random_state=42, n_init=10)
        assignments = model.fit_predict(centroids).tolist()

        grouped_indices: dict[int, list[int]] = {}
        for idx, cluster_idx in enumerate(assignments):
            grouped_indices.setdefault(int(cluster_idx), []).append(idx)

        parent_nodes: list[dict[str, Any]] = []
        for parent_idx in sorted(grouped_indices):
            child_refs = grouped_indices[parent_idx]
            all_indices: list[int] = []
            for child_ref in child_refs:
                prev_nodes[child_ref]["parent_ref"] = len(parent_nodes)
                all_indices.extend(prev_nodes[child_ref]["indices"])

            # Preserve deterministic order while removing duplicates.
            merged_indices = [int(i) for i in dict.fromkeys(all_indices)]
            centroid_x, centroid_y = _centroid_from_indices(umap_df, merged_indices)
            hull = _hull_from_indices(umap_df, merged_indices)

            # Seed parent label from the dominant child by point count.
            dominant_child = max(child_refs, key=lambda i: prev_nodes[i]["count"])
            dominant_label = str(prev_nodes[dominant_child]["label"])
            if len(child_refs) > 1:
                label = f"{dominant_label} · {len(child_refs)}"
            else:
                label = dominant_label

            parent_nodes.append(
                {
                    "label": label,
                    "description": f"Auto-group of {len(child_refs)} clusters",
                    "indices": merged_indices,
                    "hull": [int(i) for i in hull],
                    "count": int(len(merged_indices)),
                    "centroid_x": centroid_x,
                    "centroid_y": centroid_y,
                    "children_refs": child_refs,
                    "parent_ref": None,
                }
            )

        if not parent_nodes:
            break
        layers.append(parent_nodes)

    # Assign stable cluster IDs and finalize parent/children links.
    for layer_idx, nodes in enumerate(layers):
        for node_idx, node in enumerate(nodes):
            node["cluster_id"] = f"{layer_idx}_{node_idx}"

    records: list[dict[str, Any]] = []
    for layer_idx, nodes in enumerate(layers):
        for node in nodes:
            parent_cluster = None
            if layer_idx < len(layers) - 1 and node.get("parent_ref") is not None:
                parent_cluster = layers[layer_idx + 1][int(node["parent_ref"])]["cluster_id"]

            children: list[str] = []
            if layer_idx > 0:
                for child_ref in node.get("children_refs", []):
                    children.append(layers[layer_idx - 1][int(child_ref)]["cluster_id"])

            records.append(
                {
                    "cluster": node["cluster_id"],
                    "layer": int(layer_idx),
                    "label": str(node["label"]),
                    "description": str(node["description"]),
                    "hull": node["hull"],
                    "count": int(node["count"]),
                    "parent_cluster": parent_cluster,
                    "children": children,
                    "centroid_x": float(node["centroid_x"]),
                    "centroid_y": float(node["centroid_y"]),
                    "indices": node["indices"],
                }
            )

    out_id = _next_hierarchical_fallback_id(dataset_dir)
    out_df = pd.DataFrame.from_records(
        records,
        columns=[
            "cluster",
            "layer",
            "label",
            "description",
            "hull",
            "count",
            "parent_cluster",
            "children",
            "centroid_x",
            "centroid_y",
            "indices",
        ],
    )
    out_df.to_parquet(os.path.join(clusters_dir, f"{out_id}.parquet"), index=False)

    with open(os.path.join(clusters_dir, f"{out_id}.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "id": out_id,
                "type": "hierarchical_fallback",
                "ls_version": __import__("latentscope").__version__,
                "dataset_id": dataset_id,
                "cluster_id": cluster_id,
                "umap_id": umap_id,
                "num_layers": int(len(layers)),
                "num_clusters": int(len(records)),
            },
            f,
            indent=2,
        )

    return out_id


def _try_enable_hierarchical_scope(
    *,
    dataset_id: str,
    dataset_dir: str,
    scope_id: str,
    embedding_id: str,
    umap_id: str,
    cluster_id: str,
    label: str,
    description: str,
    toponymy_provider: str,
    toponymy_model: str,
    toponymy_min_clusters: int,
    toponymy_base_min_cluster_size: int,
    toponymy_context: str | None,
) -> dict[str, Any]:
    """
    Ensure the given scope uses hierarchical labels.
    Preference order:
      1) Reuse existing matching Toponymy labels for same embedding+umap
      2) Generate new Toponymy labels from this scope and attach them
    """
    existing_labels_id = _find_matching_toponymy_labels_id(
        dataset_dir,
        embedding_id=embedding_id,
        umap_id=umap_id,
        cluster_id=cluster_id,
        llm_provider=toponymy_provider,
        llm_model=toponymy_model,
        min_clusters=toponymy_min_clusters,
        base_min_cluster_size=toponymy_base_min_cluster_size,
    )
    if existing_labels_id:
        scope(
            dataset_id=dataset_id,
            embedding_id=embedding_id,
            umap_id=umap_id,
            cluster_id=cluster_id,
            cluster_labels_id=existing_labels_id,
            label=label,
            description=description,
            scope_id=scope_id,
            sae_id=None,
        )
        return {
            "cluster_labels_id": existing_labels_id,
            "hierarchical_labels": True,
            "toponymy_generated": False,
        }

    from latentscope.scripts.toponymy_labels import run_toponymy_labeling
    generated_labels_id = run_toponymy_labeling(
        dataset_id=dataset_id,
        scope_id=scope_id,
        llm_provider=toponymy_provider,
        llm_model=toponymy_model,
        min_clusters=toponymy_min_clusters,
        base_min_cluster_size=toponymy_base_min_cluster_size,
        context=toponymy_context,
    )

    scope(
        dataset_id=dataset_id,
        embedding_id=embedding_id,
        umap_id=umap_id,
        cluster_id=cluster_id,
        cluster_labels_id=generated_labels_id,
        label=label,
        description=description,
        scope_id=scope_id,
        sae_id=None,
    )
    return {
        "cluster_labels_id": generated_labels_id,
        "hierarchical_labels": True,
        "toponymy_generated": True,
    }


def run_import(
    dataset_id: str,
    source: str,
    *,
    zip_path: str | None = None,
    input_path: str | None = None,
    username: str | None = None,
    include_likes: bool = True,
    year: int | None = None,
    lang: str | None = None,
    min_favorites: int = 0,
    min_text_length: int = 0,
    exclude_replies: bool = False,
    exclude_retweets: bool = False,
    top_n: int | None = None,
    sort: str = "recent",
    text_column: str = "text",
    run_pipeline: bool = False,
    embedding_model: str = "voyageai-voyage-4-lite",
    umap_neighbors: int = 25,
    umap_min_dist: float = 0.1,
    cluster_samples: int = 5,
    cluster_min_samples: int = 5,
    cluster_selection_epsilon: float = 0.0,
    hierarchical_labels: bool = True,
    toponymy_provider: str = "openai",
    toponymy_model: str = "gpt-4o-mini",
    toponymy_min_clusters: int = 2,
    toponymy_base_min_cluster_size: int = 10,
    toponymy_context: str | None = None,
    build_links: bool = False,
) -> dict[str, Any]:
    dataset_id = sanitize_dataset_id(dataset_id)

    if source == "zip":
        if not zip_path:
            raise ValueError("--zip_path is required for --source zip")
        imported = load_native_x_archive_zip(zip_path)
    elif source == "community":
        if not username:
            raise ValueError("--username is required for --source community")
        raw = fetch_community_archive(username)
        imported = load_community_archive_raw(raw, username=username)
    elif source == "community_json":
        if not input_path:
            raise ValueError("--input_path is required for --source community_json")
        imported = load_community_extracted_json(input_path)
    else:
        raise ValueError(f"Unsupported source: {source}")

    filtered = apply_filters(
        imported.rows,
        include_likes=include_likes,
        year=year,
        lang=lang,
        min_favorites=min_favorites,
        min_text_length=min_text_length,
        exclude_replies=exclude_replies,
        exclude_retweets=exclude_retweets,
        top_n=top_n,
        sort=sort,
    )
    if not filtered:
        raise ValueError("No rows available after filtering")

    df = _build_df(filtered)
    ingest(dataset_id, df, text_column=text_column)

    summary: dict[str, Any] = {
        "dataset_id": dataset_id,
        "rows": int(df.shape[0]),
        "profile": imported.profile,
        "source": imported.source,
    }

    if not run_pipeline:
        if build_links:
            try:
                links_summary = build_links_graph(dataset_id)
                summary["links"] = {
                    "nodes": links_summary["nodes"],
                    "edges": links_summary["edges"],
                    "edge_type_counts": links_summary["edge_type_counts"],
                }
            except Exception as err:
                summary["links_error"] = str(err)
        return summary

    # 1) Embedding
    embed(
        dataset_id=dataset_id,
        text_column=text_column,
        model_id=embedding_model,
        prefix="",
        rerun=None,
        dimensions=None,
        batch_size=100,
        max_seq_length=None,
    )

    data_dir = get_data_dir()
    dataset_dir = os.path.join(data_dir, dataset_id)
    embedding_id = _latest_id(os.path.join(dataset_dir, "embeddings"), r"embedding-\d+\.json")

    # 2a) Display UMAP (2D for visualization)
    umapper(
        dataset_id=dataset_id,
        embedding_id=embedding_id,
        neighbors=umap_neighbors,
        min_dist=umap_min_dist,
        save=False,
        init=None,
        align=None,
        seed=None,
        purpose='display',
        n_components=2,
    )
    umap_id = _latest_id(os.path.join(dataset_dir, "umaps"), r"umap-\d+\.json")

    # 2b) Clustering UMAP (kD for HDBSCAN)
    umapper(
        dataset_id=dataset_id,
        embedding_id=embedding_id,
        neighbors=umap_neighbors,
        min_dist=0.0,  # tighter manifold for clustering
        save=False,
        init=None,
        align=None,
        seed=None,
        purpose='cluster',
        n_components=10,
    )
    clustering_umap_id = _latest_id(os.path.join(dataset_dir, "umaps"), r"umap-\d+\.json")

    # 3) Clustering (on kD manifold)
    clusterer(
        dataset_id=dataset_id,
        umap_id=umap_id,
        samples=cluster_samples,
        min_samples=cluster_min_samples,
        cluster_selection_epsilon=cluster_selection_epsilon,
        column=None,
        clustering_umap_id=clustering_umap_id,
    )
    cluster_id = _latest_id(os.path.join(dataset_dir, "clusters"), r"cluster-\d+\.json")

    # 4) Scope with default labels
    scope_label = f"{dataset_id} Twitter"
    scope_description = f"Imported from {imported.source} and auto-processed."
    scope(
        dataset_id=dataset_id,
        embedding_id=embedding_id,
        umap_id=umap_id,
        cluster_id=cluster_id,
        cluster_labels_id="default",
        label=scope_label,
        description=scope_description,
        scope_id=None,
        sae_id=None,
    )
    scope_id = _latest_id(os.path.join(dataset_dir, "scopes"), r"scopes-\d+\.json")

    cluster_labels_id = "default"
    hierarchical_enabled = False
    if hierarchical_labels:
        hier = _try_enable_hierarchical_scope(
            dataset_id=dataset_id,
            dataset_dir=dataset_dir,
            scope_id=scope_id,
            embedding_id=embedding_id,
            umap_id=umap_id,
            cluster_id=cluster_id,
            label=scope_label,
            description=scope_description,
            toponymy_provider=toponymy_provider,
            toponymy_model=toponymy_model,
            toponymy_min_clusters=toponymy_min_clusters,
            toponymy_base_min_cluster_size=toponymy_base_min_cluster_size,
            toponymy_context=toponymy_context,
        )
        cluster_labels_id = hier.get("cluster_labels_id", "default")
        hierarchical_enabled = bool(hier.get("hierarchical_labels"))
        if "toponymy_generated" in hier:
            summary["toponymy_generated"] = bool(hier["toponymy_generated"])

    summary.update(
        {
            "embedding_id": embedding_id,
            "umap_id": umap_id,
            "cluster_id": cluster_id,
            "cluster_labels_id": cluster_labels_id,
            "scope_id": scope_id,
            "hierarchical_labels": hierarchical_enabled,
        }
    )

    if build_links:
        try:
            links_summary = build_links_graph(dataset_id, scope_id=scope_id)
            summary["links"] = {
                "nodes": links_summary["nodes"],
                "edges": links_summary["edges"],
                "edge_type_counts": links_summary["edge_type_counts"],
            }
        except Exception as err:
            summary["links_error"] = str(err)

    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Import Twitter/X archives into Latent Scope")
    parser.add_argument("dataset_id", type=str, help="Dataset identifier")
    parser.add_argument(
        "--source",
        type=str,
        choices=["zip", "community", "community_json"],
        required=True,
        help="Import source format",
    )
    parser.add_argument("--zip_path", type=str, help="Path to native X archive zip")
    parser.add_argument("--input_path", type=str, help="Path to extracted community JSON")
    parser.add_argument("--username", type=str, help="Community archive username")
    parser.add_argument(
        "--exclude_likes",
        action="store_true",
        help="Exclude likes from imported rows",
    )
    parser.add_argument("--year", type=int, help="Filter tweets to a specific year")
    parser.add_argument("--lang", type=str, help="Language filter (e.g. en)")
    parser.add_argument("--min_favorites", type=int, default=0, help="Minimum favorites")
    parser.add_argument("--min_text_length", type=int, default=0, help="Minimum text length")
    parser.add_argument("--exclude_replies", action="store_true", help="Drop reply tweets")
    parser.add_argument("--exclude_retweets", action="store_true", help="Drop retweets")
    parser.add_argument("--top_n", type=int, help="Take top N rows after sorting")
    parser.add_argument(
        "--sort",
        type=str,
        choices=["recent", "engagement"],
        default="recent",
        help="Sort strategy",
    )
    parser.add_argument("--text_column", type=str, default="text", help="Text column name")
    parser.add_argument("--run_pipeline", action="store_true", help="Run embed/umap/cluster/scope")

    parser.add_argument(
        "--embedding_model",
        type=str,
        default="voyageai-voyage-4-lite",
        help="Embedding model id for --run_pipeline",
    )
    parser.add_argument("--umap_neighbors", type=int, default=25)
    parser.add_argument("--umap_min_dist", type=float, default=0.1)
    parser.add_argument("--cluster_samples", type=int, default=5)
    parser.add_argument("--cluster_min_samples", type=int, default=5)
    parser.add_argument("--cluster_selection_epsilon", type=float, default=0.0)
    parser.add_argument(
        "--hierarchical-labels",
        dest="hierarchical_labels",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Use hierarchical Toponymy labels for the final scope (default: enabled)",
    )
    parser.add_argument(
        "--toponymy-provider",
        type=str,
        default="openai",
        choices=["openai", "anthropic", "cohere", "google"],
        help="LLM provider for Toponymy label generation",
    )
    parser.add_argument(
        "--toponymy-model",
        type=str,
        default="gpt-4o-mini",
        help="LLM model for Toponymy label generation",
    )
    parser.add_argument(
        "--toponymy-min-clusters",
        type=int,
        default=2,
        help="Toponymy minimum clusters per layer",
    )
    parser.add_argument(
        "--toponymy-base-min-cluster-size",
        type=int,
        default=10,
        help="Toponymy minimum cluster size for the finest layer",
    )
    parser.add_argument(
        "--toponymy-context",
        type=str,
        default=None,
        help="Optional Toponymy context string for topic naming",
    )
    parser.add_argument(
        "--build_links",
        action="store_true",
        help="Build reply/quote link graph artifacts after import",
    )

    args = parser.parse_args()
    args_dict = vars(args).copy()
    args_dict["include_likes"] = not args_dict.pop("exclude_likes", False)
    result = run_import(**args_dict)
    print(f"IMPORTED_ROWS: {result['rows']}")
    print(f"DATASET_ID: {result['dataset_id']}")
    if result.get("scope_id"):
        print(f"FINAL_SCOPE: {result['scope_id']}")


if __name__ == "__main__":
    main()
