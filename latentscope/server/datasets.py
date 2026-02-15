import os
import re
import json
import fnmatch
from collections import defaultdict
import pandas as pd
from flask import Blueprint, jsonify, request

# Create a Blueprint
datasets_bp = Blueprint('datasets_bp', __name__)
datasets_write_bp = Blueprint('datasets_write_bp', __name__)
DATA_DIR = os.getenv('LATENT_SCOPE_DATA')


def _links_dir(dataset: str) -> str:
    return os.path.join(DATA_DIR, dataset, "links")


def _links_meta_path(dataset: str) -> str:
    return os.path.join(_links_dir(dataset), "meta.json")


def _links_edges_path(dataset: str) -> str:
    return os.path.join(_links_dir(dataset), "edges.parquet")


def _links_node_stats_path(dataset: str) -> str:
    return os.path.join(_links_dir(dataset), "node_link_stats.parquet")


def _load_links_edges_df(dataset: str) -> pd.DataFrame:
    path = _links_edges_path(dataset)
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    return pd.read_parquet(path)


def _load_links_node_stats_df(dataset: str) -> pd.DataFrame:
    path = _links_node_stats_path(dataset)
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    return pd.read_parquet(path)


def _parse_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "f", "no", "n", "off"}:
        return False
    return default


def _to_int_or_none(value):
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _edge_row_to_json(row):
    return {
        "edge_id": row.edge_id,
        "edge_kind": row.edge_kind,
        "src_tweet_id": row.src_tweet_id,
        "dst_tweet_id": row.dst_tweet_id,
        "src_ls_index": _to_int_or_none(row.src_ls_index),
        "dst_ls_index": _to_int_or_none(row.dst_ls_index),
        "internal_target": bool(row.internal_target),
        "provenance": row.provenance,
        "source_url": row.source_url,
    }

"""
Get the essential metadata for all available datasets.
Essential metadata is stored in meta.json
"""
@datasets_bp.route('/', methods=['GET'])
def get_datasets():
    datasets = []

    for dir in os.listdir(DATA_DIR):
        file_path = os.path.join(DATA_DIR, dir, 'meta.json')
        if os.path.isfile(file_path):
            with open(file_path, 'r', encoding='utf-8') as file:
                try:
                    jsonData = json.load(file)
                    jsonData['id'] = dir
                    datasets.append(jsonData)
                except:
                    print("Error reading meta.json", file_path)

    datasets.sort(key=lambda x: x.get('id'))
    return jsonify(datasets)

"""
Get all metadata files from the given a directory.
"""
def scan_for_json_files(directory_path, match_pattern=r".*\.json$"):
    try:
        # files = os.listdir(directory_path)
        files = sorted(os.listdir(directory_path), key=lambda x: os.path.getmtime(os.path.join(directory_path, x)), reverse=True)
    except OSError as err:
        print('Unable to scan directory:', err)
        return jsonify({"error": "Unable to scan directory"}), 500

    json_files = [file for file in files if re.match(match_pattern, file)]
    # print("files", files)
    # print("json", json_files)

    json_contents = []
    for file in json_files:
        try:
            with open(os.path.join(directory_path, file), 'r', encoding='utf-8') as json_file:
                json_contents.append(json.load(json_file))
        except json.JSONDecodeError as err:
            print('Error parsing JSON string:', err)
    return jsonify(json_contents)

@datasets_bp.route('/<dataset>/meta', methods=['GET'])
def get_dataset_meta(dataset):
    file_path = os.path.join(DATA_DIR, dataset, "meta.json")
    with open(file_path, 'r', encoding='utf-8') as json_file:
        json_contents = json.load(json_file)
    return jsonify(json_contents)

@datasets_write_bp.route('/<dataset>/meta/update', methods=['GET'])
def update_dataset_meta(dataset):
    key = request.args.get('key')
    value = request.args.get('value')
    try:
        value = json.loads(value)
    except json.JSONDecodeError as err:
        print("Invalid JSON format for value", value, err)

    file_path = os.path.join(DATA_DIR, dataset, "meta.json")
    with open(file_path, 'r', encoding='utf-8') as json_file:
        json_contents = json.load(json_file)
    json_contents[key] = value
    # write the file back out
    with open(file_path, 'w', encoding='utf-8') as json_file:
        json.dump(json_contents, json_file)
    return jsonify(json_contents)


