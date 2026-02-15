from __future__ import annotations

import json
import os
import shlex
import shutil
import threading
import uuid

from flask import Blueprint, jsonify, request

from latentscope.importers.twitter import sanitize_dataset_id, validate_extracted_archive_payload

from . import jobs_store
from .jobs_commands import falsy_flag, shell_join, truthy_flag
from .jobs_delete import (
    build_delete_embedding_command,
    build_delete_sae_command,
    build_delete_umap_command,
    find_saes_to_delete_for_embedding,
    find_umaps_to_delete_for_embedding,
    find_umaps_to_delete_for_sae,
)
from .jobs_runner import PROCESSES, kill_process, run_job


jobs_bp = Blueprint("jobs_bp", __name__)
jobs_write_bp = Blueprint("jobs_write_bp", __name__)


def _start_job_thread(
    *, dataset: str, job_id: str, command: str, cleanup_paths: list[str] | None = None
) -> None:
    threading.Thread(target=run_job, args=(dataset, job_id, command, cleanup_paths)).start()


@jobs_bp.route("/job")
def get_job():
    dataset = request.args.get("dataset")
    job_id = request.args.get("job_id")
    if not dataset or not job_id:
        return jsonify({"error": "Missing dataset or job_id"}), 400
    try:
        job = jobs_store.read_job(dataset, job_id)
    except FileNotFoundError:
        return jsonify({"status": "not found"}), 404
    return jsonify(job)


@jobs_bp.route("/all")
def get_jobs():
    dataset = request.args.get("dataset")
    if not dataset:
        return jsonify([]), 200
    return jsonify(jobs_store.list_jobs(dataset))


@jobs_write_bp.route("/ingest", methods=["POST"])
def run_ingest():
    dataset = request.form.get("dataset")
    file = request.files.get("file")
    text_column = request.form.get("text_column")
    if not dataset or file is None:
        return jsonify({"error": "Missing dataset or file"}), 400
    if not jobs_store.DATA_DIR:
        return jsonify({"error": "LATENT_SCOPE_DATA must be set"}), 500

    dataset_dir = os.path.join(jobs_store.DATA_DIR, dataset)  # type: ignore[arg-type]
    os.makedirs(dataset_dir, exist_ok=True)
    file_path = os.path.join(dataset_dir, file.filename)
    file.save(file_path)

    job_id = str(uuid.uuid4())
    command = f'ls-ingest "{dataset}" --path="{file_path}"'
    if text_column:
        command += f' --text_column="{text_column}"'
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id, "dataset": dataset})


