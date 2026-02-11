#!/usr/bin/env python3
"""
Sync serving artifacts for one dataset/scope to an S3-compatible bucket (Cloudflare R2).

Defaults to dry-run. Pass --execute to upload files.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
from pathlib import Path
from typing import Iterable


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync CDN serving artifacts to Cloudflare R2")
    parser.add_argument("--data-dir", default=os.environ.get("LATENT_SCOPE_DATA"), help="Root data directory")
    parser.add_argument("--dataset", required=True, help="Dataset id (directory name)")
    parser.add_argument("--scope", required=True, help="Scope id (example: scopes-001)")
    parser.add_argument("--bucket", required=True, help="R2 bucket name")
    parser.add_argument(
        "--endpoint-url",
        default=os.environ.get("R2_ENDPOINT_URL"),
        help="R2 S3-compatible endpoint (example: https://<accountid>.r2.cloudflarestorage.com)",
    )
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "auto"), help="S3 region (R2 uses auto)")
    parser.add_argument("--prefix", default="", help="Optional remote prefix in bucket")
    parser.add_argument("--execute", action="store_true", help="Actually upload files")
    parser.add_argument("--verbose", action="store_true", help="Print per-file details")
    return parser.parse_args()


def _require_data_dir(data_dir: str | None) -> Path:
    if not data_dir:
        raise ValueError("Missing --data-dir and LATENT_SCOPE_DATA is not set")
    root = Path(data_dir).expanduser().resolve()
    if not root.exists():
        raise FileNotFoundError(f"Data dir does not exist: {root}")
    return root


def _load_scope_json(dataset_dir: Path, scope_id: str) -> dict:
    scope_path = dataset_dir / "scopes" / f"{scope_id}.json"
    if not scope_path.exists():
        raise FileNotFoundError(f"Missing scope JSON: {scope_path}")
    with scope_path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _resolve_cluster_labels_id(scope_doc: dict) -> str:
    labels_id = scope_doc.get("cluster_labels_id")
    if labels_id:
        return str(labels_id)
    cluster_labels = scope_doc.get("cluster_labels")
    if isinstance(cluster_labels, dict) and cluster_labels.get("id"):
        return str(cluster_labels["id"])
    raise ValueError("Unable to resolve cluster labels id from scope JSON")


def _build_allowlist_paths(dataset_dir: Path, scope_id: str, scope_doc: dict) -> list[Path]:
    rels = [
        Path("meta.json"),
        Path("scopes") / f"{scope_id}.json",
        Path("scopes") / f"{scope_id}-input.parquet",
        Path("links") / "meta.json",
        Path("links") / "edges.parquet",
        Path("links") / "node_link_stats.parquet",
    ]

    labels_id = _resolve_cluster_labels_id(scope_doc)
    rels.append(Path("clusters") / f"{labels_id}.parquet")
    rels.append(Path("clusters") / f"{labels_id}.json")

    missing = [str(dataset_dir / rel) for rel in rels if not (dataset_dir / rel).exists()]
    if missing:
        lines = "\n".join(f"- {item}" for item in missing)
        raise FileNotFoundError(f"Missing required serving artifacts:\n{lines}")

    return [dataset_dir / rel for rel in rels]


def _guess_content_type(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(str(path))
    if guessed:
        return guessed
    if path.suffix == ".parquet":
        return "application/octet-stream"
    return "application/octet-stream"


def _remote_key(prefix: str, dataset: str, file_path: Path, dataset_dir: Path) -> str:
    rel = file_path.relative_to(dataset_dir).as_posix()
    stem = f"{dataset}/{rel}"
    if not prefix:
        return stem
    clean_prefix = prefix.strip("/")
    return f"{clean_prefix}/{stem}"


def _print_manifest(files: Iterable[Path], dataset_dir: Path) -> None:
    print("Manifest (D1 allowlist):")
    for file_path in files:
        print(f"- {file_path.relative_to(dataset_dir).as_posix()}")


def _build_s3_client(endpoint_url: str, region: str):
    try:
        import boto3
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError(
            "boto3 is required for upload mode. Install with: pip install boto3"
        ) from exc

    session = boto3.session.Session()
    return session.client("s3", endpoint_url=endpoint_url, region_name=region)


def _upload_files(
    files: list[Path],
    *,
    dataset_dir: Path,
    dataset: str,
    bucket: str,
    endpoint_url: str,
    region: str,
    prefix: str,
    verbose: bool,
) -> None:
    client = _build_s3_client(endpoint_url=endpoint_url, region=region)
    for path in files:
        key = _remote_key(prefix, dataset, path, dataset_dir)
        content_type = _guess_content_type(path)
        if verbose:
            print(f"Uploading {path} -> s3://{bucket}/{key} ({content_type})")
        client.upload_file(
            str(path),
            bucket,
            key,
            ExtraArgs={"ContentType": content_type},
        )
    print(f"Uploaded {len(files)} files to s3://{bucket}/{prefix.strip('/') or ''}")


def main() -> None:
    args = _parse_args()
    dataset_root = _require_data_dir(args.data_dir)
    dataset_dir = dataset_root / args.dataset
    if not dataset_dir.exists():
        raise FileNotFoundError(f"Dataset path not found: {dataset_dir}")

    scope_doc = _load_scope_json(dataset_dir, args.scope)
    files = _build_allowlist_paths(dataset_dir, args.scope, scope_doc)

    _print_manifest(files, dataset_dir)
    print(f"Bucket: {args.bucket}")
    print(f"Prefix: {args.prefix or '<none>'}")
    print(f"Endpoint: {args.endpoint_url or '<missing>'}")

    if not args.execute:
        print("Dry-run complete. Re-run with --execute to upload.")
        return

    if not args.endpoint_url:
        raise ValueError("Missing --endpoint-url and R2_ENDPOINT_URL is not set")
    _upload_files(
        files,
        dataset_dir=dataset_dir,
        dataset=args.dataset,
        bucket=args.bucket,
        endpoint_url=args.endpoint_url,
        region=args.region,
        prefix=args.prefix,
        verbose=args.verbose,
    )


if __name__ == "__main__":
    main()
