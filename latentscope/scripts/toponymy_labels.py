"""
Generate hierarchical cluster labels using Toponymy.

This script takes an existing scope and generates hierarchical topic labels
using Toponymy's clustering and LLM naming capabilities.

Usage:
    python -m latentscope.scripts.toponymy_labels dataset_id scope_id \
        --llm-provider openai --llm-model gpt-4o-mini
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
    parser.add_argument('--llm-model', type=str, default='gpt-4o-mini',
                        help='LLM model name')
    parser.add_argument('--min-clusters', type=int, default=2,
                        help='Minimum number of clusters per layer')
    parser.add_argument('--base-min-cluster-size', type=int, default=10,
                        help='Minimum cluster size for finest layer')
    parser.add_argument('--output-id', type=str, default=None,
                        help='Output cluster labels id (default: auto-generated)')
    parser.add_argument('--context', type=str, default=None,
                        help='Context description for LLM (e.g., "tweets from a tech founder")')

    args = parser.parse_args()
    run_toponymy_labeling(**vars(args))


def run_toponymy_labeling(
    dataset_id: str,
    scope_id: str,
    llm_provider: str = "openai",
    llm_model: str = "gpt-4o-mini",
    min_clusters: int = 2,
    base_min_cluster_size: int = 10,
    output_id: str = None,
    context: str = None,
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
    """
    from toponymy import Toponymy, ToponymyClusterer
    from sentence_transformers import SentenceTransformer

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

    # Load UMAP coordinates
    print(f"Loading UMAP coordinates from {umap_id}...")
    umap_df = pd.read_parquet(os.path.join(dataset_path, "umaps", f"{umap_id}.parquet"))
    clusterable_vectors = umap_df[["x", "y"]].values
    print(f"  Loaded UMAP coords: {clusterable_vectors.shape}")

    # Configure LLM wrapper
    print(f"Configuring LLM: {llm_provider}/{llm_model}")
    llm = get_llm_wrapper(llm_provider, llm_model)

    # Configure clusterer
    print(f"Configuring ToponymyClusterer (min_clusters={min_clusters}, base_min_cluster_size={base_min_cluster_size})")
    clusterer = ToponymyClusterer(
        min_clusters=min_clusters,
        base_min_cluster_size=base_min_cluster_size,
        verbose=True
    )

    # Load text embedding model for keyphrase extraction
    print("Loading sentence transformer for keyphrase extraction...")
    text_embedder = SentenceTransformer("intfloat/e5-small-v2")

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
    topic_model.fit(texts, embedding_vectors, clusterable_vectors)

    # Extract hierarchical structure
    print("\nExtracting hierarchical cluster structure...")
    hierarchical_labels = build_hierarchical_labels(
        topic_model,
        clusterable_vectors,
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
        scope_meta
    )

    print(f"\nSaved hierarchical labels to: clusters/{output_id}.parquet")
    print(f"Metadata saved to: clusters/{output_id}.json")

    return output_id


def get_llm_wrapper(provider: str, model: str):
    """Get the appropriate LLM wrapper based on provider."""
    # Google uses GOOGLE_API_KEY not GOOGLE_API_KEY
    env_key = "GOOGLE_API_KEY" if provider == "google" else f"{provider.upper()}_API_KEY"
    api_key = os.environ.get(env_key)

    if not api_key:
        raise ValueError(f"{env_key} environment variable is required")

    if provider == "openai":
        from toponymy.llm_wrappers import OpenAINamer
        return OpenAINamer(api_key=api_key, model=model)
    elif provider == "anthropic":
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

            # Build cluster id
            cluster_id = f"{layer_idx}_{cluster_idx}"

            # Find parent cluster
            parent_cluster = None
            if layer_idx < len(topic_model.cluster_layers_) - 1:
                # Look for parent in cluster tree
                for parent_node, children in cluster_tree.items():
                    if (layer_idx, cluster_idx) in children:
                        parent_layer, parent_idx = parent_node
                        parent_cluster = f"{parent_layer}_{parent_idx}"
                        break

            # Find children clusters
            children = []
            node_key = (layer_idx, cluster_idx)
            if node_key in cluster_tree:
                for child_layer, child_idx in cluster_tree[node_key]:
                    children.append(f"{child_layer}_{child_idx}")

            hierarchical_labels.append({
                "cluster": cluster_id,
                "layer": layer_idx,
                "label": label,
                "description": "",  # Could be enhanced with LLM descriptions
                "hull": hull_indices,
                "count": len(indices),
                "parent_cluster": parent_cluster,
                "children": children,
                "centroid_x": centroid_x,
                "centroid_y": centroid_y,
                "indices": indices,
            })

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


def save_hierarchical_labels(dataset_path, output_id, hierarchical_labels, topic_model, scope_meta):
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
        "num_layers": len(topic_model.topic_names_),
        "num_clusters": len(hierarchical_labels),
        "layer_counts": [len(names) for names in topic_model.topic_names_],
    }

    json_path = os.path.join(clusters_dir, f"{output_id}.json")
    with open(json_path, "w") as f:
        json.dump(meta, f, indent=2)


if __name__ == "__main__":
    main()
