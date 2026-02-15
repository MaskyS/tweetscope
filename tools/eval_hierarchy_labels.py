#!/usr/bin/env python3
"""
Evaluate hierarchical cluster labels quality.

Reads existing scope + cluster labels and computes structural and label metrics.
Outputs JSON + Markdown report.

Usage:
    uv run python3 scripts/eval_hierarchy_labels.py --dataset visakanv-tweets
    uv run python3 scripts/eval_hierarchy_labels.py --dataset visakanv-tweets --scope scopes-002
    uv run python3 scripts/eval_hierarchy_labels.py --dataset visakanv-tweets --cluster-labels toponymy-001
"""

import os
import sys
import json
import argparse
from datetime import datetime
from collections import Counter, defaultdict

# Add project root to path for latentscope imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from latentscope.util import get_data_dir


def load_scope(dataset_path, scope_id):
    """Load scope metadata and parquet."""
    import pandas as pd

    scope_file = os.path.join(dataset_path, "scopes", f"{scope_id}.json")
    with open(scope_file) as f:
        scope_meta = json.load(f)

    scope_parquet = os.path.join(dataset_path, "scopes", f"{scope_id}-input.parquet")
    if os.path.exists(scope_parquet):
        scope_df = pd.read_parquet(scope_parquet)
    else:
        scope_parquet = os.path.join(dataset_path, "scopes", f"{scope_id}.parquet")
        scope_df = pd.read_parquet(scope_parquet)

    return scope_meta, scope_df


def load_cluster_labels(dataset_path, cluster_labels_id):
    """Load cluster labels (parquet + JSON metadata)."""
    import pandas as pd

    labels_file = os.path.join(dataset_path, "clusters", f"{cluster_labels_id}.json")
    with open(labels_file) as f:
        labels_meta = json.load(f)

    labels_parquet = os.path.join(dataset_path, "clusters", f"{cluster_labels_id}.parquet")
    labels_df = pd.read_parquet(labels_parquet)

    return labels_meta, labels_df


def eval_structure(labels_df, scope_meta, scope_df):
    """Evaluate structural correctness of hierarchy."""
    results = {}

    # Build cluster lookup
    clusters = {}
    for _, row in labels_df.iterrows():
        cid = row["cluster"]
        clusters[cid] = {
            "layer": row["layer"],
            "label": row["label"],
            "count": row["count"],
            "parent_cluster": row.get("parent_cluster"),
            "children": row.get("children", []),
        }

    # --- Layer stats ---
    layers = defaultdict(list)
    for cid, c in clusters.items():
        if cid == "unknown":
            continue
        layers[c["layer"]].append(cid)

    results["num_layers"] = len(layers)
    results["clusters_per_layer"] = {int(k): len(v) for k, v in sorted(layers.items())}
    results["total_clusters"] = sum(len(v) for v in layers.values())

    # --- Parent validity ---
    invalid_parent_refs = 0
    orphan_nodes = 0
    wrong_layer_parents = 0
    parent_details = []

    max_layer = max(layers.keys()) if layers else 0

    for cid, c in clusters.items():
        if cid == "unknown":
            continue
        parent = c["parent_cluster"]

        # Top layer should have no parent
        if c["layer"] == max_layer:
            if parent is not None:
                parent_details.append(f"{cid}: top-layer node has parent {parent}")
            continue

        # Non-top layers must have a parent
        if parent is None:
            orphan_nodes += 1
            parent_details.append(f"{cid} (layer {c['layer']}): no parent")
            continue

        # Parent must exist
        if parent not in clusters:
            invalid_parent_refs += 1
            parent_details.append(f"{cid}: parent {parent} does not exist")
            continue

        # Parent must be in layer + 1
        parent_layer = clusters[parent]["layer"]
        expected_layer = c["layer"] + 1
        if parent_layer != expected_layer:
            wrong_layer_parents += 1
            parent_details.append(
                f"{cid} (layer {c['layer']}): parent {parent} is layer {parent_layer}, expected {expected_layer}"
            )

    results["invalid_parent_refs"] = invalid_parent_refs
    results["orphan_nodes"] = orphan_nodes
    results["wrong_layer_parents"] = wrong_layer_parents
    results["parent_issues"] = parent_details

    # --- Coverage ---
    total_rows = scope_meta.get("rows", len(scope_df))

    # Count assigned rows from layer 0 clusters
    layer0_assigned = sum(
        clusters[cid]["count"] for cid in layers.get(0, [])
    )
    unknown_count = clusters.get("unknown", {}).get("count", 0)

    # Also check scope parquet for actual unknown assignment
    if "cluster" in scope_df.columns:
        actual_unknown = int((scope_df["cluster"] == "unknown").sum())
    else:
        actual_unknown = total_rows - layer0_assigned

    results["total_rows"] = total_rows
    results["layer0_assigned"] = layer0_assigned
    results["unknown_count_metadata"] = unknown_count
    results["unknown_count_actual"] = actual_unknown
    results["coverage_gap"] = total_rows - layer0_assigned - actual_unknown
    results["unknown_count_mismatch"] = unknown_count != actual_unknown

    # --- Duplicate assignment check ---
    # Check if any child appears in multiple parents
    child_parents = defaultdict(list)
    for cid, c in clusters.items():
        if cid == "unknown":
            continue
        children = c.get("children", [])
        if isinstance(children, list):
            for child in children:
                child_parents[child].append(cid)

    multi_parent = {k: v for k, v in child_parents.items() if len(v) > 1}
    results["duplicate_assignments"] = len(multi_parent)
    if multi_parent:
        results["duplicate_assignment_details"] = {k: v for k, v in multi_parent.items()}

    return results


