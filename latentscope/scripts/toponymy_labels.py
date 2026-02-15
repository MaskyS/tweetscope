"""
Generate hierarchical cluster labels using Toponymy.

This script takes an existing scope and generates hierarchical topic labels
using Toponymy's clustering and LLM naming capabilities.

Usage:
    python -m latentscope.scripts.toponymy_labels dataset_id scope_id \
        --llm-provider openai --llm-model gpt-5-mini
"""

import os
import sys
import json
import argparse
import pandas as pd
import numpy as np
import h5py
from datetime import datetime

# Use local toponymy (with GPT-5 support) instead of installed package
# Resolve to absolute path for robust path comparison and to work with uv/different CWDs
_script_dir = os.path.dirname(os.path.abspath(__file__))
_local_toponymy = os.path.normpath(os.path.join(_script_dir, '..', '..', 'toponymy'))
_sys_paths_normalized = [os.path.normpath(p) for p in sys.path]
if os.path.exists(_local_toponymy) and _local_toponymy not in _sys_paths_normalized:
    sys.path.insert(0, _local_toponymy)
    print(f"Using local toponymy from: {_local_toponymy}")

from latentscope.util import get_data_dir
from latentscope import __version__


def main():
    parser = argparse.ArgumentParser(description='Generate hierarchical cluster labels using Toponymy')
    parser.add_argument('dataset_id', type=str, help='Dataset id (directory name in data folder)')
    parser.add_argument('scope_id', type=str, help='Scope id to generate labels for')
    parser.add_argument('--llm-provider', type=str, default='openai',
                        choices=['openai', 'anthropic', 'cohere', 'google'],
                        help='LLM provider for topic naming')
    parser.add_argument('--llm-model', type=str, default='gpt-5-mini',
                        help='LLM model name')
    parser.add_argument('--min-clusters', type=int, default=2,
                        help='Minimum number of clusters per layer')
    parser.add_argument('--base-min-cluster-size', type=int, default=10,
                        help='Minimum cluster size for finest layer')
    parser.add_argument('--output-id', type=str, default=None,
                        help='Output cluster labels id (default: auto-generated)')
    parser.add_argument('--context', type=str, default=None,
                        help='Context description for LLM (e.g., "tweets from a tech founder")')
    parser.add_argument('--sync-llm', action='store_true',
                        help='Force synchronous LLM wrapper (default: async for OpenAI/Anthropic)')
    parser.add_argument('--adaptive-exemplars', action=argparse.BooleanOptionalAction, default=True,
                        help='Enable adaptive exemplar/keyphrase counts by cluster size (default: enabled)')

    args = parser.parse_args()
    run_toponymy_labeling(**vars(args))


