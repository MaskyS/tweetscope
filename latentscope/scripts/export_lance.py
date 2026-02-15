"""Export a scope to LanceDB (local and optionally cloud)."""

import json
import os


def export_lance(directory, dataset, scope_id, metric="cosine", partitions=None, cloud=False):
    import lancedb
    import pandas as pd
    import h5py
    import numpy as np

    dataset_path = os.path.join(directory, dataset)
    print(f"Exporting scope {scope_id} to LanceDB database in {dataset_path}")

    # Validate directory
    if not os.path.isdir(directory):
        print(f"Error: {directory} is not a valid directory")
        return

    # Load the scope
    scope_path = os.path.join(dataset_path, "scopes")

    print(f"Loading scope from {scope_path}")
    scope_df = pd.read_parquet(os.path.join(scope_path, f"{scope_id}-input.parquet"))
    scope_meta = json.load(open(os.path.join(scope_path, f"{scope_id}.json")))

    print(f"Loading embeddings from {dataset_path}/embeddings/{scope_meta['embedding_id']}.h5")
    embeddings = h5py.File(os.path.join(dataset_path, "embeddings", f"{scope_meta['embedding_id']}.h5"), "r")

    print(f"Converting embeddings to numpy arrays", embeddings['embeddings'].shape)
    scope_df["vector"] = [np.array(row) for row in embeddings['embeddings']]

    if "sae_id" in scope_meta and scope_meta["sae_id"]:
        print(f"SAE scope detected, adding metadata")
        sae_path = os.path.join(dataset_path, "saes", f"{scope_meta['sae_id']}.h5")
        with h5py.File(sae_path, 'r') as f:
            all_top_indices = np.array(f["top_indices"])
            all_top_acts = np.array(f["top_acts"])

        scope_df["sae_indices"] = [row.tolist() for row in all_top_indices]
        scope_df["sae_acts"] = [row.tolist() for row in all_top_acts]

    dim = embeddings['embeddings'].shape[1]
    n_rows = len(scope_df)
    if partitions is None:
        partitions = max(1, int(n_rows ** 0.5))
    sub_vectors = dim // 16

    # Use collision-proof table name from scope JSON, fall back to scope_id for old scopes
    table_name = scope_meta.get("lancedb_table_id", scope_id)
    has_sae = "sae_id" in scope_meta and scope_meta["sae_id"]

    def _create_table(db, table_name):
        print(f"Creating table '{table_name}'")
        tbl = db.create_table(table_name, scope_df, mode="overwrite")

        print(f"Creating ANN index for embeddings on table '{table_name}'")
        print(f"Partitioning into {partitions} partitions ({n_rows} rows), {sub_vectors} sub-vectors")
        tbl.create_index(num_partitions=partitions, num_sub_vectors=sub_vectors, metric=metric)

        print(f"Creating index for cluster on table '{table_name}'")
        tbl.create_scalar_index("cluster", index_type="BTREE")

        if has_sae:
            print(f"Creating index for sae_indices on table '{table_name}'")
            tbl.create_scalar_index("sae_indices", index_type="LABEL_LIST")

        print(f"Table '{table_name}' created successfully")

    # Local export
    db_uri = os.path.join(dataset_path, "lancedb")
    db = lancedb.connect(db_uri)
    _create_table(db, table_name)

    # Cloud export
    if cloud:
        cloud_uri = os.environ.get("LANCEDB_URI")
        cloud_key = os.environ.get("LANCEDB_API_KEY")
        if not cloud_uri or not cloud_key:
            raise ValueError("LANCEDB_URI and LANCEDB_API_KEY env vars required for --cloud export")
        print(f"\nSyncing to LanceDB Cloud: {cloud_uri}")
        cloud_db = lancedb.connect(cloud_uri, api_key=cloud_key)
        _create_table(cloud_db, table_name)