def eval_labels(labels_df):
    """Evaluate label quality metrics."""
    results = {}

    # Filter out unknown
    real_labels = labels_df[labels_df["cluster"] != "unknown"]

    # --- Duplicate labels per layer ---
    dup_per_layer = {}
    layers = real_labels["layer"].unique()

    for layer in sorted(layers):
        layer_labels = real_labels[real_labels["layer"] == layer]["label"].tolist()
        counts = Counter(layer_labels)
        duplicates = {k: v for k, v in counts.items() if v > 1}
        n_clusters = len(layer_labels)
        n_dup_clusters = sum(v for v in duplicates.values()) - len(duplicates)  # extra occurrences

        dup_per_layer[int(layer)] = {
            "total_clusters": n_clusters,
            "duplicate_labels": duplicates,
            "duplicate_rate": n_dup_clusters / n_clusters if n_clusters > 0 else 0,
        }

    results["duplicates_per_layer"] = dup_per_layer

    # --- Label type ---
    # Check if labels are generic ("Cluster N") or meaningful
    generic_count = 0
    meaningful_count = 0
    for label in real_labels["label"]:
        if label.startswith("Cluster ") or "Auto-group" in str(label):
            generic_count += 1
        else:
            meaningful_count += 1

    results["generic_labels"] = generic_count
    results["meaningful_labels"] = meaningful_count
    results["label_quality"] = "toponymy" if meaningful_count > generic_count else "fallback"

    # --- Label length stats ---
    lengths = [len(str(l)) for l in real_labels["label"]]
    if lengths:
        results["label_length_min"] = min(lengths)
        results["label_length_max"] = max(lengths)
        results["label_length_mean"] = round(sum(lengths) / len(lengths), 1)

    return results


def generate_report(dataset_id, scope_id, cluster_labels_id, structure, labels):
    """Generate combined JSON and Markdown reports."""
    report = {
        "timestamp": datetime.now().isoformat(),
        "dataset_id": dataset_id,
        "scope_id": scope_id,
        "cluster_labels_id": cluster_labels_id,
        "structure": structure,
        "labels": labels,
    }

    # Overall health score
    issues = 0
    if structure["invalid_parent_refs"] > 0:
        issues += 1
    if structure["orphan_nodes"] > 0:
        issues += 1
    if structure["wrong_layer_parents"] > 0:
        issues += 1
    if structure["coverage_gap"] != 0:
        issues += 1
    if structure["unknown_count_mismatch"]:
        issues += 1
    if structure["duplicate_assignments"] > 0:
        issues += 1
    if labels["label_quality"] == "fallback":
        issues += 1

    report["health_score"] = max(0, 100 - issues * 15)
    report["issues_count"] = issues

    return report