def run_toponymy_labeling(
    dataset_id: str,
    scope_id: str,
    llm_provider: str = "openai",
    llm_model: str = "gpt-5-mini",
    min_clusters: int = 2,
    base_min_cluster_size: int = 10,
    output_id: str = None,
    context: str = None,
    sync_llm: bool = False,
    adaptive_exemplars: bool = True,
):
    """
    Generate hierarchical cluster labels using Toponymy.

    Args:
        dataset_id: Dataset directory name
        scope_id: Scope to generate labels for
        llm_provider: LLM provider (openai, anthropic, cohere)
        llm_model: Model name for the provider
        min_clusters: Minimum clusters per layer
        base_min_cluster_size: Minimum cluster size for layer 0
        output_id: Output cluster labels id (auto-generated if None)
        context: Context description for LLM prompts
        sync_llm: If True, force synchronous LLM wrapper
        adaptive_exemplars: If True, adapt exemplar/keyphrase counts to cluster sizes
    """
    from toponymy import Toponymy, ToponymyClusterer
    from toponymy.embedding_wrappers import VoyageAIEmbedder

    DATA_DIR = get_data_dir()
    dataset_path = os.path.join(DATA_DIR, dataset_id)

    print(f"Loading scope {scope_id} from {dataset_path}")

    # Load scope metadata
    scope_file = os.path.join(dataset_path, "scopes", f"{scope_id}.json")
    with open(scope_file) as f:
        scope_meta = json.load(f)

    embedding_id = scope_meta["embedding_id"]
    umap_id = scope_meta["umap_id"]
    text_column = scope_meta.get("dataset", {}).get("text_column", "text")

    # Load texts from input
    print("Loading texts...")
    input_df = pd.read_parquet(os.path.join(dataset_path, "input.parquet"))
    texts = input_df[text_column].tolist()
    print(f"  Loaded {len(texts)} texts")

    # Load embeddings
    print(f"Loading embeddings from {embedding_id}...")
    with h5py.File(os.path.join(dataset_path, "embeddings", f"{embedding_id}.h5"), "r") as f:
        embedding_vectors = f["embeddings"][:]
    print(f"  Loaded embeddings: {embedding_vectors.shape}")

    # Load UMAP coordinates for clustering
    # Check if a dedicated clustering manifold exists (kD)
    cluster_id = scope_meta.get("cluster_id")
    clustering_umap_id = None
    if cluster_id:
        cluster_meta_file = os.path.join(dataset_path, "clusters", f"{cluster_id}.json")
        if os.path.exists(cluster_meta_file):
            with open(cluster_meta_file) as f:
                cluster_meta = json.load(f)
            clustering_umap_id = cluster_meta.get("clustering_umap_id")

    if clustering_umap_id:
        print(f"Loading clustering manifold from {clustering_umap_id}...")
        clustering_df = pd.read_parquet(os.path.join(dataset_path, "umaps", f"{clustering_umap_id}.parquet"))
        dim_cols = [c for c in clustering_df.columns if c.startswith("dim_")]
        if dim_cols:
            clusterable_vectors = clustering_df[dim_cols].values
            print(f"  Loaded {len(dim_cols)}D clustering manifold: {clusterable_vectors.shape}")
        else:
            print(f"  WARNING: {clustering_umap_id} has no dim_* columns, falling back to display UMAP")
            umap_df = pd.read_parquet(os.path.join(dataset_path, "umaps", f"{umap_id}.parquet"))
            clusterable_vectors = umap_df[["x", "y"]].values
    else:
        print(f"Loading UMAP coordinates from {umap_id}...")
        umap_df = pd.read_parquet(os.path.join(dataset_path, "umaps", f"{umap_id}.parquet"))
        clusterable_vectors = umap_df[["x", "y"]].values
    print(f"  Clusterable vectors shape: {clusterable_vectors.shape}")

    # Always load display UMAP for hull/centroid calculations
    print(f"Loading display UMAP from {umap_id}...")
    display_umap_df = pd.read_parquet(os.path.join(dataset_path, "umaps", f"{umap_id}.parquet"))
    display_vectors = display_umap_df[["x", "y"]].values
    print(f"  Display vectors shape: {display_vectors.shape}")

    # Configure LLM wrapper
    print(f"Configuring LLM: {llm_provider}/{llm_model}")
    use_async_llm = (not sync_llm) and (llm_provider in {"openai", "anthropic"})
    print(f"  LLM mode: {'async' if use_async_llm else 'sync'}")
    llm = get_llm_wrapper(llm_provider, llm_model, async_mode=use_async_llm)

    # Configure clusterer
    print(f"Configuring ToponymyClusterer (min_clusters={min_clusters}, base_min_cluster_size={base_min_cluster_size})")
    clusterer = ToponymyClusterer(
        min_clusters=min_clusters,
        base_min_cluster_size=base_min_cluster_size,
        verbose=True
    )

    # Load text embedding model for keyphrase extraction (Voyage API)
    voyage_api_key = os.environ.get("VOYAGE_API_KEY")
    if not voyage_api_key:
        raise ValueError("VOYAGE_API_KEY environment variable is required for keyphrase embedding")
    print("Loading Voyage embedder for keyphrase extraction...")
    text_embedder = VoyageAIEmbedder(api_key=voyage_api_key, model="voyage-4-lite")

    # Determine context
    if context is None:
        context = f"documents from the {dataset_id} dataset"

    # Create Toponymy model
    print("Creating Toponymy model...")
    topic_model = Toponymy(
        llm_wrapper=llm,
        text_embedding_model=text_embedder,
        clusterer=clusterer,
        object_description=context,
        corpus_description=f"A collection of {len(texts)} {context}"
    )

    # Fit the model
    print("\nFitting Toponymy model (this may take a while)...")
    topic_model.fit(
        texts,
        embedding_vectors,
        clusterable_vectors,
        adaptive_exemplars=adaptive_exemplars,
    )

    # Audit-driven relabel loop (Phase 5)
    from toponymy.audit import flag_clusters_for_relabel, run_relabel_pass

    audit_info = {"flagged_before": 0, "flagged_after": 0, "relabeled": 0, "passes_run": 0}
    flagged = flag_clusters_for_relabel(topic_model)
    audit_info["flagged_before"] = len(flagged)
    if flagged:
        print(f"\nAudit: {len(flagged)} clusters flagged for relabeling")
        for layer_idx, cluster_idx, reasons in flagged[:10]:
            print(f"  Layer {layer_idx} cluster {cluster_idx}: {', '.join(reasons)}")
        if len(flagged) > 10:
            print(f"  ... and {len(flagged) - 10} more")

        relabel_stats = run_relabel_pass(topic_model, flagged, llm, max_passes=2)
        audit_info["relabeled"] = relabel_stats["relabeled"]
        audit_info["passes_run"] = relabel_stats["passes_run"]
        print(f"  Relabel results: {relabel_stats['relabeled']} relabeled, {relabel_stats['passes_run']} passes")

        # Re-audit after relabeling
        remaining = flag_clusters_for_relabel(topic_model)
        audit_info["flagged_after"] = len(remaining)
        print(f"  After relabel: {len(remaining)} clusters still flagged")
    else:
        print("\nAudit: all cluster labels passed quality checks")

    # Extract hierarchical structure
    # Use display vectors (2D) for hull/centroid calculations
    print("\nExtracting hierarchical cluster structure...")
    hierarchical_labels = build_hierarchical_labels(
        topic_model,
        display_vectors,
        texts
    )

    print(f"\nGenerated {len(hierarchical_labels)} cluster labels across {len(topic_model.topic_names_)} layers:")
    for layer_idx, layer_names in enumerate(topic_model.topic_names_):
        print(f"  Layer {layer_idx}: {len(layer_names)} topics")

    # Save results
    output_id = output_id or generate_output_id(dataset_path)
    save_hierarchical_labels(
        dataset_path,
        output_id,
        hierarchical_labels,
        topic_model,
        scope_meta,
        llm_provider=llm_provider,
        llm_model=llm_model,
        min_clusters=min_clusters,
        base_min_cluster_size=base_min_cluster_size,
        audit_info=audit_info
    )

    print(f"\nSaved hierarchical labels to: clusters/{output_id}.parquet")
    print(f"Metadata saved to: clusters/{output_id}.json")

    return output_id