@jobs_write_bp.route("/import_twitter", methods=["POST"])
def run_import_twitter():
    job_id = str(uuid.uuid4())
    dataset = request.form.get("dataset", "")
    source_type = request.form.get("source_type", "community_json").strip().lower()
    cleanup_paths: list[str] = []

    if not jobs_store.DATA_DIR:
        return jsonify({"error": "LATENT_SCOPE_DATA must be set"}), 500

    try:
        dataset = sanitize_dataset_id(dataset)
    except ValueError as err:
        return jsonify({"error": str(err)}), 400

    dataset_dir = os.path.join(jobs_store.DATA_DIR, dataset)  # type: ignore[arg-type]
    os.makedirs(dataset_dir, exist_ok=True)
    uploads_dir = os.path.join(dataset_dir, "uploads")
    os.makedirs(uploads_dir, exist_ok=True)

    command_parts = ["ls-twitter-import", dataset]

    if source_type == "zip":
        return (
            jsonify(
                {
                    "error": (
                        "Raw zip uploads are disabled. "
                        "Upload extracted JSON payload instead (source_type=community_json)."
                    )
                }
            ),
            400,
        )

    if source_type == "community":
        username = request.form.get("username", "").strip()
        if not username:
            return jsonify({"error": "Missing username"}), 400
        command_parts.extend(["--source", "community", "--username", username])
    elif source_type == "community_json":
        file = request.files.get("file")
        if file is None:
            return jsonify({"error": "Missing community JSON file"}), 400
        job_upload_dir = os.path.join(uploads_dir, job_id)
        os.makedirs(job_upload_dir, exist_ok=True)
        file_path = os.path.join(job_upload_dir, f"community-extract-{uuid.uuid4().hex}.json")
        file.save(file_path)
        try:
            with open(file_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            validate_extracted_archive_payload(payload, require_archive_format=True)
        except (OSError, json.JSONDecodeError, ValueError) as err:
            shutil.rmtree(job_upload_dir, ignore_errors=True)
            return jsonify({"error": f"Invalid extracted archive payload: {err}"}), 400
        cleanup_paths.append(job_upload_dir)
        command_parts.extend(["--source", "community_json", "--input_path", file_path])
    else:
        return jsonify({"error": f"Unsupported source_type: {source_type}"}), 400

    optional_args = [
        ("year", request.form.get("year")),
        ("lang", request.form.get("lang")),
        ("min_favorites", request.form.get("min_favorites")),
        ("min_text_length", request.form.get("min_text_length")),
        ("top_n", request.form.get("top_n")),
        ("sort", request.form.get("sort")),
        ("text_column", request.form.get("text_column")),
        ("embedding_model", request.form.get("embedding_model")),
        ("umap_neighbors", request.form.get("umap_neighbors")),
        ("umap_min_dist", request.form.get("umap_min_dist")),
        ("cluster_samples", request.form.get("cluster_samples")),
        ("cluster_min_samples", request.form.get("cluster_min_samples")),
        ("cluster_selection_epsilon", request.form.get("cluster_selection_epsilon")),
        ("import_batch_id", request.form.get("import_batch_id")),
    ]

    for key, value in optional_args:
        if value is not None and value != "":
            command_parts.extend([f"--{key}", str(value)])

    if truthy_flag(request.form.get("exclude_replies")):
        command_parts.append("--exclude_replies")
    if truthy_flag(request.form.get("exclude_retweets")):
        command_parts.append("--exclude_retweets")
    include_likes = truthy_flag(request.form.get("include_likes", "true"), default=True)
    if not include_likes:
        command_parts.append("--exclude_likes")

    if truthy_flag(request.form.get("run_pipeline", "true"), default=True):
        command_parts.append("--run_pipeline")

    incremental_links = request.form.get("incremental_links")
    if incremental_links is not None and falsy_flag(incremental_links):
        command_parts.append("--no-incremental-links")

    command = shell_join(command_parts)
    _start_job_thread(dataset=dataset, job_id=job_id, command=command, cleanup_paths=cleanup_paths)
    return jsonify({"job_id": job_id, "dataset": dataset})


@jobs_write_bp.route("/reingest", methods=["GET"])
def run_reingest():
    dataset = request.args.get("dataset")
    text_column = request.args.get("text_column")
    if not dataset:
        return jsonify({"error": "Missing dataset"}), 400
    if not jobs_store.DATA_DIR:
        return jsonify({"error": "LATENT_SCOPE_DATA must be set"}), 500
    dataset_dir = os.path.join(jobs_store.DATA_DIR, dataset)  # type: ignore[arg-type]
    file_path = os.path.join(dataset_dir, "input.parquet")

    job_id = str(uuid.uuid4())
    command = f'ls-ingest "{dataset}" --path="{file_path}"'
    if text_column:
        command += f' --text_column="{text_column}"'
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/embed")
def run_embed():
    dataset = request.args.get("dataset")
    text_column = request.args.get("text_column")
    model_id = request.args.get("model_id")
    prefix = request.args.get("prefix")
    dimensions = request.args.get("dimensions")
    batch_size = request.args.get("batch_size")
    max_seq_length = request.args.get("max_seq_length")

    job_id = str(uuid.uuid4())
    command = f'ls-embed "{dataset}" "{text_column}" "{model_id}" --prefix="{prefix}" --batch_size={batch_size}'
    if dimensions is not None:
        command += f" --dimensions={dimensions}"
    if max_seq_length is not None:
        command += f" --max_seq_length={max_seq_length}"
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/embed_truncate")
def run_embed_truncate():
    dataset = request.args.get("dataset")
    embedding_id = request.args.get("embedding_id")
    dimensions = request.args.get("dimensions")

    job_id = str(uuid.uuid4())
    command = f'ls-embed-truncate "{dataset}" "{embedding_id}" {dimensions}'
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/embed_importer")
def run_embed_importer():
    dataset = request.args.get("dataset")
    model_id = request.args.get("model_id")
    embedding_column = request.args.get("embedding_column")
    text_column = request.args.get("text_column")

    job_id = str(uuid.uuid4())
    command = f'ls-embed-importer "{dataset}" "{embedding_column}" "{model_id}" "{text_column}"'
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/rerun")
def rerun_job():
    dataset = request.args.get("dataset")
    job_id = request.args.get("job_id")
    if not dataset or not job_id:
        return jsonify({"error": "Missing dataset or job_id"}), 400
    job = jobs_store.read_job(dataset, job_id)
    command = job.get("command")
    command += f' --rerun {job.get("run_id")}'
    new_job_id = str(uuid.uuid4())
    print("new job id", new_job_id)
    _start_job_thread(dataset=dataset, job_id=new_job_id, command=command)
    return jsonify({"job_id": new_job_id})


@jobs_write_bp.route("/kill")
def kill_job():
    dataset = request.args.get("dataset")
    job_id = request.args.get("job_id")
    if not dataset or not job_id:
        return jsonify({"error": "Missing dataset or job_id"}), 400
    job = jobs_store.read_job(dataset, job_id)
    if kill_process(job_id):
        job["status"] = "dead"
        job["cause_of_death"] = "killed"
        jobs_store.write_job(dataset, job_id, job)
        return jsonify(job)
    job["status"] = "dead"
    job["cause_of_death"] = "process not found, presumed dead"
    jobs_store.write_job(dataset, job_id, job)
    return jsonify(job)


@jobs_write_bp.route("/delete/embedding")
def delete_embedding():
    dataset = request.args.get("dataset")
    embedding_id = request.args.get("embedding_id")

    umaps_to_delete = find_umaps_to_delete_for_embedding(dataset, embedding_id)
    saes_to_delete = find_saes_to_delete_for_embedding(dataset, embedding_id)

    job_id = str(uuid.uuid4())
    command = build_delete_embedding_command(dataset, embedding_id)
    for umap in umaps_to_delete:
        _ = delete_umap(dataset, umap)
    for sae in saes_to_delete:
        _ = delete_sae(dataset, sae)
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/umap")
def run_umap():
    dataset = request.args.get("dataset")
    embedding_id = request.args.get("embedding_id")
    sae_id = request.args.get("sae_id")
    neighbors = request.args.get("neighbors")
    min_dist = request.args.get("min_dist")
    init = request.args.get("init")
    align = request.args.get("align")
    save = request.args.get("save")
    seed = request.args.get("seed")

    job_id = str(uuid.uuid4())
    command = f'ls-umap "{dataset}" "{embedding_id}" {neighbors} {min_dist}'
    if init:
        command += f" --init={init}"
    if align:
        command += f" --align={align}"
    if save:
        command += " --save"
    if sae_id:
        command += f" --sae_id={sae_id}"
    if seed:
        command += f" --seed={seed}"

    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/delete/umap")
def delete_umap_request():
    dataset = request.args.get("dataset")
    umap_id = request.args.get("umap_id")
    return delete_umap(dataset, umap_id)


def delete_umap(dataset: str, umap_id: str):
    job_id = str(uuid.uuid4())
    command = build_delete_umap_command(dataset, umap_id)
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/sae")
def run_sae():
    dataset = request.args.get("dataset")
    embedding_id = request.args.get("embedding_id")
    model_id = request.args.get("model_id")
    k_expansion = request.args.get("k_expansion")

    job_id = str(uuid.uuid4())
    command = f'ls-sae "{dataset}" "{embedding_id}" "{model_id}" {k_expansion}'
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/delete/sae")
def delete_sae_request():
    dataset = request.args.get("dataset")
    sae_id = request.args.get("sae_id")
    return delete_sae(dataset, sae_id)


def delete_sae(dataset: str, sae_id: str):
    umaps_to_delete = find_umaps_to_delete_for_sae(dataset, sae_id)

    job_id = str(uuid.uuid4())
    command = build_delete_sae_command(dataset, sae_id)
    for umap in umaps_to_delete:
        _ = delete_umap(dataset, umap)
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/cluster")
def run_cluster():
    dataset = request.args.get("dataset")
    umap_id = request.args.get("umap_id")
    samples = request.args.get("samples")
    min_samples = request.args.get("min_samples")
    cluster_selection_epsilon = request.args.get("cluster_selection_epsilon")

    job_id = str(uuid.uuid4())
    command = f'ls-cluster "{dataset}" "{umap_id}" {samples} {min_samples} {cluster_selection_epsilon}'
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/delete/cluster")
def delete_cluster():
    dataset = request.args.get("dataset")
    cluster_id = request.args.get("cluster_id")
    job_id = str(uuid.uuid4())
    path = os.path.join(jobs_store.DATA_DIR or "", dataset, "clusters", f"{cluster_id}*").replace(" ", "\\ ")
    command = f"rm -rf {path}"
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/cluster_label")
def run_cluster_label():
    dataset = request.args.get("dataset")
    chat_id = request.args.get("chat_id")
    text_column = request.args.get("text_column")
    cluster_id = request.args.get("cluster_id")
    context = request.args.get("context")
    samples = request.args.get("samples")
    max_tokens_per_sample = request.args.get("max_tokens_per_sample")
    max_tokens_total = request.args.get("max_tokens_total")
    if context:
        context = context.replace('"', '\\"')

    job_id = str(uuid.uuid4())
    command = f'ls-label "{dataset}" "{text_column}" "{cluster_id}" "{chat_id}" {samples} "{context}"'
    if max_tokens_per_sample:
        command += f" --max_tokens_per_sample={max_tokens_per_sample}"
    if max_tokens_total:
        command += f" --max_tokens_total={max_tokens_total}"
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/delete/cluster_label")
def delete_cluster_label():
    dataset = request.args.get("dataset")
    cluster_labels_id = request.args.get("cluster_labels_id")
    job_id = str(uuid.uuid4())
    path = os.path.join(jobs_store.DATA_DIR or "", dataset, "clusters", f"{cluster_labels_id}*").replace(" ", "\\ ")
    command = f"rm -rf {path}"
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/scope")
def run_scope():
    dataset = request.args.get("dataset")
    embedding_id = request.args.get("embedding_id")
    sae_id = request.args.get("sae_id")
    umap_id = request.args.get("umap_id")
    cluster_id = request.args.get("cluster_id")
    cluster_labels_id = request.args.get("cluster_labels_id")
    label = request.args.get("label")
    description = request.args.get("description")
    scope_id = request.args.get("scope_id")

    job_id = str(uuid.uuid4())
    command = (
        f'ls-scope "{dataset}" "{embedding_id}" "{umap_id}" "{cluster_id}" "{cluster_labels_id}" "{label}" "{description}"'
    )
    if sae_id:
        command += f" --sae_id={sae_id}"
    if scope_id:
        command += f" --scope_id={scope_id}"
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/delete/scope")
def delete_scope():
    dataset = request.args.get("dataset")
    scope_id = request.args.get("scope_id")

    job_id = str(uuid.uuid4())
    path = os.path.join(jobs_store.DATA_DIR or "", dataset, "scopes", f"{scope_id}*").replace(" ", "\\ ")
    command = f"rm -rf {path}"
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/plot")
def run_plot():
    dataset = request.args.get("dataset")
    scope_id = request.args.get("scope_id")
    config = request.args.get("config")

    job_id = str(uuid.uuid4())
    command = f'ls-export-plot "{dataset}" {scope_id}'
    escaped_config = json.dumps(config)
    command += f" --plot_config={escaped_config}"

    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/download_dataset")
def download_dataset():
    dataset_repo = request.args.get("dataset_repo")
    dataset_name = request.args.get("dataset_name")

    job_id = str(uuid.uuid4())
    command = f'ls-download-dataset "{dataset_repo}" "{dataset_name}" "{jobs_store.DATA_DIR}"'
    _start_job_thread(dataset=dataset_name, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/upload_dataset")
def upload_dataset():
    dataset = request.args.get("dataset")
    hf_dataset = request.args.get("hf_dataset")
    main_parquet = request.args.get("main_parquet")
    private = request.args.get("private")

    job_id = str(uuid.uuid4())
    path = os.path.join(jobs_store.DATA_DIR or "", dataset)
    command = f'ls-upload-dataset "{path}" "{hf_dataset}" --main-parquet="{main_parquet}" --private={private}'
    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})


@jobs_write_bp.route("/toponymy")
def run_toponymy():
    dataset = request.args.get("dataset")
    scope_id = request.args.get("scope_id")
    llm_provider = request.args.get("llm_provider", "openai")
    llm_model = request.args.get("llm_model", "gpt-5-mini")
    min_clusters = request.args.get("min_clusters", "2")
    base_min_cluster_size = request.args.get("base_min_cluster_size", "10")
    context = request.args.get("context", "")

    job_id = str(uuid.uuid4())
    command = f'python -m latentscope.scripts.toponymy_labels "{dataset}" "{scope_id}"'
    command += f' --llm-provider="{llm_provider}"'
    command += f' --llm-model="{llm_model}"'
    command += f" --min-clusters={min_clusters}"
    command += f" --base-min-cluster-size={base_min_cluster_size}"
    if context:
        escaped_context = context.replace('"', '\\"')
        command += f' --context="{escaped_context}"'

    _start_job_thread(dataset=dataset, job_id=job_id, command=command)
    return jsonify({"job_id": job_id})