def format_markdown(report):
    """Format report as Markdown."""
    s = report["structure"]
    l = report["labels"]

    lines = [
        f"# Hierarchy Evaluation: {report['dataset_id']}",
        f"**Scope:** {report['scope_id']} | **Labels:** {report['cluster_labels_id']}",
        f"**Date:** {report['timestamp'][:19]}",
        f"**Health Score:** {report['health_score']}/100 ({report['issues_count']} issues)",
        "",
        "## Structure",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Layers | {s['num_layers']} |",
        f"| Total clusters | {s['total_clusters']} |",
        f"| Clusters per layer | {s['clusters_per_layer']} |",
        f"| Invalid parent refs | {s['invalid_parent_refs']} |",
        f"| Orphan nodes | {s['orphan_nodes']} |",
        f"| Wrong layer parents | {s['wrong_layer_parents']} |",
        f"| Duplicate assignments | {s['duplicate_assignments']} |",
        "",
        "## Coverage",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Total rows | {s['total_rows']} |",
        f"| Layer 0 assigned | {s['layer0_assigned']} |",
        f"| Unknown (metadata) | {s['unknown_count_metadata']} |",
        f"| Unknown (actual) | {s['unknown_count_actual']} |",
        f"| Coverage gap | {s['coverage_gap']} |",
        f"| Unknown mismatch | {s['unknown_count_mismatch']} |",
        "",
        "## Labels",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Quality | {l['label_quality']} |",
        f"| Meaningful labels | {l['meaningful_labels']} |",
        f"| Generic labels | {l['generic_labels']} |",
    ]

    if "label_length_mean" in l:
        lines.extend([
            f"| Label length (min/mean/max) | {l['label_length_min']}/{l['label_length_mean']}/{l['label_length_max']} |",
        ])

    lines.append("")
    lines.append("### Duplicates per Layer")
    for layer, info in sorted(l["duplicates_per_layer"].items()):
        rate_pct = round(info["duplicate_rate"] * 100, 1)
        lines.append(f"- **Layer {layer}:** {info['total_clusters']} clusters, {rate_pct}% duplicate rate")
        if info["duplicate_labels"]:
            for label, count in info["duplicate_labels"].items():
                lines.append(f"  - \"{label}\" x{count}")

    if s["parent_issues"]:
        lines.append("")
        lines.append("### Parent Issues")
        for issue in s["parent_issues"]:
            lines.append(f"- {issue}")

    lines.append("")
    return "\n".join(lines)


def compare_reports(baseline, upgraded):
    """Compare two eval reports and check promotion gates."""
    gates = {}

    sb = baseline["structure"]
    su = upgraded["structure"]
    lb = baseline["labels"]
    lu = upgraded["labels"]

    # Gate 1: Structural validity (invalid parents = 0)
    gates["invalid_parents"] = {
        "baseline": sb["invalid_parent_refs"],
        "upgraded": su["invalid_parent_refs"],
        "pass": su["invalid_parent_refs"] == 0,
        "gate": "== 0",
    }

    # Gate 2: No orphans
    gates["orphan_nodes"] = {
        "baseline": sb["orphan_nodes"],
        "upgraded": su["orphan_nodes"],
        "pass": su["orphan_nodes"] == 0,
        "gate": "== 0",
    }

    # Gate 3: Coverage gap = 0
    gates["coverage_gap"] = {
        "baseline": sb["coverage_gap"],
        "upgraded": su["coverage_gap"],
        "pass": su["coverage_gap"] == 0,
        "gate": "== 0",
    }

    # Gate 4: Label duplicates per layer <= 2%
    max_dup_rate = 0
    for layer, info in lu["duplicates_per_layer"].items():
        max_dup_rate = max(max_dup_rate, info["duplicate_rate"])
    baseline_max_dup = 0
    for layer, info in lb["duplicates_per_layer"].items():
        baseline_max_dup = max(baseline_max_dup, info["duplicate_rate"])

    gates["max_duplicate_rate"] = {
        "baseline": round(baseline_max_dup * 100, 1),
        "upgraded": round(max_dup_rate * 100, 1),
        "pass": max_dup_rate <= 0.02,
        "gate": "<= 2%",
    }

    # Gate 5: Health score improved
    gates["health_score"] = {
        "baseline": baseline["health_score"],
        "upgraded": upgraded["health_score"],
        "pass": upgraded["health_score"] >= baseline["health_score"],
        "gate": ">= baseline",
    }

    # Gate 6: Label quality is toponymy (not fallback)
    gates["label_quality"] = {
        "baseline": lb["label_quality"],
        "upgraded": lu["label_quality"],
        "pass": lu["label_quality"] == "toponymy",
        "gate": "== toponymy",
    }

    all_passed = all(g["pass"] for g in gates.values())

    return {
        "gates": gates,
        "all_passed": all_passed,
        "baseline_id": baseline["cluster_labels_id"],
        "upgraded_id": upgraded["cluster_labels_id"],
    }