def get_llm_wrapper(provider: str, model: str, async_mode: bool = False):
    """Get the appropriate LLM wrapper based on provider.

    Args:
        provider: LLM provider name (openai, anthropic, cohere, google)
        model: Model name for the provider
        async_mode: If True, return an async wrapper when available. Defaults to False.
    """
    # Google uses GOOGLE_API_KEY not GOOGLE_API_KEY
    env_key = "GOOGLE_API_KEY" if provider == "google" else f"{provider.upper()}_API_KEY"
    api_key = os.environ.get(env_key)

    if not api_key:
        raise ValueError(f"{env_key} environment variable is required")

    if provider == "openai":
        if async_mode:
            from toponymy.llm_wrappers import AsyncOpenAINamer
            return AsyncOpenAINamer(api_key=api_key, model=model)
        from toponymy.llm_wrappers import OpenAINamer
        return OpenAINamer(api_key=api_key, model=model)
    elif provider == "anthropic":
        if async_mode:
            from toponymy.llm_wrappers import AsyncAnthropicNamer
            return AsyncAnthropicNamer(api_key=api_key, model=model)
        from toponymy.llm_wrappers import AnthropicNamer
        return AnthropicNamer(api_key=api_key, model=model)
    elif provider == "cohere":
        from toponymy.llm_wrappers import CohereNamer
        return CohereNamer(api_key=api_key, model=model)
    elif provider == "google":
        from toponymy.llm_wrappers import GoogleGeminiNamer
        return GoogleGeminiNamer(api_key=api_key, model=model)
    else:
        raise ValueError(f"Unknown LLM provider: {provider}")


