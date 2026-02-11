import os
import re
import json
import uuid
import argparse
from datetime import datetime
from latentscope.util import get_data_dir
from latentscope import __version__


# Canonical columns for the serving parquet (-input.parquet).
# Columns not present in input.parquet are silently skipped.
SERVING_COLUMNS = [
    # Identity
    "id", "ls_index",
    # Plot
    "x", "y", "cluster", "raw_cluster", "label", "deleted", "tile_index_64", "tile_index_128",
    # Core row
    "text", "created_at", "username", "display_name", "tweet_type",
    # Engagement / filter
    "favorites", "retweets", "replies", "is_reply", "is_retweet", "is_like",
    # Media / link support
    "urls_json", "media_urls_json",
    # Provenance
    "archive_source",
]

# ---------------------------------------------------------------------------
# Schema-drift hardening: contract-based type normalisation & validation
# ---------------------------------------------------------------------------
import numpy as np
import pandas as pd

_CONTRACT_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "contracts", "scope_input.schema.json",
)

def load_contract(contract_path=None):
    """Load the scope-input contract from the canonical JSON file."""
    path = contract_path or _CONTRACT_PATH
    with open(path) as f:
        return json.load(f)

def _coerce_bool(s):
    return s.map(
        lambda v: (
            v
            if isinstance(v, (bool, np.bool_))
            else (
                str(v).strip().lower() in {"1", "true", "t", "yes", "y"}
                if isinstance(v, str)
                else bool(v)
            )
        )
    )

# Type casters that do NOT fill nulls — fillna is handled by normalize_serving_types
# based on nullable/default semantics from the contract.
_TYPE_CASTERS = {
    "string":      lambda s: s.astype(str).where(s.notna(), other=None),
    "int":         lambda s: pd.to_numeric(s, errors="coerce"),
    "float":       lambda s: pd.to_numeric(s, errors="coerce").astype(np.float32),
    "bool":        _coerce_bool,
    "json_string": lambda s: s.astype(str).where(s.notna(), other=None),
}

# Defaults for non-nullable columns (must not contain nulls after normalization)
_NON_NULLABLE_DEFAULTS = {
    "string": "",
    "int": 0,
    "float": 0.0,
    "bool": False,
    "json_string": "[]",
}

def normalize_serving_types(df, contract):
    """Cast each column in *df* to its contract-declared type (in-place).

    Respects nullable/default semantics from the contract:
    - nullable=false: fillna with type default (empty string, 0, False, "[]")
    - nullable=true + default specified: fillna with contract default
    - nullable=true + no default: preserve nulls
    """
    all_columns = {**contract["required_columns"], **contract.get("optional_columns", {})}
    for col, spec in all_columns.items():
        if col not in df.columns:
            continue
        col_type = spec["type"]
        nullable = spec.get("nullable", False)
        default = spec.get("default")

        # Step 1: cast to correct type (preserves nulls)
        caster = _TYPE_CASTERS.get(col_type)
        if caster:
            df[col] = caster(df[col])

        # Step 2: fill nulls based on nullable/default semantics
        if not nullable:
            fill_value = _NON_NULLABLE_DEFAULTS.get(col_type, "")
            df[col] = df[col].fillna(fill_value)
        elif default is not None:
            df[col] = df[col].fillna(default)
        # else: nullable=true, no default → preserve nulls

        # Step 3: final dtype enforcement for non-nullable columns
        if not nullable:
            if col_type == "int":
                df[col] = df[col].astype(np.int64)
            elif col_type == "bool":
                df[col] = df[col].astype(bool)
            elif col_type in ("string", "json_string"):
                df[col] = df[col].astype(str)
    return df

def validate_scope_input_df(df, contract):
    """Raise ValueError if *df* violates the scope-input contract."""
    version = contract.get("version", "unknown")
    required = contract.get("required_columns", {})
    errors = []

    # Required columns must exist
    missing = [c for c in required if c not in df.columns]
    if missing:
        errors.append(f"Missing required columns: {missing}")

    # id must be string dtype
    if "id" in df.columns and not pd.api.types.is_string_dtype(df["id"]):
        errors.append(f"Column 'id' must be string, got {df['id'].dtype}")

    # No duplicate column names
    dupes = df.columns[df.columns.duplicated()].tolist()
    if dupes:
        errors.append(f"Duplicate column names: {dupes}")

    # Type and nullability checks on present columns
    all_columns = {**required, **contract.get("optional_columns", {})}
    for col, spec in all_columns.items():
        if col not in df.columns:
            continue
        t = spec["type"]
        nullable = spec.get("nullable", False)

        # Type check
        if t == "string" and not pd.api.types.is_string_dtype(df[col]):
            errors.append(f"Column '{col}' expected string, got {df[col].dtype}")
        elif t == "int" and not pd.api.types.is_integer_dtype(df[col]):
            # Nullable int columns may be float64 (pandas stores nullable ints as float)
            if not (nullable and pd.api.types.is_float_dtype(df[col])):
                errors.append(f"Column '{col}' expected int, got {df[col].dtype}")
        elif t == "float" and not pd.api.types.is_float_dtype(df[col]):
            errors.append(f"Column '{col}' expected float, got {df[col].dtype}")
        elif t == "bool" and not pd.api.types.is_bool_dtype(df[col]):
            # Nullable bool columns may be object dtype
            if not (nullable and df[col].dtype == object):
                errors.append(f"Column '{col}' expected bool, got {df[col].dtype}")

        # Nullability check: non-nullable columns must not contain nulls
        if not nullable and df[col].isna().any():
            null_count = df[col].isna().sum()
            errors.append(f"Column '{col}' is non-nullable but has {null_count} null values")

    if errors:
        raise ValueError(
            f"Scope-input contract violation (version: {version}):\n"
            + "\n".join(f"  - {e}" for e in errors)
        )

