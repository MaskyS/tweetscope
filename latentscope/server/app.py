import re
import os
import sys
import json
import math
import h5py
import logging
import argparse
import requests
import numpy as np
import pandas as pd
from importlib.resources import files
from dotenv import dotenv_values, set_key
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge

# from latentscope.util import update_data_dir
from latentscope.util import get_data_dir, get_supported_api_keys
from latentscope.__version__ import __version__


app = Flask(__name__)

app.logger.addHandler(logging.StreamHandler(sys.stderr))
app.logger.setLevel(logging.INFO)

CORS(app, resources={r"/api/*": {"origins": "*"}})

# DATA_DIR = update_data_dir(args.data_dir)
DATA_DIR = get_data_dir()
if not os.path.exists(DATA_DIR):
    os.makedirs(DATA_DIR)

def _env_int(name, default):
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default

MAX_UPLOAD_MB = _env_int("LATENT_SCOPE_MAX_UPLOAD_MB", 1024)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

# We enable a read only mode of the server
def check_read_only(s):
    if s is None:
        return False
    return s.lower() in ['true', '1', 't', 'y', 'yes']
# export LATENT_SCOPE_READ_ONLY=1
APP_MODE = os.getenv("LATENT_SCOPE_APP_MODE", "studio").strip().lower()
if APP_MODE not in {"studio", "hosted", "single_profile"}:
    APP_MODE = "studio"
PUBLIC_DATASET_ID = os.getenv("LATENT_SCOPE_PUBLIC_DATASET")
PUBLIC_SCOPE_ID = os.getenv("LATENT_SCOPE_PUBLIC_SCOPE")
READ_ONLY = check_read_only(os.getenv("LATENT_SCOPE_READ_ONLY")) or APP_MODE == "single_profile"
print("READ ONLY?", READ_ONLY)
print("APP MODE?", APP_MODE)

# in memory cache of dataframes loaded for each dataset
# used in returning rows for a given index (indexed, get_tags)
DATAFRAMES = {}

from .jobs import jobs_bp, jobs_write_bp
app.register_blueprint(jobs_bp, url_prefix='/api/jobs') 
if(not READ_ONLY):
    app.register_blueprint(jobs_write_bp, url_prefix='/api/jobs') 

from .search import search_bp
# Search endpoints (NN, SAE features, compare) are studio-only.
# In production, NN search is served by the TS API via LanceDB Cloud.
if APP_MODE == "studio":
    app.register_blueprint(search_bp, url_prefix='/api/search')

from .tags import tags_bp, tags_write_bp
app.register_blueprint(tags_bp, url_prefix='/api/tags') 
if(not READ_ONLY):
    app.register_blueprint(tags_write_bp, url_prefix='/api/tags') 

from .datasets import datasets_bp, datasets_write_bp
# Read endpoints (datasets_bp) are served by the TS API in production.
# Only register in studio mode for local dev compatibility.
if APP_MODE == "studio":
    app.register_blueprint(datasets_bp, url_prefix='/api/datasets')
if(not READ_ONLY):
    app.register_blueprint(datasets_write_bp, url_prefix='/api/datasets')

from .bulk import bulk_bp, bulk_write_bp
app.register_blueprint(bulk_bp, url_prefix='/api/bulk') 
if(not READ_ONLY):
    app.register_blueprint(bulk_write_bp, url_prefix='/api/bulk') 

from .admin import admin_bp
if not READ_ONLY:
    app.register_blueprint(admin_bp, url_prefix='/api/admin') 

from .models import models_bp, models_write_bp
app.register_blueprint(models_bp, url_prefix='/api/models')
if not READ_ONLY:
    app.register_blueprint(models_write_bp, url_prefix='/api/models')

# ===========================================================
# URL Resolution for t.co links (Twitter/X media embedding)
# Used for lazy-loading media/quotes when cards become visible
# ===========================================================

# Cache for resolved URLs to avoid repeated lookups
URL_CACHE = {}


@app.errorhandler(RequestEntityTooLarge)
def handle_large_upload(_error):
    return jsonify({"error": f"Upload too large. Limit is {MAX_UPLOAD_MB} MB."}), 413

