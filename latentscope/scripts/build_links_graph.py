"""Build reply and quote edge artifacts for a dataset."""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import pandas as pd

from latentscope import __version__
from latentscope.util import get_data_dir

STATUS_URL_RE = re.compile(
    r"https?://(?:www\.)?(?:x\.com|twitter\.com)/(?:i/web/)?(?:[A-Za-z0-9_]+/)?status/(?P<tweet_id>\d+)",
    re.IGNORECASE,
)

SOURCE_TWEET_TYPES = {"tweet", "note_tweet"}


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _normalize_tweet_type(value: Any) -> str:
    text = _as_text(value).lower()
    if not text:
        return "tweet"
    return text


def _normalize_tweet_id(value: Any) -> str | None:
    text = _as_text(value)
    if not text:
        return None
    if text.endswith(".0") and text[:-2].isdigit():
        return text[:-2]
    return text


def _parse_urls(value: Any) -> list[str]:
    if value is None:
        return []

    raw = value
    if isinstance(raw, str):
        raw = raw.strip()
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
            raw = parsed
        except json.JSONDecodeError:
            return [raw]

    if isinstance(raw, dict):
        raw = [raw]

    if not isinstance(raw, list):
        return []

    urls: list[str] = []
    for item in raw:
        if isinstance(item, str):
            url = item.strip()
            if url:
                urls.append(url)
        elif isinstance(item, dict):
            candidate = (
                item.get("expanded_url")
                or item.get("expandedUrl")
                or item.get("url")
            )
            if candidate:
                urls.append(str(candidate).strip())
    return urls


def _normalize_url(url: str) -> str:
    try:
        split = urlsplit(url)
    except Exception:
        return url

    scheme = (split.scheme or "https").lower()
    host = (split.netloc or "").lower().replace("www.", "")
    path = split.path or ""
    # keep path but remove trailing slash for normalization consistency
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]

    return urlunsplit((scheme, host, path, "", ""))


def _extract_status_id(url: str) -> str | None:
    match = STATUS_URL_RE.search(url)
    if not match:
        return None
    return match.group("tweet_id")


def _ensure_ls_index(df: pd.DataFrame) -> pd.DataFrame:
    if "ls_index" in df.columns:
        df = df.copy()
        df["ls_index"] = pd.to_numeric(df["ls_index"], errors="coerce")
        df = df[df["ls_index"].notna()].copy()
        df["ls_index"] = df["ls_index"].astype(int)
        return df

    if "index" in df.columns:
        df = df.rename(columns={"index": "ls_index"}).copy()
        df["ls_index"] = pd.to_numeric(df["ls_index"], errors="coerce")
        df = df[df["ls_index"].notna()].copy()
        df["ls_index"] = df["ls_index"].astype(int)
        return df

    df = df.reset_index(drop=True).copy()
    df["ls_index"] = df.index.astype(int)
    return df


def _resolve_scope_indices(dataset_dir: str, scope_id: str) -> set[int]:
    scopes_dir = os.path.join(dataset_dir, "scopes")
    preferred = os.path.join(scopes_dir, f"{scope_id}-input.parquet")
    fallback = os.path.join(scopes_dir, f"{scope_id}.parquet")

    scope_path = preferred if os.path.exists(preferred) else fallback
    if not os.path.exists(scope_path):
        raise FileNotFoundError(f"Scope parquet not found for scope_id={scope_id}")

    scope_df = pd.read_parquet(scope_path)
    scope_df = _ensure_ls_index(scope_df)

    if "deleted" in scope_df.columns:
        scope_df = scope_df[~scope_df["deleted"].astype(bool)]

    return set(scope_df["ls_index"].astype(int).tolist())


def _compute_thread_metadata(
    tweet_ids: set[str],
    parent_map: dict[str, str],
    child_count_map: dict[str, int],
) -> tuple[dict[str, str], dict[str, int], dict[str, int]]:
    root_cache: dict[str, str] = {}
    depth_cache: dict[str, int] = {}

    def _resolve(tweet_id: str) -> tuple[str, int]:
        if tweet_id in root_cache:
            return root_cache[tweet_id], depth_cache[tweet_id]

        visited: list[str] = []
        visited_set: set[str] = set()
        current = tweet_id
        root_id: str | None = None
        root_depth: int | None = None

        while True:
            if current in root_cache:
                cached_root = root_cache[current]
                cached_depth = depth_cache[current]
                root_id = cached_root
                root_depth = cached_depth + 1
                break

            if current in visited_set:
                # Cycle fallback: collapse to the current tweet to avoid infinite loops.
                root_id = current
                root_depth = 0
                break

            visited.append(current)
            visited_set.add(current)

            parent = parent_map.get(current)
            if not parent:
                root_id = current
                root_depth = 0
                break

            if parent not in tweet_ids:
                root_id = parent
                root_depth = 1
                break

            current = parent

        # Backfill visited chain with descending depths.
        depth = int(root_depth)
        root = str(root_id)
        for node in reversed(visited):
            root_cache[node] = root
            depth_cache[node] = depth
            depth += 1

        return root_cache[tweet_id], depth_cache[tweet_id]

    thread_root_map: dict[str, str] = {}
    thread_depth_map: dict[str, int] = {}
    for tid in tweet_ids:
        root_id, depth = _resolve(tid)
        thread_root_map[tid] = root_id
        thread_depth_map[tid] = depth

    thread_size_map: dict[str, int] = defaultdict(int)
    for tid in tweet_ids:
        thread_size_map[thread_root_map[tid]] += 1

    tweet_thread_size_map = {tid: thread_size_map[thread_root_map[tid]] for tid in tweet_ids}

    # Ensure all nodes get child counts (0 if missing)
    for tid in tweet_ids:
        child_count_map.setdefault(tid, 0)

    return thread_root_map, thread_depth_map, tweet_thread_size_map