def format_comparison_markdown(comparison):
    """Format comparison as Markdown."""
    lines = [
        f"# Pipeline Bakeoff: {comparison['baseline_id']} vs {comparison['upgraded_id']}",
        f"**Result:** {'PASS — ready for promotion' if comparison['all_passed'] else 'FAIL — gates not met'}",
        "",
        "## Promotion Gates",
        "| Gate | Baseline | Upgraded | Threshold | Pass |",
        "|------|----------|----------|-----------|------|",
    ]

    for name, g in comparison["gates"].items():
        status = "YES" if g["pass"] else "NO"
        lines.append(f"| {name} | {g['baseline']} | {g['upgraded']} | {g['gate']} | {status} |")

    lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Evaluate hierarchical cluster labels")
    parser.add_argument("--dataset", type=str, required=True, help="Dataset id")
    parser.add_argument("--scope", type=str, default=None, help="Scope id (auto-detected if not given)")
    parser.add_argument("--cluster-labels", type=str, default=None, help="Cluster labels id (auto-detected from scope)")
    parser.add_argument("--compare", type=str, default=None, help="Second cluster-labels id for bakeoff comparison")
    parser.add_argument("--output-dir", type=str, default=None, help="Output directory (default: reports/)")
    args = parser.parse_args()

    DATA_DIR = get_data_dir()
    dataset_path = os.path.join(DATA_DIR, args.dataset)

    if not os.path.isdir(dataset_path):
        print(f"Error: dataset directory not found: {dataset_path}")
        sys.exit(1)

    # Auto-detect scope
    scope_id = args.scope
    if scope_id is None:
        scope_dir = os.path.join(dataset_path, "scopes")
        scope_files = sorted(
            [
                f
                for f in os.listdir(scope_dir)
                if f.endswith(".json") and not f.endswith("-transactions.json")
            ]
        )
        if not scope_files:
            print("Error: no scope files found")
            sys.exit(1)
        scope_id = scope_files[-1].replace(".json", "")
        print(f"Auto-detected scope: {scope_id}")

    # Load scope
    scope_meta, scope_df = load_scope(dataset_path, scope_id)
    print(f"Loaded scope {scope_id}: {len(scope_df)} rows")

    # Auto-detect cluster labels
    cluster_labels_id = args.cluster_labels
    if cluster_labels_id is None:
        cluster_labels_id = scope_meta.get("cluster_labels_id")
        if cluster_labels_id is None:
            print("Error: no cluster_labels_id in scope metadata and none specified")
            sys.exit(1)
        print(f"Auto-detected cluster labels: {cluster_labels_id}")

    # Load cluster labels
    labels_meta, labels_df = load_cluster_labels(dataset_path, cluster_labels_id)
    print(f"Loaded {len(labels_df)} cluster label entries")

    # Also check for inline labels in scope metadata
    cluster_labels_lookup = scope_meta.get("cluster_labels_lookup")
    if cluster_labels_lookup and len(labels_df) == 0:
        import pandas as pd
        labels_df = pd.DataFrame(cluster_labels_lookup)
        print(f"Using inline cluster_labels_lookup: {len(labels_df)} entries")

    # Run evaluations
    print("\nEvaluating structure...")
    structure = eval_structure(labels_df, scope_meta, scope_df)

    print("Evaluating labels...")
    labels = eval_labels(labels_df)

    # Generate report
    report = generate_report(args.dataset, scope_id, cluster_labels_id, structure, labels)
    markdown = format_markdown(report)

    # Print to console
    print("\n" + markdown)

    # Save reports
    output_dir = args.output_dir or os.path.join(os.path.dirname(__file__), "..", "reports")
    os.makedirs(output_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base_name = f"eval-{args.dataset}-{cluster_labels_id}-{timestamp}"

    json_path = os.path.join(output_dir, f"{base_name}.json")
    md_path = os.path.join(output_dir, f"{base_name}.md")

    with open(json_path, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"\nJSON report: {json_path}")

    with open(md_path, "w") as f:
        f.write(markdown)
    print(f"Markdown report: {md_path}")

    # Bakeoff comparison mode
    if args.compare:
        print(f"\n--- Bakeoff: comparing {cluster_labels_id} vs {args.compare} ---")
        labels_meta2, labels_df2 = load_cluster_labels(dataset_path, args.compare)
        structure2 = eval_structure(labels_df2, scope_meta, scope_df)
        labels2 = eval_labels(labels_df2)
        report2 = generate_report(args.dataset, scope_id, args.compare, structure2, labels2)

        comparison = compare_reports(report, report2)
        comp_md = format_comparison_markdown(comparison)
        print("\n" + comp_md)

        comp_base = f"bakeoff-{args.dataset}-{cluster_labels_id}-vs-{args.compare}-{timestamp}"
        comp_json_path = os.path.join(output_dir, f"{comp_base}.json")
        comp_md_path = os.path.join(output_dir, f"{comp_base}.md")

        with open(comp_json_path, "w") as f:
            json.dump(comparison, f, indent=2, default=str)
        with open(comp_md_path, "w") as f:
            f.write(comp_md)
        print(f"Bakeoff JSON: {comp_json_path}")
        print(f"Bakeoff MD: {comp_md_path}")

    return report


if __name__ == "__main__":
    main()