@datasets_bp.route('/<dataset>/links/meta', methods=['GET'])
def get_dataset_links_meta(dataset):
    meta_path = _links_meta_path(dataset)
    if not os.path.exists(meta_path):
        return jsonify({"error": "Links graph not found for dataset"}), 404

    with open(meta_path, 'r', encoding='utf-8') as f:
        meta = json.load(f)
    return jsonify(meta)


@datasets_bp.route('/<dataset>/links/node-stats', methods=['GET'])
def get_dataset_links_node_stats(dataset):
    try:
        df = _load_links_node_stats_df(dataset)
    except FileNotFoundError:
        return jsonify({"error": "Node link stats not found for dataset"}), 404

    # Column-oriented JSON for compact payload
    cols = [
        "ls_index", "tweet_id", "thread_root_id",
        "thread_depth", "thread_size", "reply_child_count",
        "reply_in_count", "reply_out_count",
        "quote_in_count", "quote_out_count",
    ]
    result = {}
    for col in cols:
        if col not in df.columns:
            continue
        series = df[col]
        if col in ("ls_index", "thread_depth", "thread_size", "reply_child_count",
                    "reply_in_count", "reply_out_count", "quote_in_count", "quote_out_count"):
            # Convert to int, NaN → None
            result[col] = [_to_int_or_none(v) for v in series]
        else:
            # String columns — NaN → None
            result[col] = [None if pd.isna(v) else str(v) for v in series]

    return jsonify(result)


@datasets_bp.route('/<dataset>/links/by-indices', methods=['POST'])
def get_dataset_links_by_indices(dataset):
    try:
        edges_df = _load_links_edges_df(dataset)
    except FileNotFoundError:
        return jsonify({"error": "Links graph not found for dataset"}), 404

    payload = request.get_json(silent=True) or {}
    raw_indices = payload.get("indices", [])
    edge_kinds = payload.get("edge_kinds", ["reply", "quote"])
    include_external = _parse_bool(payload.get("include_external"), default=False)
    max_edges = payload.get("max_edges", 5000)

    try:
        max_edges = int(max_edges)
    except (TypeError, ValueError):
        max_edges = 5000
    if max_edges < 1:
        max_edges = 1

    if not isinstance(edge_kinds, list):
        edge_kinds = [edge_kinds] if edge_kinds else []
    edge_kinds = [str(ek).strip().lower() for ek in edge_kinds if str(ek).strip()]
    if edge_kinds:
        edges_df = edges_df[edges_df["edge_kind"].isin(edge_kinds)]

    if raw_indices is None:
        raw_indices = []
    if not isinstance(raw_indices, list):
        raw_indices = [raw_indices]

    index_values = []
    for value in raw_indices:
        try:
            index_values.append(int(value))
        except (TypeError, ValueError):
            continue

    if index_values:
        index_set = set(index_values)
        edges_df = edges_df[
            edges_df["src_ls_index"].isin(index_set) |
            edges_df["dst_ls_index"].isin(index_set)
        ]

    if not include_external:
        edges_df = edges_df[edges_df["dst_ls_index"].notna()]

    total = int(edges_df.shape[0])
    edges_df = edges_df.head(max_edges)
    rows = [_edge_row_to_json(row) for row in edges_df.itertuples(index=False)]

    return jsonify({
        "edges": rows,
        "total": total,
        "returned": len(rows),
        "truncated": total > len(rows),
    })


