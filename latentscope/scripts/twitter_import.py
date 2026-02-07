"""Import Twitter/X archive data and optionally run a full Latent Scope pipeline."""

from __future__ import annotations

import argparse
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


def run_import(
    dataset_id: str,
    source: str,
    *,
    zip_path: str | None = None,
    input_path: str | None = None,
    username: str | None = None,
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
    embedding_model: str = "transformers-intfloat___e5-small-v2",
    umap_neighbors: int = 25,
    umap_min_dist: float = 0.1,
    cluster_samples: int = 5,
    cluster_min_samples: int = 5,
    cluster_selection_epsilon: float = 0.0,
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

    # 2) UMAP
    umapper(
        dataset_id=dataset_id,
        embedding_id=embedding_id,
        neighbors=umap_neighbors,
        min_dist=umap_min_dist,
        save=False,
        init=None,
        align=None,
        seed=None,
    )
    umap_id = _latest_id(os.path.join(dataset_dir, "umaps"), r"umap-\d+\.json")

    # 3) Clustering
    clusterer(
        dataset_id=dataset_id,
        umap_id=umap_id,
        samples=cluster_samples,
        min_samples=cluster_min_samples,
        cluster_selection_epsilon=cluster_selection_epsilon,
        column=None,
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

    summary.update(
        {
            "embedding_id": embedding_id,
            "umap_id": umap_id,
            "cluster_id": cluster_id,
            "scope_id": scope_id,
        }
    )
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
        default="transformers-intfloat___e5-small-v2",
        help="Embedding model id for --run_pipeline",
    )
    parser.add_argument("--umap_neighbors", type=int, default=25)
    parser.add_argument("--umap_min_dist", type=float, default=0.1)
    parser.add_argument("--cluster_samples", type=int, default=5)
    parser.add_argument("--cluster_min_samples", type=int, default=5)
    parser.add_argument("--cluster_selection_epsilon", type=float, default=0.0)

    args = parser.parse_args()
    result = run_import(**vars(args))
    print(f"IMPORTED_ROWS: {result['rows']}")
    print(f"DATASET_ID: {result['dataset_id']}")
    if result.get("scope_id"):
        print(f"FINAL_SCOPE: {result['scope_id']}")


if __name__ == "__main__":
    main()