def _build_child_to_parent_map(cluster_tree, num_layers):
    """
    Build a deterministic child→parent mapping from the cluster tree.

    The cluster_tree dict maps parent (layer, idx) → list of child (layer, idx).
    We invert it in one pass and validate invariants:
      - Each child has exactly one parent
      - Parent layer == child layer + 1
      - Parent node must exist in the tree or be a valid top-layer node

    Returns:
        child_to_parent: dict mapping (child_layer, child_idx) → (parent_layer, parent_idx)
        violations: list of warning strings (empty if tree is valid)
    """
    child_to_parent = {}
    violations = []

    for parent_node, children_list in cluster_tree.items():
        parent_layer, parent_idx = parent_node
        for child_node in children_list:
            child_layer, child_idx = child_node

            # Invariant: parent layer must be child layer + 1
            if parent_layer != child_layer + 1:
                violations.append(
                    f"({child_layer}_{child_idx}): parent ({parent_layer}_{parent_idx}) "
                    f"layer {parent_layer} != expected {child_layer + 1}"
                )
                continue

            # Invariant: no duplicate assignment
            if child_node in child_to_parent:
                existing = child_to_parent[child_node]
                violations.append(
                    f"({child_layer}_{child_idx}): duplicate parent - "
                    f"already assigned to ({existing[0]}_{existing[1]}), "
                    f"also claimed by ({parent_layer}_{parent_idx})"
                )
                continue

            child_to_parent[child_node] = parent_node

    return child_to_parent, violations


def build_hierarchical_labels(topic_model, clusterable_vectors, texts):
    """
    Build hierarchical cluster labels from Toponymy results.

    Returns a list of dicts with:
        - cluster: unique cluster id (layer_clusteridx format)
        - layer: layer number (0 = finest)
        - label: topic name
        - description: topic description (if available)
        - hull: list of point indices forming the convex hull
        - count: number of points in cluster
        - parent_cluster: parent cluster id (None for top layer)
        - children: list of child cluster ids
        - centroid_x, centroid_y: cluster center coordinates
        - indices: list of point indices in this cluster
    """
    from scipy.spatial import ConvexHull
    import numpy as np

    hierarchical_labels = []
    cluster_tree = topic_model.clusterer.cluster_tree_
    num_layers = len(topic_model.cluster_layers_)
    max_layer = num_layers - 1

    # Build deterministic child→parent map in one pass
    child_to_parent, violations = _build_child_to_parent_map(cluster_tree, num_layers)
    if violations:
        print(f"WARNING: {len(violations)} hierarchy violations found:")
        for v in violations:
            print(f"  - {v}")

    # Collect all valid node keys so we can detect orphans
    valid_nodes = set()

    # Process each layer
    for layer_idx, layer in enumerate(topic_model.cluster_layers_):
        topic_names = topic_model.topic_names_[layer_idx]
        cluster_labels = layer.cluster_labels

        # Get unique clusters in this layer
        unique_clusters = np.unique(cluster_labels[cluster_labels >= 0])

        for cluster_idx in unique_clusters:
            # Get point indices for this cluster
            point_mask = cluster_labels == cluster_idx
            indices = np.where(point_mask)[0].tolist()

            if len(indices) == 0:
                continue

            node_key = (layer_idx, int(cluster_idx))
            valid_nodes.add(node_key)

            # Get cluster points for hull and centroid
            cluster_points = clusterable_vectors[point_mask]

            # Compute centroid
            centroid_x = float(np.mean(cluster_points[:, 0]))
            centroid_y = float(np.mean(cluster_points[:, 1]))

            # Compute convex hull
            hull_indices = []
            if len(cluster_points) >= 3:
                try:
                    hull = ConvexHull(cluster_points)
                    # Convert hull vertices to original point indices
                    hull_indices = [indices[v] for v in hull.vertices]
                except Exception:
                    # Fall back to all points if hull fails
                    hull_indices = indices[:min(10, len(indices))]
            else:
                hull_indices = indices

            # Get topic name
            label = topic_names[cluster_idx] if cluster_idx < len(topic_names) else f"Topic {cluster_idx}"

            # Get topic specificity if available (from audit relabel pass)
            topic_specificity = None
            if hasattr(layer, "topic_specificities") and layer.topic_specificities:
                topic_specificity = layer.topic_specificities.get(int(cluster_idx))

            # Build cluster id
            cluster_id = f"{layer_idx}_{cluster_idx}"

            # Find parent using pre-built map (deterministic, O(1))
            parent_cluster = None
            if layer_idx < max_layer:
                parent_node = child_to_parent.get(node_key)
                if parent_node is not None:
                    parent_cluster = f"{parent_node[0]}_{parent_node[1]}"
                else:
                    print(f"WARNING: orphan node {cluster_id} (layer {layer_idx}) has no parent")

            # Find children clusters
            children = []
            if node_key in cluster_tree:
                for child_layer, child_idx in cluster_tree[node_key]:
                    children.append(f"{child_layer}_{child_idx}")

            hierarchical_labels.append({
                "cluster": cluster_id,
                "layer": layer_idx,
                "label": label,
                "description": "",
                "hull": hull_indices,
                "count": len(indices),
                "parent_cluster": parent_cluster,
                "children": children,
                "centroid_x": centroid_x,
                "centroid_y": centroid_y,
                "indices": indices,
                "topic_specificity": topic_specificity,
            })

    # Post-validation: check all parent refs point to valid nodes
    cluster_lookup = {entry["cluster"]: entry for entry in hierarchical_labels}
    for entry in hierarchical_labels:
        parent = entry["parent_cluster"]
        if parent is not None and parent not in cluster_lookup:
            print(f"WARNING: {entry['cluster']} references parent {parent} which is not in output")
            entry["parent_cluster"] = None  # Fix dangling ref

    return hierarchical_labels