@datasets_bp.route('/<dataset>/links/thread/<tweet_id>', methods=['GET'])
def get_dataset_links_thread(dataset, tweet_id):
    try:
        edges_df = _load_links_edges_df(dataset)
    except FileNotFoundError:
        return jsonify({"error": "Links graph not found for dataset"}), 404

    reply_df = edges_df[edges_df["edge_kind"] == "reply"]
    if reply_df.empty:
        return jsonify({
            "tweet_id": tweet_id,
            "parent_chain": [],
            "descendants": [],
            "edges": [],
        })

    ls_by_tweet_id: dict[str, int | None] = {}
    try:
        node_stats_df = _load_links_node_stats_df(dataset)
        for row in node_stats_df.itertuples(index=False):
            ls_by_tweet_id[str(row.tweet_id)] = _to_int_or_none(row.ls_index)
    except FileNotFoundError:
        pass

    parent_by_src: dict[str, str] = {}
    children_by_dst: dict[str, list[str]] = defaultdict(list)
    for row in reply_df.itertuples(index=False):
        src_tweet_id = str(row.src_tweet_id)
        dst_tweet_id = str(row.dst_tweet_id)
        parent_by_src[src_tweet_id] = dst_tweet_id
        children_by_dst[dst_tweet_id].append(src_tweet_id)

        src_idx = _to_int_or_none(row.src_ls_index)
        dst_idx = _to_int_or_none(row.dst_ls_index)
        if src_idx is not None and src_tweet_id not in ls_by_tweet_id:
            ls_by_tweet_id[src_tweet_id] = src_idx
        if dst_idx is not None and dst_tweet_id not in ls_by_tweet_id:
            ls_by_tweet_id[dst_tweet_id] = dst_idx

    chain_limit = request.args.get("chain_limit", 300, type=int) or 300
    desc_limit = request.args.get("desc_limit", 3000, type=int) or 3000

    parent_chain: list[dict] = []
    visited_chain = {tweet_id}
    current = tweet_id
    while current in parent_by_src and len(parent_chain) < chain_limit:
        parent = parent_by_src[current]
        if parent in visited_chain:
            break
        parent_chain.append({
            "tweet_id": parent,
            "ls_index": ls_by_tweet_id.get(parent),
        })
        visited_chain.add(parent)
        current = parent

    descendants: list[dict] = []
    seen_desc: set[str] = set()
    queue = list(children_by_dst.get(tweet_id, []))
    while queue and len(descendants) < desc_limit:
        node = queue.pop(0)
        if node in seen_desc:
            continue
        seen_desc.add(node)
        descendants.append({
            "tweet_id": node,
            "ls_index": ls_by_tweet_id.get(node),
        })
        queue.extend(children_by_dst.get(node, []))

    component_nodes = {tweet_id}
    component_nodes.update(item["tweet_id"] for item in parent_chain)
    component_nodes.update(item["tweet_id"] for item in descendants)

    component_df = reply_df[
        reply_df["src_tweet_id"].astype(str).isin(component_nodes) |
        reply_df["dst_tweet_id"].astype(str).isin(component_nodes)
    ]
    component_edges = [_edge_row_to_json(row) for row in component_df.head(5000).itertuples(index=False)]

    return jsonify({
        "tweet_id": tweet_id,
        "parent_chain": parent_chain,
        "descendants": descendants,
        "edges": component_edges,
    })


@datasets_bp.route('/<dataset>/links/quotes/<tweet_id>', methods=['GET'])
def get_dataset_links_quotes(dataset, tweet_id):
    try:
        edges_df = _load_links_edges_df(dataset)
    except FileNotFoundError:
        return jsonify({"error": "Links graph not found for dataset"}), 404

    quote_df = edges_df[edges_df["edge_kind"] == "quote"]
    if quote_df.empty:
        return jsonify({
            "tweet_id": tweet_id,
            "outgoing": [],
            "incoming": [],
            "outgoing_total": 0,
            "incoming_total": 0,
        })

    limit = request.args.get("limit", 2000, type=int) or 2000
    if limit < 1:
        limit = 1

    outgoing_all = quote_df[quote_df["src_tweet_id"].astype(str) == tweet_id]
    incoming_all = quote_df[quote_df["dst_tweet_id"].astype(str) == tweet_id]

    outgoing = [_edge_row_to_json(row) for row in outgoing_all.head(limit).itertuples(index=False)]
    incoming = [_edge_row_to_json(row) for row in incoming_all.head(limit).itertuples(index=False)]

    return jsonify({
        "tweet_id": tweet_id,
        "outgoing": outgoing,
        "incoming": incoming,
        "outgoing_total": int(outgoing_all.shape[0]),
        "incoming_total": int(incoming_all.shape[0]),
        "truncated": int(outgoing_all.shape[0]) > len(outgoing) or int(incoming_all.shape[0]) > len(incoming),
    })

@datasets_bp.route('/<dataset>/embeddings', methods=['GET'])
def get_dataset_embeddings(dataset):
    directory_path = os.path.join(DATA_DIR, dataset, "embeddings")
    # directory_path = os.path.join(DATA_DIR, dataset, "umaps")
    return scan_for_json_files(directory_path)

@datasets_bp.route('/<dataset>/embeddings/<embedding>', methods=['GET'])
def get_dataset_embedding(dataset, embedding):
    file_path = os.path.join(DATA_DIR, dataset, "embeddings", embedding + ".json")
    with open(file_path, 'r', encoding='utf-8') as json_file:
        json_contents = json.load(json_file)
    return jsonify(json_contents)