@app.route('/api/resolve-url', methods=['POST'])
def resolve_url():
    """
    Resolve a t.co shortened URL to its final destination.
    Returns the final URL and its type (image, video, quote, external).
    """
    data = request.get_json()
    url = data.get('url')

    if not url:
        return jsonify(error="No URL provided"), 400

    # Check cache first
    if url in URL_CACHE:
        return jsonify(URL_CACHE[url])

    try:
        # Follow redirects to get final URL
        response = requests.head(url, allow_redirects=True, timeout=5)
        final_url = response.url

        # Determine content type based on URL pattern
        content_type = "external"
        media_url = None

        if "pbs.twimg.com/media" in final_url:
            content_type = "image"
            media_url = final_url
        elif "video.twimg.com" in final_url:
            content_type = "video"
            media_url = final_url
        elif re.match(r'https?://(twitter\.com|x\.com)/\w+/status/\d+', final_url):
            content_type = "quote"
            # Extract tweet ID from URL
            match = re.search(r'/status/(\d+)', final_url)
            if match:
                media_url = match.group(1)  # Just the tweet ID
        elif final_url.endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp')):
            content_type = "image"
            media_url = final_url

        result = {
            "original": url,
            "final": final_url,
            "type": content_type,
            "media_url": media_url
        }

        # Cache the result
        URL_CACHE[url] = result

        return jsonify(result)

    except requests.RequestException as e:
        return jsonify(error=str(e), original=url), 500

@app.route('/api/resolve-urls', methods=['POST'])
def resolve_urls():
    """
    Batch resolve multiple t.co URLs.
    """
    data = request.get_json()
    urls = data.get('urls', [])

    results = []
    for url in urls:
        if url in URL_CACHE:
            results.append(URL_CACHE[url])
        else:
            try:
                response = requests.head(url, allow_redirects=True, timeout=5)
                final_url = response.url

                content_type = "external"
                media_url = None

                if "pbs.twimg.com/media" in final_url:
                    content_type = "image"
                    media_url = final_url
                elif "video.twimg.com" in final_url:
                    content_type = "video"
                    media_url = final_url
                elif re.match(r'https?://(twitter\.com|x\.com)/\w+/status/\d+', final_url):
                    content_type = "quote"
                    match = re.search(r'/status/(\d+)', final_url)
                    if match:
                        media_url = match.group(1)
                elif final_url.endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp')):
                    content_type = "image"
                    media_url = final_url

                result = {
                    "original": url,
                    "final": final_url,
                    "type": content_type,
                    "media_url": media_url
                }
                URL_CACHE[url] = result
                results.append(result)

            except requests.RequestException:
                results.append({"original": url, "error": True})

    return jsonify(results=results)

# ===========================================================
# File based routes for reading data and metadata from disk
# ===========================================================


"""
Allow fetching of dataset files directly from disk
"""
@app.route('/api/files/<path:datasetPath>', methods=['GET'])
def send_file(datasetPath):
    print("req url", request.url)
    return send_from_directory(DATA_DIR, datasetPath)

"""
Given a list of indices (passed as a json array), return the rows from the dataset
"""
# TODO: Should this be deprecated for /query? only used for the hover now
@app.route('/api/indexed', methods=['POST'])
def indexed():
    data = request.get_json()
    dataset = data['dataset']
    indices = data.get('indices', [])
    columns = data.get('columns')
    embedding_id = data.get('embedding_id')
    sae_id = data.get('sae_id')

    print("SAE ID", sae_id)

    if dataset not in DATAFRAMES:
        df = pd.read_parquet(os.path.join(DATA_DIR, dataset, "input.parquet"))
        DATAFRAMES[dataset] = df
    else:
        df = DATAFRAMES[dataset]

    if columns:
        df = df[columns]

    if indices is None:
        indices = []
    if not isinstance(indices, list):
        indices = [indices]

    def normalize_index(value):
        if value is None or isinstance(value, bool):
            return None

        if isinstance(value, (int, np.integer)):
            return int(value)

        if isinstance(value, float):
            if math.isfinite(value) and value.is_integer():
                return int(value)
            return None

        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return None
            try:
                parsed = float(stripped)
            except ValueError:
                return None
            if math.isfinite(parsed) and parsed.is_integer():
                return int(parsed)
            return None

        return None

    # get the indexed rows, handling null/invalid/missing indices
    valid_indices = [
        idx for idx in (normalize_index(i) for i in indices)
        if idx is not None and 0 <= idx < len(df)
    ]
    rows = df.iloc[valid_indices].copy()
    rows['index'] = valid_indices

    if embedding_id:
        embedding_path = os.path.join(DATA_DIR, dataset, "embeddings", f"{embedding_id}.h5")
        with h5py.File(embedding_path, 'r') as f:
            npvi = np.array(valid_indices)
            sorted_indices = np.argsort(npvi)
            sorted_embeddings = np.array(f["embeddings"][npvi[sorted_indices]])
            filtered_embeddings = sorted_embeddings[np.argsort(sorted_indices)]
        rows['ls_embedding'] = filtered_embeddings
    
    if sae_id:
        sae_path = os.path.join(DATA_DIR, dataset, "saes", f"{sae_id}.h5")
        print("sae_path", sae_path)
        with h5py.File(sae_path, 'r') as f:
            npvi = np.array(valid_indices)
            sorted_indices = np.argsort(npvi)
            sorted_acts = np.array(f["top_acts"][npvi[sorted_indices]])
            filtered_acts = sorted_acts[np.argsort(sorted_indices)]
            sorted_top_inds = np.array(f["top_indices"][npvi[sorted_indices]])
            filtered_top_inds = sorted_top_inds[np.argsort(sorted_indices)]
        # rows['ls_acts'] = filtered_acts
        # rows['ls_top_indices'] = filtered_top_inds
        # rows['ls_features'] = [
        #     {'top_acts': act, 'top_indices': idx} for act, idx in zip(filtered_acts, filtered_top_inds)
        # ]
        rows['sae_acts'] = filtered_acts.tolist()
        rows['sae_indices'] = filtered_top_inds.tolist()

    # send back the rows as json
    return rows.to_json(orient="records")