def generate_output_id(dataset_path):
    """Generate the next cluster labels id."""
    import re
    clusters_dir = os.path.join(dataset_path, "clusters")

    # Find existing toponymy labels
    existing = [f for f in os.listdir(clusters_dir)
                if re.match(r"toponymy-\d+\.json", f)]

    if existing:
        last_num = max(int(f.split("-")[1].split(".")[0]) for f in existing)
        next_num = last_num + 1
    else:
        next_num = 1

    return f"toponymy-{next_num:03d}"


def save_hierarchical_labels(
    dataset_path,
    output_id,
    hierarchical_labels,
    topic_model,
    scope_meta,
    llm_provider=None,
    llm_model=None,
    min_clusters=None,
    base_min_cluster_size=None,
    audit_info=None,
):
    """Save hierarchical labels to parquet and JSON files."""
    clusters_dir = os.path.join(dataset_path, "clusters")

    # Create DataFrame
    df = pd.DataFrame(hierarchical_labels)

    # Save parquet
    parquet_path = os.path.join(clusters_dir, f"{output_id}.parquet")
    df.to_parquet(parquet_path)

    # Save metadata
    meta = {
        "id": output_id,
        "type": "toponymy",
        "ls_version": __version__,
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "scope_id": scope_meta["id"],
        "embedding_id": scope_meta["embedding_id"],
        "umap_id": scope_meta["umap_id"],
        "cluster_id": scope_meta.get("cluster_id"),
        "llm_provider": llm_provider,
        "llm_model": llm_model,
        "min_clusters": min_clusters,
        "base_min_cluster_size": base_min_cluster_size,
        "num_layers": len(topic_model.topic_names_),
        "num_clusters": len(hierarchical_labels),
        "layer_counts": [len(names) for names in topic_model.topic_names_],
    }
    if audit_info:
        meta["audit"] = audit_info

    json_path = os.path.join(clusters_dir, f"{output_id}.json")
    with open(json_path, "w") as f:
        json.dump(meta, f, indent=2)


if __name__ == "__main__":
    main()
