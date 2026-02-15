#!/usr/bin/env python3
"""Validate scope artifacts against the schema contract before CDN deploy.

Usage:
    uv run python3 scripts/validate_scope_artifacts.py <dataset_path> <scope_id>
    uv run python3 scripts/validate_scope_artifacts.py ~/latent-scope-data/sheik-tweets scopes-002

Exit codes:
    0  All checks passed
    1  Validation failures found
"""

import argparse
import json
import os
import sys

import pandas as pd
import pyarrow.parquet as pq


# ---------------------------------------------------------------------------
# Contract loading
# ---------------------------------------------------------------------------
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load_contract(path_or_name):
    path = path_or_name
    if not os.path.isabs(path_or_name):
        path = os.path.join(REPO_ROOT, "contracts", path_or_name)
    with open(path) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
def _resolve_cluster_labels_id(scope_meta):
    cl_id = scope_meta.get("cluster_labels_id")
    if cl_id and cl_id != "default":
        return cl_id
    cluster_labels = scope_meta.get("cluster_labels")
    if isinstance(cluster_labels, dict):
        label_id = cluster_labels.get("id")
        if label_id:
            return label_id
    return cl_id


def check_scope_json(dataset_path, scope_id):
    errors = []
    scope_json_path = os.path.join(dataset_path, "scopes", f"{scope_id}.json")
    if not os.path.exists(scope_json_path):
        errors.append(f"Scope JSON not found: {scope_json_path}")
        return errors, None

    with open(scope_json_path) as f:
        scope_meta = json.load(f)

    for key in ["cluster_labels_id", "cluster_id", "embedding_id", "umap_id"]:
        if key not in scope_meta:
            errors.append(f"Scope JSON missing key: {key}")

    cl_id = _resolve_cluster_labels_id(scope_meta)
    if cl_id:
        cl_parquet = os.path.join(dataset_path, "clusters", f"{cl_id}.parquet")
        if not os.path.exists(cl_parquet):
            errors.append(f"Referenced cluster labels not found: {cl_parquet}")

    return errors, scope_meta


def check_scope_input_parquet(dataset_path, scope_id, contract):
    errors = []
    parquet_path = os.path.join(dataset_path, "scopes", f"{scope_id}-input.parquet")
    if not os.path.exists(parquet_path):
        errors.append(f"Scope input parquet not found: {parquet_path}")
        return errors

    schema = pq.read_schema(parquet_path)
    column_names = set(schema.names)

    # Required columns
    required = contract.get("required_columns", {})
    missing = [col for col in required if col not in column_names]
    if missing:
        errors.append(f"Missing required columns: {missing}")

    # id must be string type
    if "id" in column_names:
        id_type = str(schema.field("id").type).lower()
        if "string" not in id_type and "utf8" not in id_type:
            errors.append(f"Column 'id' must be string type, got: {schema.field('id').type}")

    # Load a sample for row-level checks
    df = pd.read_parquet(parquet_path)
    if df.empty:
        errors.append("Parquet has 0 rows")

    if len(df.columns) != len(set(df.columns)):
        errors.append("Duplicate column names in parquet")

    return errors


def check_links_artifacts(dataset_path, links_contract):
    errors = []
    links_dir = os.path.join(dataset_path, "links")
    if not os.path.exists(links_dir):
        return errors  # links are optional

    for artifact in ["edges.parquet", "node_link_stats.parquet", "meta.json"]:
        if not os.path.exists(os.path.join(links_dir, artifact)):
            errors.append(f"Links artifact missing: {artifact}")

    edges_path = os.path.join(links_dir, "edges.parquet")
    if os.path.exists(edges_path):
        schema = pq.read_schema(edges_path)
        edge_cols = set(schema.names)
        required = set(links_contract["edges"]["required_columns"].keys())
        missing = required - edge_cols
        if missing:
            errors.append(f"Missing columns in edges.parquet: {sorted(missing)}")

        for col in ["src_tweet_id", "dst_tweet_id"]:
            if col in edge_cols:
                col_type = str(schema.field(col).type).lower()
                if "string" not in col_type and "utf8" not in col_type:
                    errors.append(f"edges.parquet '{col}' must be string, got: {schema.field(col).type}")

    node_stats_path = os.path.join(links_dir, "node_link_stats.parquet")
    if os.path.exists(node_stats_path):
        schema = pq.read_schema(node_stats_path)
        node_cols = set(schema.names)
        required = set(links_contract["node_stats"]["required_columns"].keys())
        missing = required - node_cols
        if missing:
            errors.append(f"Missing columns in node_link_stats.parquet: {sorted(missing)}")

    return errors


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Validate scope artifacts against schema contract")
    parser.add_argument("dataset_path", help="Path to dataset directory")
    parser.add_argument("scope_id", help="Scope ID (e.g. scopes-002)")
    parser.add_argument(
        "--scope-contract",
        default="scope_input.schema.json",
        help="Scope input contract path or filename",
    )
    parser.add_argument(
        "--links-contract",
        default="links.schema.json",
        help="Links contract path or filename",
    )
    args = parser.parse_args()

    scope_contract = load_contract(args.scope_contract)
    links_contract = load_contract(args.links_contract)

    all_errors = []

    print(f"Validating {args.scope_id} in {args.dataset_path}...")
    print()

    # 1. Scope JSON
    scope_errors, scope_meta = check_scope_json(args.dataset_path, args.scope_id)
    all_errors.extend(scope_errors)
    if scope_meta:
        resolved_id = _resolve_cluster_labels_id(scope_meta) or "n/a"
        print(f"  Scope JSON: OK (cluster_labels={resolved_id})")
    else:
        print(f"  Scope JSON: MISSING")

    # 2. Input parquet
    parquet_errors = check_scope_input_parquet(args.dataset_path, args.scope_id, scope_contract)
    all_errors.extend(parquet_errors)
    if not parquet_errors:
        print(f"  Input parquet: OK")
    else:
        print(f"  Input parquet: {len(parquet_errors)} error(s)")

    # 3. Links
    links_errors = check_links_artifacts(args.dataset_path, links_contract)
    all_errors.extend(links_errors)
    links_dir = os.path.join(args.dataset_path, "links")
    if not os.path.exists(links_dir):
        print(f"  Links: skipped (not present)")
    elif not links_errors:
        print(f"  Links: OK")
    else:
        print(f"  Links: {len(links_errors)} error(s)")

    print()

    if all_errors:
        print(f"FAIL: {len(all_errors)} validation error(s)")
        for i, err in enumerate(all_errors, 1):
            print(f"  {i}. {err}")
        sys.exit(1)
    else:
        print(f"PASS: All artifacts valid (contract: {scope_contract.get('version', '?')})")
        sys.exit(0)


if __name__ == "__main__":
    main()
