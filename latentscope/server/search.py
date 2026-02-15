import os
import json
import h5py
import numpy as np
from flask import Blueprint, jsonify, request
from sklearn.neighbors import NearestNeighbors

from latentscope.models import get_embedding_model

# Create a Blueprint
search_bp = Blueprint('search_bp', __name__)
DATA_DIR = os.getenv('LATENT_SCOPE_DATA')

# in memory cache of dataset metadata, embeddings, models and tokenizers
DATASETS = {}
EMBEDDINGS = {}

"""
Returns nearest neighbors for a given query string
Hard coded to 150 results currently
"""
@search_bp.route('/nn', methods=['GET'])
def nn():
    dataset = request.args.get('dataset')
    scope_id = request.args.get('scope_id')
    embedding_id = request.args.get('embedding_id')
    dimensions = request.args.get('dimensions')
    dimensions = int(dimensions) if dimensions else None
    print("dimensions", dimensions)
    # Check if this scope has a LanceDB index
    query = request.args.get('query')
    print("query", query)

    if embedding_id not in EMBEDDINGS:
        print("loading model", embedding_id)
        with open(os.path.join(DATA_DIR, dataset, "embeddings", embedding_id + ".json"), 'r') as f:
            metadata = json.load(f)
        model_id = metadata.get('model_id')
        print("Model ID:", model_id)
        model = get_embedding_model(model_id)
        model.load_model()
        EMBEDDINGS[dataset + "-" + embedding_id] = model
    else:
        model = EMBEDDINGS[dataset + "-" + embedding_id]

    # If lancedb is available, we use it to search
    if scope_id is not None:
        lance_path = os.path.join(DATA_DIR, dataset, "lancedb", scope_id + ".lance")
        if os.path.exists(lance_path):
            print(f"Found LanceDB index at {lance_path}, using vector search")
            return nn_lance(dataset, scope_id, model, query, dimensions)

    # Otherwise we use the nearest neighbors search from sklearn
    num = 150
    if dataset not in DATASETS or embedding_id not in DATASETS[dataset]:
        # load the dataset embeddings
        embedding_path = os.path.join(DATA_DIR, dataset, "embeddings", f"{embedding_id}.h5")
        with h5py.File(embedding_path, 'r') as f:
            embeddings = np.array(f["embeddings"])
        print("fitting embeddings")
        nne = NearestNeighbors(n_neighbors=num, metric="cosine")
        nne.fit(embeddings)
        if dataset not in DATASETS:
          DATASETS[dataset] = {}
        DATASETS[dataset][embedding_id] = nne
    else:
        nne = DATASETS[dataset][embedding_id]

    # embed the query string and find the nearest neighbor

    embedding = np.array(model.embed([query], dimensions=dimensions))
    distances, indices = nne.kneighbors(embedding)
    filtered_indices = indices[0]
    filtered_distances = distances[0]
    indices = filtered_indices
    distances = filtered_distances
    return jsonify(indices=indices.tolist(), distances=distances.tolist(), search_embedding=embedding.tolist())


def nn_lance(dataset, scope_id, model, query, dimensions):
    import lancedb
    db = lancedb.connect(os.path.join(DATA_DIR, dataset, "lancedb"))
    table = db.open_table(scope_id)
    embedding = model.embed([query], dimensions=dimensions)
    results = table.search(embedding).metric("cosine").select(["index"]).limit(100).to_list()
    indices = [result["index"] for result in results]
    distances = [result["_distance"] for result in results]
    return jsonify(indices=indices, distances=distances, search_embedding=embedding)
