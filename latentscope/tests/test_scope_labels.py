import numpy as np
import pandas as pd

from latentscope.pipeline.stages.scope_labels import build_cluster_labels_lookup


def test_build_cluster_labels_lookup_flat_drops_indices_and_sets_cluster() -> None:
    df = pd.DataFrame(
        {
            "label": ["A", "B"],
            "hull": [np.array([[0, 0], [1, 0]]), np.array([[0, 1], [1, 1]])],
            "indices": [[0, 1], [2, 3]],
        }
    )

    lookup, unknown = build_cluster_labels_lookup(
        cluster_labels_df=df,
        hierarchical=False,
        umap_row_count=0,
    )
    assert unknown == 0
    clusters = {row["cluster"] for row in lookup}
    assert clusters == {0, 1}
    assert all("indices" not in row for row in lookup)
    assert isinstance(lookup[0]["hull"], list)


def test_build_cluster_labels_lookup_hierarchical_adds_unknown_and_converts_lists() -> None:
    df = pd.DataFrame(
        {
            "cluster": ["0_0", "0_1"],
            "layer": [0, 0],
            "label": ["Foo", "Bar"],
            "description": ["", ""],
            "hull": [np.array([[0, 0], [1, 0]]), np.array([[0, 1], [1, 1]])],
            "count": [2, 1],
            "parent_cluster": [None, None],
            "children": [np.array([], dtype=int), np.array([], dtype=int)],
            "centroid_x": [0.0, 0.0],
            "centroid_y": [0.0, 0.0],
            "indices": [[0, 1], [2]],
        }
    )

    lookup, unknown = build_cluster_labels_lookup(
        cluster_labels_df=df,
        hierarchical=True,
        umap_row_count=5,
    )
    assert unknown == 2
    unknown_rows = [row for row in lookup if row.get("cluster") == "unknown"]
    assert len(unknown_rows) == 1
    assert unknown_rows[0]["count"] == 2
    assert all("indices" not in row for row in lookup)
    assert isinstance(lookup[0]["hull"], list)
    assert isinstance(lookup[0]["children"], list)