@app.route('/api/column-filter', methods=['POST'])
def column_filter():
    data = request.get_json()
    dataset = data['dataset']
    filters = data['filters']

    if dataset not in DATAFRAMES:
        df = pd.read_parquet(os.path.join(DATA_DIR, dataset, "input.parquet"))
        DATAFRAMES[dataset] = df
    else:
        df = DATAFRAMES[dataset]
    
    # apply filters
    rows = df.copy()

    print("FILTERS", filters)
    if filters:
        for f in filters:
            if f["type"] == "eq":
                rows = rows[rows[f['column']] == f['value']]
            elif f["type"] == "gt":
                rows = rows[rows[f['column']] > f['value']]
            elif f["type"] == "lt":
                rows = rows[rows[f['column']] < f['value']]
            elif f["type"] == "gte":
                rows = rows[rows[f['column']] >= f['value']]
            elif f["type"] == "lte":
                rows = rows[rows[f['column']] <= f['value']]
            elif f["type"] == "in":
                rows = rows[rows[f['column']].isin(f['value'])]
            elif f["type"] == "contains":
                rows = rows[rows[f['column']].str.contains(f['value'])]

    return jsonify(indices=rows.index.to_list())

@app.route('/api/query', methods=['POST'])
def query():
    per_page = 100
    data = request.get_json()
    dataset = data['dataset']
    page = data['page'] if 'page' in data else 0
    indices = data['indices'] if 'indices' in data else []
    columns = data.get('columns') if 'columns' in data else None
    embedding_id = data['embedding_id'] if 'embedding_id' in data else None
    sae_id = data.get('sae_id') if 'sae_id' in data else None

    # filters = data['filters'] if 'filters' in data else None
    sort = data['sort'] if 'sort' in data else None
    if dataset not in DATAFRAMES:
        df = pd.read_parquet(os.path.join(DATA_DIR, dataset, "input.parquet"))
        DATAFRAMES[dataset] = df
    else:
        df = DATAFRAMES[dataset]
    
    # apply filters
    rows = df.copy()
    rows['ls_index'] = rows.index

    if columns:
        safe_columns = [col for col in columns if col in rows.columns]
        if 'ls_index' not in safe_columns:
            safe_columns.append('ls_index')
        rows = rows[safe_columns]
    

    # get the indexed rows
    if len(indices):
        rows = rows.loc[indices]

    # # only get the first 5 columns
    # cols = 5
    # rows = rows.iloc[:, :cols]

    if embedding_id:
        embedding_path = os.path.join(DATA_DIR, dataset, "embeddings", f"{embedding_id}.h5")
        with h5py.File(embedding_path, 'r') as f:
            npvi = np.array(rows.index)
            sorted_indices = np.argsort(npvi)
            sorted_embeddings = np.array(f["embeddings"][npvi[sorted_indices]])
            filtered_embeddings = sorted_embeddings[np.argsort(sorted_indices)]
        # Add the filtered embeddings as a new column to the rows DataFrame
        rows['ls_embedding'] = filtered_embeddings.tolist()
    
    if sae_id:
        sae_path = os.path.join(DATA_DIR, dataset, "saes", f"{sae_id}.h5")
        print("sae_path", sae_path)
        with h5py.File(sae_path, 'r') as f:
            npvi = np.array(rows.index)
            sorted_indices = np.argsort(npvi)
            sorted_acts = np.array(f["top_acts"][npvi[sorted_indices]])
            filtered_acts = sorted_acts[np.argsort(sorted_indices)]
            sorted_top_inds = np.array(f["top_indices"][npvi[sorted_indices]])
            filtered_top_inds = sorted_top_inds[np.argsort(sorted_indices)]
        # rows['ls_acts'] = filtered_acts
        # rows['ls_top_indices'] = filtered_top_inds
        rows['ls_features'] = [
            {'top_acts': act, 'top_indices': idx} for act, idx in zip(filtered_acts, filtered_top_inds)
        ]

    # print("ROWS", rows.head())
    # apply sort
    if sort:
        rows = rows.sort_values(by=sort['column'], ascending=sort['ascending'])

    # Convert DataFrame to a list of dictionaries
    rows_json = json.loads(rows[page*per_page:page*per_page+per_page].to_json(orient="records"))

    # only send back the first per_page rows
    # per_page = 100
    # rows_json = rows_json[:per_page]

    # send back the rows as json
    return jsonify({
        "rows": rows_json,
        "page": page,
        "per_page": per_page,
        "total": len(rows),
        "totalPages": math.ceil(len(rows) / per_page)
    })