@datasets_bp.route('/<dataset>/saes', methods=['GET'])
def get_dataset_saes(dataset):
    directory_path = os.path.join(DATA_DIR, dataset, "saes")
    # directory_path = os.path.join(DATA_DIR, dataset, "umaps")
    return scan_for_json_files(directory_path)

@datasets_bp.route('/<dataset>/saes/<sae>', methods=['GET'])
def get_dataset_sae(dataset, sae):
    file_path = os.path.join(DATA_DIR, dataset, "saes", sae + ".json")
    with open(file_path, 'r', encoding='utf-8') as json_file:
        json_contents = json.load(json_file)
    return jsonify(json_contents)

@datasets_bp.route('/<dataset>/features/<sae>', methods=['GET'])
def get_dataset_features(dataset, sae):
    file_path = os.path.join(DATA_DIR, dataset, "saes", sae + "_features.parquet")
    df = pd.read_parquet(file_path)
    return df.to_json(orient="records")

@datasets_bp.route('/<dataset>/umaps', methods=['GET'])
def get_dataset_umaps(dataset):
    directory_path = os.path.join(DATA_DIR, dataset, "umaps")
    return scan_for_json_files(directory_path)

@datasets_bp.route('/<dataset>/umaps/<umap>', methods=['GET'])
def get_dataset_umap(dataset, umap):
    file_path = os.path.join(DATA_DIR, dataset, "umaps", umap + ".json")
    with open(file_path, 'r', encoding='utf-8') as json_file:
        json_contents = json.load(json_file)
    return jsonify(json_contents)

@datasets_bp.route('/<dataset>/umaps/<umap>/points', methods=['GET'])
def get_dataset_umap_points(dataset, umap):
    file_path = os.path.join(DATA_DIR, dataset, "umaps", umap + ".parquet")
    df = pd.read_parquet(file_path)
    return df.to_json(orient="records")

@datasets_bp.route('/<dataset>/clusters', methods=['GET'])
def get_dataset_clusters(dataset):
    directory_path = os.path.join(DATA_DIR, dataset, "clusters")
    return scan_for_json_files(directory_path, match_pattern=r"cluster-\d+\.json")

@datasets_bp.route('/<dataset>/clusters/<cluster>', methods=['GET'])
def get_dataset_cluster(dataset, cluster):
    file_path = os.path.join(DATA_DIR, dataset, "clusters", cluster + ".json")
    with open(file_path, 'r', encoding='utf-8') as json_file:
        json_contents = json.load(json_file)
    return jsonify(json_contents)

# @datasets_bp.route('/<dataset>/clusters/<cluster>/labels', methods=['GET'])
# def get_dataset_cluster_labels_default(dataset, cluster):
#     file_name = cluster + "-labels.parquet"
#     file_path = os.path.join(DATA_DIR, dataset, "clusters", file_name)
#     df = pd.read_parquet(file_path)
#     return df.to_json(orient="records")

@datasets_bp.route('/<dataset>/clusters/<cluster>/indices', methods=['GET'])
def get_dataset_cluster_indices(dataset, cluster):
    file_name = cluster + ".parquet"
    file_path = os.path.join(DATA_DIR, dataset, "clusters", file_name)
    df = pd.read_parquet(file_path)
    return df.to_json(orient="records")

@datasets_bp.route('/<dataset>/clusters/<cluster>/labels/<id>', methods=['GET'])
def get_dataset_cluster_labels(dataset, cluster, id):
    # if model == "default":
    #     return get_dataset_cluster_labels_default(dataset, cluster)
    file_name = cluster + "-labels-" + id + ".parquet"
    file_path = os.path.join(DATA_DIR, dataset, "clusters", file_name)
    df = pd.read_parquet(file_path)
    df.reset_index(inplace=True)
    return df.to_json(orient="records")

# This was rewritten in bulk.py to only affect a scope
# @datasets_write_bp.route('/<dataset>/clusters/<cluster>/labels/<id>/label/<index>', methods=['GET'])
# def overwrite_dataset_cluster_label(dataset, cluster, id, index):
#     index = int(index)
#     new_label = request.args.get('label')
#     print("write label", index, new_label)
#     if new_label is None:
#         return jsonify({"error": "Missing 'label' in request data"}), 400