def main():
    parser = argparse.ArgumentParser(description='Setup a scope')
    parser.add_argument('dataset_id', type=str, help='Dataset id (directory name in data folder)')
    parser.add_argument('embedding_id', type=str, help='Embedding id')
    parser.add_argument('umap_id', type=str, help='UMAP id')
    parser.add_argument('cluster_id', type=str, help='Cluster id')
    parser.add_argument('cluster_labels_id', type=str, help='Cluster labels id')
    parser.add_argument('label', type=str, help='Label for the scope')
    parser.add_argument('description', type=str, help='Description of the scope')
    parser.add_argument('--scope_id', type=str, help='Scope id to overwrite existing scope', default=None)
    parser.add_argument('--sae_id', type=str, help='SAE id', default=None)

    args = parser.parse_args()
    scope(**vars(args))



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
        if table_name in db.table_names():
            db.drop_table(table_name)
            print(f"Existing table '{table_name}' has been removed.")

        print(f"Creating table '{table_name}'")
        tbl = db.create_table(table_name, scope_df)

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

def scope(dataset_id, embedding_id, umap_id, cluster_id, cluster_labels_id, label, description, scope_id=None, sae_id=None):
    DATA_DIR = get_data_dir()
    print("DATA DIR", DATA_DIR)
    directory = os.path.join(DATA_DIR, dataset_id, "scopes")

    def get_next_scopes_number(dataset):
        # figure out the latest scope number
        scopes_files = [f for f in os.listdir(directory) if re.match(r"scopes-\d+\.json", f)]
        if len(scopes_files) > 0:
            last_scopes = sorted(scopes_files)[-1]
            last_scopes_number = int(last_scopes.split("-")[1].split(".")[0])
            next_scopes_number = last_scopes_number + 1
        else:
            next_scopes_number = 1
        return next_scopes_number

    next_scopes_number = get_next_scopes_number(dataset_id)
    # make the umap name from the number, zero padded to 3 digits
    if not scope_id:
        id = f"scopes-{next_scopes_number:03d}"
    else:
        id = scope_id

    print("RUNNING:", id)

    import pandas as pd

    scope = {
        "ls_version": __version__,
        "id": id,
        "embedding_id": embedding_id,
        "umap_id": umap_id,
        "cluster_id": cluster_id,
        "cluster_labels_id": cluster_labels_id,
        "label": label,
        "description": description
    }
    if(sae_id):
        scope["sae_id"] = sae_id

    # Collision-proof LanceDB table naming: {dataset_id}__{scope_uid}
    scope_uid = str(uuid.uuid4())
    lancedb_table_id = f"{dataset_id}__{scope_uid}"
    scope["scope_uid"] = scope_uid
    scope["lancedb_table_id"] = lancedb_table_id

    # read each json file and add its contents to the scope file
    dataset_file = os.path.join(DATA_DIR, dataset_id, "meta.json")
    with open(dataset_file) as f:
        dataset = json.load(f)
        scope["dataset"] = dataset

    embedding_file = os.path.join(DATA_DIR, dataset_id, "embeddings", embedding_id + ".json")
    with open(embedding_file) as f:
        embedding = json.load(f)
        # Remove min_values and max_values from embedding data
        embedding.pop('min_values', None)
        embedding.pop('max_values', None)
        scope["embedding"] = embedding

    if sae_id:
        sae_file = os.path.join(DATA_DIR, dataset_id, "saes", sae_id + ".json")
        with open(sae_file) as f:
            sae = json.load(f)
            scope["sae"] = sae

    umap_file = os.path.join(DATA_DIR, dataset_id, "umaps", umap_id + ".json")
    with open(umap_file) as f:
        umap = json.load(f)
        scope["umap"] = umap
    
    cluster_file = os.path.join(DATA_DIR, dataset_id, "clusters", cluster_id + ".json")
    with open(cluster_file) as f:
        cluster = json.load(f)
        scope["cluster"] = cluster
    
    if cluster_labels_id == "default":
        cluster_labels_id = cluster_id + "-labels-default"
        scope["cluster_labels"] = {"id": cluster_labels_id, "cluster_id": cluster_id}
    else:
        cluster_labels_file = os.path.join(DATA_DIR, dataset_id, "clusters", cluster_labels_id + ".json")
        with open(cluster_labels_file) as f:
            cluster_labels = json.load(f)
            scope["cluster_labels"] = cluster_labels

    # load the actual labels and save everything but the indices in a dict
    cluster_labels_df = pd.read_parquet(os.path.join(DATA_DIR, dataset_id, "clusters", cluster_labels_id + ".parquet"))

    # Check if this is a hierarchical (Toponymy) cluster labels file
    is_hierarchical = "layer" in cluster_labels_df.columns

    if is_hierarchical:
        # Hierarchical labels from Toponymy
        # Keep: cluster, layer, label, description, hull, count, parent_cluster, children, centroid_x, centroid_y
        # Drop: indices (too large for JSON) after computing unknown count.
        full_hierarchical_labels_df = cluster_labels_df.copy()

        # Count how many rows are NOT assigned to any layer-0 cluster
        # so the unknown cluster has an accurate count.
        assigned_indices = set()
        if "indices" in full_hierarchical_labels_df.columns:
            layer0_labels = full_hierarchical_labels_df[full_hierarchical_labels_df["layer"] == 0]
            for indices in layer0_labels["indices"]:
                if indices is None:
                    continue
                if hasattr(indices, "tolist"):
                    indices = indices.tolist()
                assigned_indices.update(indices)

        # Total rows from the cluster parquet (read below at line ~272)
        # We use umap row count as proxy since it matches input length.
        umap_row_count = len(
            pd.read_parquet(os.path.join(DATA_DIR, dataset_id, "umaps", umap_id + ".parquet"))
        )
        unknown_count = max(0, umap_row_count - len(assigned_indices))

        cluster_labels_df = full_hierarchical_labels_df.drop(
            columns=[col for col in ["indices"] if col in full_hierarchical_labels_df.columns]
        )

        # Convert hull to list if it's a numpy array
        if "hull" in cluster_labels_df.columns:
            cluster_labels_df["hull"] = cluster_labels_df["hull"].apply(
                lambda x: x.tolist() if hasattr(x, 'tolist') else x
            )

        # Convert children to list if it's a numpy array
        if "children" in cluster_labels_df.columns:
            cluster_labels_df["children"] = cluster_labels_df["children"].apply(
                lambda x: x.tolist() if hasattr(x, 'tolist') else x
            )

        cluster_labels_list = cluster_labels_df.to_dict(orient="records")

        # Add an "unknown" cluster for unclustered points
        cluster_labels_list.append({
            "cluster": "unknown",
            "layer": 0,
            "label": "Unclustered",
            "description": "Points not assigned to any cluster",
            "hull": [],
            "count": unknown_count,
            "parent_cluster": None,
            "children": [],
            "centroid_x": 0,
            "centroid_y": 0
        })
        scope["cluster_labels_lookup"] = cluster_labels_list
        scope["hierarchical_labels"] = True
        scope["unknown_count"] = unknown_count
    else:
        # Standard (flat) cluster labels
        cluster_labels_df = cluster_labels_df.drop(columns=[col for col in ["indices", "labeled", "label_raw"] if col in cluster_labels_df.columns])
        # change hulls to a list of lists
        cluster_labels_df["hull"] = cluster_labels_df["hull"].apply(lambda x: x.tolist())
        cluster_labels_df["cluster"] = cluster_labels_df.index
        scope["cluster_labels_lookup"] = cluster_labels_df.to_dict(orient="records")
        scope["hierarchical_labels"] = False
    
    # create a scope parquet by combining the parquets from umap and cluster, as well as getting the labels from cluster_labels
    # then write the parquet to the scopes directory
    umap_df = pd.read_parquet(os.path.join(DATA_DIR, dataset_id, "umaps", umap_id + ".parquet"))
    print("umap columns", umap_df.columns)

    # TODO: make this a shared function with umapper.py
    # or maybe we don't need it in UMAP.py at all?
    def make_tiles(x, y, num_tiles=64):
        import numpy as np
        tile_size = 2.0 / num_tiles  # Size of each tile (-1 to 1 = range of 2)
        
        # Calculate row and column indices (0-63) for each point
        col_indices = np.floor((x + 1) / tile_size).astype(int)
        row_indices = np.floor((y + 1) / tile_size).astype(int)
        
        # Clip indices to valid range in case of numerical edge cases
        col_indices = np.clip(col_indices, 0, num_tiles - 1)
        row_indices = np.clip(row_indices, 0, num_tiles - 1)
        
        # Convert 2D grid indices to 1D tile index (row * num_cols + col)
        tile_indices = row_indices * num_tiles + col_indices
        return tile_indices

    # umap_df['tile_index_32'] = make_tiles(umap_df['x'], umap_df['y'], 32)
    umap_df['tile_index_64'] = make_tiles(umap_df['x'], umap_df['y'], 64)
    umap_df['tile_index_128'] = make_tiles(umap_df['x'], umap_df['y'], 128)

    cluster_df = pd.read_parquet(os.path.join(DATA_DIR, dataset_id, "clusters", cluster_id + ".parquet"))
    cluster_labels_df = pd.read_parquet(os.path.join(DATA_DIR, dataset_id, "clusters", cluster_labels_id + ".parquet"))
    # create a column where we lookup the label from cluster_labels_df for the index found in the cluster_df
    if is_hierarchical:
        # For hierarchical labels, use layer 0 (finest) clusters
        # Build mapping from point index to toponymy cluster ID using 'indices' field
        layer0_labels = cluster_labels_df[cluster_labels_df["layer"] == 0].copy()

        # Create mapping: point_index -> cluster_id (e.g., "0_0")
        point_to_cluster = {}
        point_to_label = {}
        for _, row in layer0_labels.iterrows():
            cluster_id_str = row["cluster"]
            label = row["label"]
            indices = row["indices"]
            for idx in indices:
                point_to_cluster[idx] = cluster_id_str
                point_to_label[idx] = label

        # Replace cluster column with toponymy cluster IDs
        cluster_df["cluster"] = cluster_df.index.map(point_to_cluster).fillna("unknown")
        cluster_df["label"] = cluster_df.index.map(point_to_label).fillna("Unknown")
    else:
        cluster_df["label"] = cluster_df["cluster"].apply(lambda x: cluster_labels_df.loc[x]["label"])
    print("cluster columns", cluster_df.columns)
    scope_parquet = pd.concat([umap_df, cluster_df], axis=1)
    # TODO: add the max activated feature to the scope_parquet
    # or all the sparse features? top 10?

    print("scope_id", scope_id)
    # create a column to indicate if the row has been deleted in the scope
    scope_parquet["deleted"] = False
    if scope_id is not None:
        # read the transactions file
        transactions_file_path = os.path.join(DATA_DIR, dataset_id, "scopes", scope_id + "-transactions.json")
        with open(transactions_file_path) as f:
            transactions = json.load(f)
            for transaction in transactions:
                if transaction["action"] == "delete_rows":
                    scope_parquet.loc[transaction["payload"]["row_ids"], "deleted"] = True

    # Add an ls_index column that is the index of each row in the dataframe
    scope_parquet['ls_index'] = scope_parquet.index
    print("scope columns", scope_parquet.columns)
    scope_parquet.to_parquet(os.path.join(directory, id + ".parquet"))

    scope["rows"] = len(scope_parquet)
    scope["columns"] = scope_parquet.columns.tolist()
    scope["size"] = os.path.getsize(os.path.join(directory, id + ".parquet"))
    scope["timestamp"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    file_path = os.path.join(directory, id + ".json")
    with open(file_path, 'w') as f:
        json.dump(scope, f, indent=2)
    
    print("creating combined scope-input parquet")
    input_df = pd.read_parquet(os.path.join(DATA_DIR, dataset_id, "input.parquet"))
    # Ensure id is always string (prevents JS precision loss for large tweet IDs)
    if "id" in input_df.columns:
        input_df["id"] = input_df["id"].astype(str)
    input_df.reset_index(inplace=True)
    input_df = input_df[input_df['index'].isin(scope_parquet['ls_index'])]
    combined_df = input_df.join(scope_parquet.set_index('ls_index'), on='index', rsuffix='_ls')
    # ls_index is consumed as the join key; restore it from the 'index' column
    combined_df['ls_index'] = combined_df['index']
    # Select only canonical serving columns (skip any not present in this dataset)
    available = [c for c in SERVING_COLUMNS if c in combined_df.columns]
    combined_df = combined_df[available]

    # Schema-drift hardening: normalize types and validate before write
    contract = load_contract()
    combined_df = normalize_serving_types(combined_df, contract)
    validate_scope_input_df(combined_df, contract)

    combined_df.to_parquet(os.path.join(directory, id + "-input.parquet"))

    print("exporting to lancedb")
    export_lance(DATA_DIR, dataset_id, id)

    print("wrote scope", id)