if APP_MODE == "studio" and not READ_ONLY:
    @app.route('/api/settings', methods=['POST'])
    def update_settings():
        data = request.get_json()
        print("update settings", data)
        for key in data:
            set_key(".env", key, data[key])
        return jsonify({})

    @app.route('/api/settings', methods=['GET'])
    def get_settings():
        config = dotenv_values(".env")  # Assuming the .env file is in the root directory
        supported_api_keys = get_supported_api_keys()
        settings = {
            "data_dir": config["LATENT_SCOPE_DATA"],
            "api_keys": [key for key in config if key in supported_api_keys],
            "supported_api_keys": supported_api_keys,
            "env_file": os.path.abspath(".env")
        }
        return jsonify(settings)

@app.route('/api/version', methods=['GET'])
def get_version():
    print("GET VERSION", __version__)
    return __version__


@app.route('/api/app-config', methods=['GET'])
def get_app_config():
    # Feature flags allow one frontend build to handle studio/hosted/single-profile variants.
    features = {
        "can_explore": True,
        "can_compare": APP_MODE == "studio",
        "can_ingest": APP_MODE in {"studio", "hosted"} and not READ_ONLY,
        "can_setup": APP_MODE == "studio" and not READ_ONLY,
        "can_jobs": APP_MODE == "studio" and not READ_ONLY,
        "can_export": APP_MODE == "studio" and not READ_ONLY,
        "can_settings": APP_MODE == "studio" and not READ_ONLY,
        "twitter_import": APP_MODE in {"hosted", "studio"} and not READ_ONLY,
        "generic_file_ingest": APP_MODE == "studio" and not READ_ONLY,
    }
    return jsonify(
        {
            "mode": APP_MODE,
            "read_only": READ_ONLY,
            "public_dataset_id": PUBLIC_DATASET_ID,
            "public_scope_id": PUBLIC_SCOPE_ID,
            "features": features,
            "limits": {"max_upload_mb": MAX_UPLOAD_MB},
            "version": __version__,
        }
    )


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def catch_all(path):
    if path.endswith('.js') or path.endswith('.css'):
        pth = files('latentscope').joinpath(f"web/dist/{path}")
        directory = pth.parent
        return send_from_directory(directory, pth.name)
    # always return index.html and let client-side do the routing
    pth = files('latentscope').joinpath("web/dist/index.html")
    directory = pth.parent
    return send_from_directory(directory, pth.name)

def serve(host="0.0.0.0", port=5001, debug=True):
    app.run(host=host, port=port, debug=debug)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Serve the Latent Scope API')
    # parser.add_argument('data_dir', type=str, nargs='?', default=None, help='Path to the directory where data is stored')
    parser.add_argument('--host', type=str, default="0.0.0.0", help='Host to serve the server on')
    parser.add_argument('--port', type=int, default=5001, help='Port to run the server on')
    parser.add_argument('--debug', action='store_true', help='Run server in debug mode')
    args = parser.parse_args()
    host = args.host
    port = args.port
    debug = args.debug
    serve(host, port, debug)