#     file_name = cluster + "-labels-" + id + ".parquet"
#     file_path = os.path.join(DATA_DIR, dataset, "clusters", file_name)
#     try:
#         df = pd.read_parquet(file_path)
#     except FileNotFoundError:
#         return jsonify({"error": "File not found"}), 404

#     if index >= len(df):
#         return jsonify({"error": "Index out of range"}), 400

#     df.at[index, 'label'] = new_label
#     df.to_parquet(file_path)

#     return jsonify({"success": True, "message": "Label updated successfully"})


@datasets_bp.route('/<dataset>/clusters/<cluster>/labels_available', methods=['GET'])
def get_dataset_cluster_labels_available(dataset, cluster):
    directory_path = os.path.join(DATA_DIR, dataset, "clusters")
    return scan_for_json_files(directory_path, match_pattern=rf"{cluster}-labels-.*\.json")
    # try:
    #     files = sorted(os.listdir(directory_path), key=lambda x: os.path.getmtime(os.path.join(directory_path, x)), reverse=True)
    # except OSError as err:
    #     print('Unable to scan directory:', err)
    #     return jsonify({"error": "Unable to scan directory"}), 500

    # pattern = re.compile(r'^' + cluster + '-labels-(.*).parquet$')
    # model_names = [pattern.match(file).group(1) for file in files if pattern.match(file)]
    # return jsonify(model_names)


def get_next_scopes_number(dataset):
    # figure out the latest scope number
    scopes_files = [f for f in os.listdir(os.path.join(DATA_DIR,dataset,"scopes")) if re.match(r"scopes-\d+\.json", f)]
    if len(scopes_files) > 0:
        last_scopes = sorted(scopes_files)[-1]
        last_scopes_number = int(last_scopes.split("-")[1].split(".")[0])
        next_scopes_number = last_scopes_number + 1
    else:
        next_scopes_number = 1
    return next_scopes_number

@datasets_bp.route('/<dataset>/scopes', methods=['GET'])
def get_dataset_scopes(dataset):
    directory_path = os.path.join(DATA_DIR, dataset, "scopes")
    print("dataset", dataset, directory_path)
    return scan_for_json_files(directory_path, match_pattern=r".*[0-9]+\.json$")

@datasets_bp.route('/<dataset>/scopes/<scope>', methods=['GET'])
def get_dataset_scope(dataset, scope):
    directory_path = os.path.join(DATA_DIR, dataset, "scopes")
    file_path = os.path.join(directory_path, scope + ".json")
    with open(file_path, 'r', encoding='utf-8') as json_file:
        json_contents = json.load(json_file)
    return jsonify(json_contents)

@datasets_bp.route('/<dataset>/scopes/<scope>/parquet', methods=['GET'])
def get_dataset_scope_parquet(dataset, scope):
    directory_path = os.path.join(DATA_DIR, dataset, "scopes")
    scope_file_path = os.path.join(directory_path, scope + ".parquet")
    scope_input_file_path = os.path.join(directory_path, scope + "-input.parquet")
    dataset_input_file_path = os.path.join(DATA_DIR, dataset, "input.parquet")

    required_columns = [
        "x",
        "y",
        "cluster",
        "label",
        "deleted",
        "ls_index",
        "tile_index_64",
        "tile_index_128",
    ]
    engagement_columns = [
        "favorites",
        "favorite_count",
        "likes",
        "like_count",
        "retweets",
        "retweet_count",
        "replies",
        "reply_count",
        "created_at",
        "tweet_type",
        "is_like",
        "is_retweet",
        "is_reply",
    ]

    # Prefer the combined scope-input parquet when available so the frontend can
    # use engagement/date metadata for visualization logic (e.g. node sizing),
    # while still returning a compact payload (no full text/body fields).
    if os.path.exists(scope_input_file_path):
        df = pd.read_parquet(scope_input_file_path)
    else:
        df = pd.read_parquet(scope_file_path)

        # Backward-compatible fallback: older scopes may not have <scope>-input.parquet.
        # In that case, enrich from dataset input.parquet so node sizing and hover
        # metadata can still use engagement + recency fields.
        if os.path.exists(dataset_input_file_path) and "ls_index" in df.columns:
            input_df = pd.read_parquet(dataset_input_file_path)

            # The canonical row id may live in the input index; normalize to ls_index.
            if "ls_index" not in input_df.columns:
                input_df = input_df.reset_index()
                if "index" in input_df.columns:
                    input_df = input_df.rename(columns={"index": "ls_index"})

            input_keep_cols = ["ls_index"] + [
                col for col in engagement_columns if col in input_df.columns
            ]

            if "ls_index" in input_df.columns and len(input_keep_cols) > 1:
                input_lookup = input_df[input_keep_cols]
                df = df.merge(input_lookup, on="ls_index", how="left", sort=False)

    # Some scope-input parquet files carry source row ids in `index` (from
    # input.parquet reset_index) instead of `ls_index`. Normalize so frontend
    # filtering/pagination can always rely on `ls_index`.
    if "ls_index" not in df.columns:
        if "index" in df.columns:
            df = df.rename(columns={"index": "ls_index"})
        else:
            # Last-resort fallback: preserve row identity within this payload.
            df = df.reset_index(drop=True)
            df["ls_index"] = df.index

    selected_columns = [col for col in required_columns + engagement_columns if col in df.columns]
    if selected_columns:
        df = df[selected_columns]

    return df.to_json(orient="records")