def build_links_graph(
    dataset_id: str,
    *,
    scope_id: str | None = None,
    data_dir: str | None = None,
) -> dict[str, Any]:
    data_dir = data_dir or get_data_dir()
    dataset_dir = os.path.join(data_dir, dataset_id)
    input_path = os.path.join(dataset_dir, "input.parquet")
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Dataset input not found: {input_path}")

    df = pd.read_parquet(input_path)
    df = _ensure_ls_index(df)

    if scope_id:
        allowed_indices = _resolve_scope_indices(dataset_dir, scope_id)
        df = df[df["ls_index"].isin(allowed_indices)].copy()

    if "id" not in df.columns:
        raise ValueError("Dataset input.parquet must contain an 'id' column for link graph construction")

    if "in_reply_to_status_id" not in df.columns:
        df["in_reply_to_status_id"] = None

    if "urls_json" not in df.columns:
        df["urls_json"] = "[]"

    if "tweet_type" not in df.columns:
        df["tweet_type"] = "tweet"

    df["id"] = df["id"].map(_normalize_tweet_id)
    df = df[df["id"].notna()].copy()
    df["tweet_type"] = df["tweet_type"].map(_normalize_tweet_type)

    source_df = df[df["tweet_type"].isin(SOURCE_TWEET_TYPES)].copy()
    source_df = source_df[source_df["id"].astype(str).str.len() > 0].copy()

    tweet_id_to_ls_index: dict[str, int] = {}
    for row in source_df.itertuples(index=False):
        tweet_id = str(row.id)
        if tweet_id not in tweet_id_to_ls_index:
            tweet_id_to_ls_index[tweet_id] = int(row.ls_index)

    tweet_ids = set(tweet_id_to_ls_index.keys())

    edge_records: list[dict[str, Any]] = []
    seen_edges: set[tuple[str, str, str]] = set()

    # Reply edges and parent map for thread metadata.
    parent_map: dict[str, str] = {}
    child_count_map: dict[str, int] = defaultdict(int)

    for row in source_df.itertuples(index=False):
        src_tweet_id = str(row.id)
        src_ls_index = int(row.ls_index)

        dst_reply = _normalize_tweet_id(getattr(row, "in_reply_to_status_id", None))
        if dst_reply:
            key = ("reply", src_tweet_id, dst_reply)
            if key not in seen_edges:
                seen_edges.add(key)
                dst_ls = tweet_id_to_ls_index.get(dst_reply)
                edge_records.append(
                    {
                        "edge_type": "reply",
                        "src_tweet_id": src_tweet_id,
                        "dst_tweet_id": dst_reply,
                        "src_ls_index": src_ls_index,
                        "dst_ls_index": int(dst_ls) if dst_ls is not None else None,
                        "internal_target": dst_ls is not None,
                        "source_url": None,
                    }
                )

            parent_map[src_tweet_id] = dst_reply
            if dst_reply in tweet_ids:
                child_count_map[dst_reply] += 1

        for raw_url in _parse_urls(getattr(row, "urls_json", "[]")):
            normalized_url = _normalize_url(raw_url)
            dst_quote = _extract_status_id(normalized_url)
            if not dst_quote:
                continue
            if dst_quote == src_tweet_id:
                continue

            key = ("quote", src_tweet_id, dst_quote)
            if key in seen_edges:
                continue
            seen_edges.add(key)

            dst_ls = tweet_id_to_ls_index.get(dst_quote)
            edge_records.append(
                {
                    "edge_type": "quote",
                    "src_tweet_id": src_tweet_id,
                    "dst_tweet_id": dst_quote,
                    "src_ls_index": src_ls_index,
                    "dst_ls_index": int(dst_ls) if dst_ls is not None else None,
                    "internal_target": dst_ls is not None,
                    "source_url": normalized_url,
                }
            )

    edges_df = pd.DataFrame(
        edge_records,
        columns=[
            "edge_type",
            "src_tweet_id",
            "dst_tweet_id",
            "src_ls_index",
            "dst_ls_index",
            "internal_target",
            "source_url",
        ],
    )

    # Node-level link stats
    reply_out_count: dict[str, int] = defaultdict(int)
    reply_in_count: dict[str, int] = defaultdict(int)
    quote_out_count: dict[str, int] = defaultdict(int)
    quote_in_count: dict[str, int] = defaultdict(int)

    if not edges_df.empty:
        for row in edges_df.itertuples(index=False):
            if row.edge_type == "reply":
                reply_out_count[row.src_tweet_id] += 1
                if row.dst_tweet_id in tweet_ids:
                    reply_in_count[row.dst_tweet_id] += 1
            elif row.edge_type == "quote":
                quote_out_count[row.src_tweet_id] += 1
                if row.dst_tweet_id in tweet_ids:
                    quote_in_count[row.dst_tweet_id] += 1

    thread_root_map, thread_depth_map, thread_size_map = _compute_thread_metadata(
        tweet_ids=tweet_ids,
        parent_map=parent_map,
        child_count_map=child_count_map,
    )

    node_records: list[dict[str, Any]] = []
    for tweet_id, ls_index in tweet_id_to_ls_index.items():
        node_records.append(
            {
                "tweet_id": tweet_id,
                "ls_index": int(ls_index),
                "reply_out_count": int(reply_out_count.get(tweet_id, 0)),
                "reply_in_count": int(reply_in_count.get(tweet_id, 0)),
                "quote_out_count": int(quote_out_count.get(tweet_id, 0)),
                "quote_in_count": int(quote_in_count.get(tweet_id, 0)),
                "thread_root_id": thread_root_map.get(tweet_id, tweet_id),
                "thread_depth": int(thread_depth_map.get(tweet_id, 0)),
                "thread_size": int(thread_size_map.get(tweet_id, 1)),
                "reply_child_count": int(child_count_map.get(tweet_id, 0)),
            }
        )

    node_stats_df = pd.DataFrame(
        node_records,
        columns=[
            "tweet_id",
            "ls_index",
            "reply_out_count",
            "reply_in_count",
            "quote_out_count",
            "quote_in_count",
            "thread_root_id",
            "thread_depth",
            "thread_size",
            "reply_child_count",
        ],
    )

    links_dir = os.path.join(dataset_dir, "links")
    os.makedirs(links_dir, exist_ok=True)

    edges_path = os.path.join(links_dir, "edges.parquet")
    node_stats_path = os.path.join(links_dir, "node_link_stats.parquet")
    meta_path = os.path.join(links_dir, "meta.json")

    edges_df.to_parquet(edges_path, index=False)
    node_stats_df.to_parquet(node_stats_path, index=False)

    edge_type_counts = {
        "reply": int((edges_df["edge_type"] == "reply").sum()) if not edges_df.empty else 0,
        "quote": int((edges_df["edge_type"] == "quote").sum()) if not edges_df.empty else 0,
    }

    if edges_df.empty:
        internal_mask = pd.Series(dtype=bool)
    else:
        internal_mask = edges_df["src_ls_index"].notna() & edges_df["dst_ls_index"].notna()

    internal_edge_type_counts = {
        "reply": int(((edges_df["edge_type"] == "reply") & internal_mask).sum()) if not edges_df.empty else 0,
        "quote": int(((edges_df["edge_type"] == "quote") & internal_mask).sum()) if not edges_df.empty else 0,
    }
    internal_internal_count = int(internal_mask.sum()) if not edges_df.empty else 0

    meta = {
        "dataset_id": dataset_id,
        "scope_id": scope_id,
        "schema_version": "links-v1",
        "built_at": datetime.now(timezone.utc).isoformat(),
        "ls_version": __version__,
        "nodes": int(len(node_stats_df)),
        "edges": int(len(edges_df)),
        "edge_type_counts": edge_type_counts,
        "internal_edge_type_counts": internal_edge_type_counts,
        "internal_edges": internal_internal_count,
        "internal_internal_edges": internal_internal_count,
    }

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return {
        "dataset_id": dataset_id,
        "scope_id": scope_id,
        "nodes": int(len(node_stats_df)),
        "edges": int(len(edges_df)),
        "edge_type_counts": edge_type_counts,
        "internal_edge_type_counts": internal_edge_type_counts,
        "internal_edges": internal_internal_count,
        "links_dir": links_dir,
        "edges_path": edges_path,
        "node_stats_path": node_stats_path,
        "meta_path": meta_path,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build reply/quote link graph artifacts for a dataset")
    parser.add_argument("dataset_id", type=str, help="Dataset identifier")
    parser.add_argument("--scope_id", type=str, default=None, help="Optional scope id to restrict links")
    parser.add_argument("--data_dir", type=str, default=None, help="Override LATENT_SCOPE_DATA directory")
    args = parser.parse_args()

    result = build_links_graph(args.dataset_id, scope_id=args.scope_id, data_dir=args.data_dir)

    print(f"DATASET_ID: {result['dataset_id']}")
    if result.get("scope_id"):
        print(f"SCOPE_ID: {result['scope_id']}")
    print(f"NODES: {result['nodes']}")
    print(f"EDGES: {result['edges']}")
    print(f"REPLY_EDGES: {result['edge_type_counts']['reply']}")
    print(f"QUOTE_EDGES: {result['edge_type_counts']['quote']}")
    print(f"LINKS_DIR: {result['links_dir']}")


if __name__ == "__main__":
    main()
