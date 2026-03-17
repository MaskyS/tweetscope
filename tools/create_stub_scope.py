"""Create a stub scope for a dataset that skips embed/UMAP/cluster pipeline.

Builds a minimal LanceDB scope table with random x/y, a single cluster,
and all serving columns from input.parquet.  This is enough for the UI
(including the thread carousel) to load while skipping expensive pipeline stages.

Usage:
    uv run python3 tools/create_stub_scope.py --dataset visakanv-tweets
    uv run python3 tools/create_stub_scope.py --dataset visakanv-tweets --scope_id scopes-001
"""

from __future__ import annotations

import argparse
import json
import os
import uuid
from datetime import datetime

import lancedb
import numpy as np
import pandas as pd

from latentscope.__version__ import __version__
from latentscope.pipeline.catalog_registry import upsert_dataset_meta, upsert_scope_meta
from latentscope.pipeline.contracts.scope_input import (
    SERVING_COLUMNS,
    load_contract,
    normalize_serving_types,
    validate_scope_input_df,
)
from latentscope.pipeline.stages.tiles import make_tiles
from latentscope.util import get_data_dir


def create_stub_scope(
    dataset_id: str,
    scope_id: str = "scopes-001",
) -> str:
    data_dir = get_data_dir()
    dataset_path = os.path.join(data_dir, dataset_id)

    # ── Load input data ──────────────────────────────────────────────
    input_path = os.path.join(dataset_path, "input.parquet")
    meta_path = os.path.join(dataset_path, "meta.json")

    if not os.path.exists(input_path):
        raise FileNotFoundError(f"input.parquet not found at {input_path}")
    if not os.path.exists(meta_path):
        raise FileNotFoundError(f"meta.json not found at {meta_path}")

    input_df = pd.read_parquet(input_path)
    with open(meta_path) as f:
        dataset_meta = json.load(f)

    text_column = dataset_meta.get("text_column", "text")
    n_rows = len(input_df)
    print(f"Loaded {n_rows} rows from {dataset_id}")

    # ── Build scope DataFrame ────────────────────────────────────────
    rng = np.random.default_rng(42)
    x = rng.uniform(-10, 10, size=n_rows).astype(np.float32)
    y = rng.uniform(-10, 10, size=n_rows).astype(np.float32)

    scope_df = pd.DataFrame({
        "id": input_df["id"].astype(str),
        "ls_index": np.arange(n_rows, dtype=np.int64),
        "x": x,
        "y": y,
        "cluster": "0",
        "raw_cluster": "0",
        "label": "all",
        "deleted": False,
        "tile_index_64": make_tiles(pd.Series(x), pd.Series(y), 64),
        "tile_index_128": make_tiles(pd.Series(x), pd.Series(y), 128),
        "text": input_df[text_column].astype(str).fillna(""),
    })

    # Copy optional columns from input_df if they exist
    optional_cols = [
        "created_at", "username", "display_name", "tweet_type",
        "favorites", "retweets", "replies",
        "is_reply", "is_retweet", "is_like",
        "urls_json", "media_urls_json", "archive_source",
    ]
    for col in optional_cols:
        if col in input_df.columns:
            scope_df[col] = input_df[col].values

    # Keep only serving columns that exist
    available = [c for c in SERVING_COLUMNS if c in scope_df.columns]
    scope_df = scope_df[available]

    # Normalize types per contract
    contract = load_contract()
    scope_df = normalize_serving_types(scope_df, contract)
    validate_scope_input_df(scope_df, contract)

    print(f"Scope DataFrame: {len(scope_df)} rows, {len(scope_df.columns)} columns")
    print(f"Columns: {scope_df.columns.tolist()}")

    # ── Write scope input parquet ────────────────────────────────────
    scopes_dir = os.path.join(dataset_path, "scopes")
    os.makedirs(scopes_dir, exist_ok=True)

    parquet_path = os.path.join(scopes_dir, f"{scope_id}-input.parquet")
    scope_df.to_parquet(parquet_path)
    print(f"Wrote {parquet_path}")

    # ── Build scope metadata ─────────────────────────────────────────
    scope_uid = str(uuid.uuid4())
    lancedb_table_id = f"{dataset_id}__{scope_uid}"

    cluster_labels_lookup = [
        {
            "cluster": "0",
            "label": "all",
            "description": "All tweets (stub scope — no clustering performed)",
            "count": n_rows,
        }
    ]

    scope_meta = {
        "ls_version": __version__,
        "id": scope_id,
        "embedding_id": "stub",
        "umap_id": "stub",
        "cluster_id": "stub",
        "cluster_labels_id": "stub",
        "label": f"Stub scope for {dataset_id}",
        "description": "Minimal scope with random layout; skips embed/UMAP/cluster pipeline.",
        "scope_uid": scope_uid,
        "lancedb_table_id": lancedb_table_id,
        "dataset": dataset_meta,
        "embedding": {"model_id": "stub", "id": "stub"},
        "umap": {"id": "stub"},
        "cluster": {"id": "stub"},
        "cluster_labels": {"id": "stub"},
        "cluster_labels_lookup": cluster_labels_lookup,
        "hierarchical_labels": False,
        "rows": n_rows,
        "columns": scope_df.columns.tolist(),
        "size": os.path.getsize(parquet_path),
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    json_path = os.path.join(scopes_dir, f"{scope_id}.json")
    with open(json_path, "w") as f:
        json.dump(scope_meta, f, indent=2)
    print(f"Wrote {json_path}")

    # ── Export to LanceDB (no vector column) ─────────────────────────
    db_uri = os.path.join(dataset_path, "lancedb")
    os.makedirs(db_uri, exist_ok=True)
    db = lancedb.connect(db_uri)

    print(f"Creating LanceDB table '{lancedb_table_id}'")
    tbl = db.create_table(lancedb_table_id, scope_df, mode="overwrite")
    tbl.create_scalar_index("cluster", index_type="BTREE")
    print(f"LanceDB table created with {len(scope_df)} rows")

    # ── Register in catalog ──────────────────────────────────────────
    upsert_scope_meta(
        data_dir,
        dataset_id=dataset_id,
        scope_id=scope_id,
        scope_meta=scope_meta,
        is_active=True,
    )

    upsert_dataset_meta(
        data_dir,
        dataset_id=dataset_id,
        meta=dataset_meta,
        active_scope_id=scope_id,
    )

    print(f"\nStub scope created: {dataset_id}/explore/{scope_id}")
    return scope_id


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create a stub scope (no pipeline)")
    parser.add_argument("--dataset", required=True, help="Dataset ID")
    parser.add_argument("--scope_id", default="scopes-001", help="Scope ID (default: scopes-001)")
    args = parser.parse_args()
    create_stub_scope(args.dataset, args.scope_id)