@datasets_write_bp.route('/<dataset>/scopes/<scope>/description', methods=['GET'])
def overwrite_scope_description(dataset, scope):
    new_label = request.args.get('label')
    new_description = request.args.get('description')

    file_name = scope + ".json"
    file_path = os.path.join(DATA_DIR, dataset, "scopes", file_name)
    with open(file_path, 'r', encoding='utf-8') as json_file:
        json_contents = json.load(json_file)

    json_contents['label'] = new_label
    json_contents['description'] = new_description

    with open(file_path, 'w', encoding='utf-8') as json_file:
        json.dump(json_contents, json_file)
    
    return jsonify({"success": True, "message": "Description updated successfully"})

@datasets_write_bp.route('/<dataset>/scopes/<scope>/new-cluster', methods=['GET'])
def new_scope_cluster(dataset, scope):
    new_label = request.args.get('label')

    file_name = scope + ".json"
    file_path = os.path.join(DATA_DIR, dataset, "scopes", file_name)
    with open(file_path, 'r', encoding='utf-8') as json_file:
        json_contents = json.load(json_file)

    clusters = json_contents.get('cluster_labels_lookup', [])
    clusterIndex = len(clusters)
    clusters.append({
        "cluster": clusterIndex, 
        "label": new_label,
        "hull": [],
        "description": ""
    })
    json_contents['cluster_labels_lookup'] = clusters

    with open(file_path, 'w', encoding='utf-8') as json_file:
        json.dump(json_contents, json_file)
    
    return jsonify({"success": True, "message": "Description updated successfully"})


@datasets_bp.route('/<dataset>/export/list', methods=['GET'])
def get_dataset_export_list(dataset):
    directory_path = os.path.join(DATA_DIR, dataset)
    print("dataset", dataset, directory_path)
    # scan the directory for files and directories
    # then walk the directories to find all the files
    # then return the list of files
    file_list = []
    for root, dirs, files in os.walk(directory_path):
        if "jobs" in root:
            continue
        for file in files:
            if file == ".DS_Store":
                continue
            if file.endswith('.lock') or file.endswith('.metadata'):
                continue
            full_path = os.path.join(root, file)
            file_name = os.path.basename(full_path)
            relative_path = os.path.relpath(full_path, directory_path)
            directory = os.path.relpath(root, directory_path)
            size = os.path.getsize(full_path)
            file_list.append((file_name, directory, relative_path, full_path, size))

    return jsonify(file_list)

@datasets_bp.route('/<dataset>/plot/<scope>/list', methods=['GET'])
def get_dataset_plot_list(dataset, scope):
    directory_path = os.path.join(DATA_DIR, dataset, "plots")
    print("dataset", dataset, directory_path)
    if not os.path.exists(directory_path):
        return jsonify([])
    # scan the directory for files and directories
    # then walk the directories to find all the files
    # then return the list of files
    file_list = []
    files = [f for f in os.listdir(directory_path) if os.path.isfile(os.path.join(directory_path, f))]
    for file in files:
        if not (file.endswith(".png") and scope in file):
            continue
        full_path = os.path.join(directory_path, file)
        file_name = os.path.basename(full_path)
        size = os.path.getsize(full_path)
        file_list.append((file_name, full_path, size))

    return jsonify(file_list)
