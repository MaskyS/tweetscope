"""Build reply and quote edge artifacts for a dataset."""

from __future__ import annotations

import argparse
import hashlib
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


EDGE_COLUMNS = [
    "edge_id",
    "edge_kind",
    "src_tweet_id",
    "dst_tweet_id",
    "src_ls_index",
    "dst_ls_index",
    "internal_target",
    "provenance",
    "source_url",
]


def _make_edge_id(src: str, dst: str, kind: str, provenance: str) -> str:
    key = f"{src}|{dst}|{kind}|{provenance}"
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def _canonicalize_edges_df(df: pd.DataFrame | None = None) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=EDGE_COLUMNS)

    out = df.copy()
    # Backward compatibility: links-v1 used `edge_type` instead of `edge_kind`.
    if "edge_type" in out.columns:
        legacy_edge_kind = out["edge_type"].map(_as_text).str.lower()
        if "edge_kind" not in out.columns:
            out["edge_kind"] = legacy_edge_kind
        else:
            existing_edge_kind = out["edge_kind"].map(_as_text)
            missing_edge_kind = existing_edge_kind == ""
            if missing_edge_kind.any():
                out.loc[missing_edge_kind, "edge_kind"] = legacy_edge_kind[missing_edge_kind]

    for col in EDGE_COLUMNS:
        if col not in out.columns:
            out[col] = None
    out = out[EDGE_COLUMNS]
    out["edge_kind"] = out["edge_kind"].map(_as_text).str.lower()
    out = out[out["edge_kind"].isin({"reply", "quote"})].copy()
    out["src_tweet_id"] = out["src_tweet_id"].map(_normalize_tweet_id)
    out["dst_tweet_id"] = out["dst_tweet_id"].map(_normalize_tweet_id)
    out = out[out["src_tweet_id"].notna() & out["dst_tweet_id"].notna()].copy()
    out["src_ls_index"] = pd.to_numeric(out["src_ls_index"], errors="coerce")
    out["dst_ls_index"] = pd.to_numeric(out["dst_ls_index"], errors="coerce")
    out["internal_target"] = out["internal_target"].fillna(False).astype(bool)
    out["provenance"] = out["provenance"].fillna("url_extract")
    # Backfill edge_id for rows that lack one.
    missing_id = out["edge_id"].isna() | (out["edge_id"].astype(str).str.strip() == "")
    if missing_id.any():
        out.loc[missing_id, "edge_id"] = out.loc[missing_id].apply(
            lambda r: _make_edge_id(r["src_tweet_id"], r["dst_tweet_id"], r["edge_kind"], r["provenance"]),
            axis=1,
        )
    out = out.drop_duplicates(subset=["edge_kind", "src_tweet_id", "dst_tweet_id"], keep="last")
    return out.reset_index(drop=True)


def _build_tweet_lookup(source_df: pd.DataFrame) -> dict[str, int]:
    mapping: dict[str, int] = {}
    for row in source_df.itertuples(index=False):
        tweet_id = str(row.id)
        if tweet_id not in mapping:
            mapping[tweet_id] = int(row.ls_index)
    return mapping


def _build_edges_for_sources(
    source_df: pd.DataFrame,
    *,
    tweet_id_to_ls_index: dict[str, int],
) -> pd.DataFrame:
    if source_df.empty:
        return _canonicalize_edges_df()

    edge_records: list[dict[str, Any]] = []
    seen_edges: set[tuple[str, str, str]] = set()

    for row in source_df.itertuples(index=False):
        src_tweet_id = str(row.id)
        src_ls_index = int(row.ls_index)

        dst_reply = _normalize_tweet_id(getattr(row, "in_reply_to_status_id", None))
        if dst_reply:
            key = ("reply", src_tweet_id, dst_reply)
            if key not in seen_edges:
                seen_edges.add(key)
                dst_ls = tweet_id_to_ls_index.get(dst_reply)
                provenance = "native_field"
                edge_records.append(
                    {
                        "edge_id": _make_edge_id(src_tweet_id, dst_reply, "reply", provenance),
                        "edge_kind": "reply",
                        "src_tweet_id": src_tweet_id,
                        "dst_tweet_id": dst_reply,
                        "src_ls_index": src_ls_index,
                        "dst_ls_index": int(dst_ls) if dst_ls is not None else None,
                        "internal_target": dst_ls is not None,
                        "provenance": provenance,
                        "source_url": None,
                    }
                )

        # Native-field quote edge (provenance: native_field)
        dst_quote_native = _normalize_tweet_id(getattr(row, "quoted_status_id", None))
        if dst_quote_native and dst_quote_native != src_tweet_id:
            key = ("quote", src_tweet_id, dst_quote_native)
            if key not in seen_edges:
                seen_edges.add(key)
                dst_ls = tweet_id_to_ls_index.get(dst_quote_native)
                provenance = "native_field"
                edge_records.append(
                    {
                        "edge_id": _make_edge_id(src_tweet_id, dst_quote_native, "quote", provenance),
                        "edge_kind": "quote",
                        "src_tweet_id": src_tweet_id,
                        "dst_tweet_id": dst_quote_native,
                        "src_ls_index": src_ls_index,
                        "dst_ls_index": int(dst_ls) if dst_ls is not None else None,
                        "internal_target": dst_ls is not None,
                        "provenance": provenance,
                        "source_url": None,
                    }
                )

        for raw_url in _parse_urls(getattr(row, "urls_json", "[]")):
            normalized_url = _normalize_url(raw_url)
            dst_quote = _extract_status_id(normalized_url)
            if not dst_quote or dst_quote == src_tweet_id:
                continue

            key = ("quote", src_tweet_id, dst_quote)
            if key in seen_edges:
                continue
            seen_edges.add(key)
            dst_ls = tweet_id_to_ls_index.get(dst_quote)
            provenance = "url_extract"
            edge_records.append(
                {
                    "edge_id": _make_edge_id(src_tweet_id, dst_quote, "quote", provenance),
                    "edge_kind": "quote",
                    "src_tweet_id": src_tweet_id,
                    "dst_tweet_id": dst_quote,
                    "src_ls_index": src_ls_index,
                    "dst_ls_index": int(dst_ls) if dst_ls is not None else None,
                    "internal_target": dst_ls is not None,
                    "provenance": provenance,
                    "source_url": normalized_url,
                }
            )

    return _canonicalize_edges_df(pd.DataFrame.from_records(edge_records))


def _refresh_edge_targets(
    edges_df: pd.DataFrame,
    *,
    tweet_id_to_ls_index: dict[str, int],
) -> pd.DataFrame:
    if edges_df.empty:
        return edges_df

    out = edges_df.copy()
    out["src_ls_index"] = out["src_tweet_id"].map(tweet_id_to_ls_index)
    out["dst_ls_index"] = out["dst_tweet_id"].map(tweet_id_to_ls_index)
    out["internal_target"] = out["dst_ls_index"].notna()
    return out


def _build_node_stats_df(
    *,
    edges_df: pd.DataFrame,
    tweet_id_to_ls_index: dict[str, int],
) -> pd.DataFrame:
    tweet_ids = set(tweet_id_to_ls_index.keys())

    reply_out_count: dict[str, int] = defaultdict(int)
    reply_in_count: dict[str, int] = defaultdict(int)
    quote_out_count: dict[str, int] = defaultdict(int)
    quote_in_count: dict[str, int] = defaultdict(int)
    parent_map: dict[str, str] = {}
    child_count_map: dict[str, int] = defaultdict(int)

    if not edges_df.empty:
        for row in edges_df.itertuples(index=False):
            if row.edge_kind == "reply":
                reply_out_count[row.src_tweet_id] += 1
                if row.dst_tweet_id in tweet_ids:
                    reply_in_count[row.dst_tweet_id] += 1
                    child_count_map[row.dst_tweet_id] += 1
                if row.src_tweet_id not in parent_map:
                    parent_map[row.src_tweet_id] = row.dst_tweet_id
            elif row.edge_kind == "quote":
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

    return pd.DataFrame.from_records(
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


def _write_lance_edges(dataset_dir: str, dataset_id: str, edges_df: pd.DataFrame) -> None:
    """Write edges DataFrame to a {dataset_id}__edges LanceDB table (full replace)."""
    import lancedb

    db_uri = os.path.join(dataset_dir, "lancedb")
    os.makedirs(db_uri, exist_ok=True)
    db = lancedb.connect(db_uri)
    table_name = f"{dataset_id}__edges"

    if edges_df.empty:
        # Drop if it exists, then bail
        try:
            db.drop_table(table_name, ignore_missing=True)
        except TypeError:
            # older lancedb without ignore_missing
            pass
        print(f"No edges to write to LanceDB table '{table_name}'")
        return

    # Ensure clean types for LanceDB (no nullable int columns — fill with -1)
    write_df = edges_df.copy()
    for col in ("src_ls_index", "dst_ls_index"):
        write_df[col] = pd.to_numeric(write_df[col], errors="coerce").fillna(-1).astype(int)

    tbl = db.create_table(table_name, write_df, mode="overwrite")

    tbl.create_scalar_index("src_tweet_id", index_type="BTREE")
    tbl.create_scalar_index("dst_tweet_id", index_type="BTREE")
    tbl.create_scalar_index("edge_kind", index_type="BITMAP")
    tbl.create_scalar_index("internal_target", index_type="BITMAP")

    print(f"LanceDB: wrote {len(write_df)} edges to '{table_name}' with indexes")


def _write_lance_node_stats(dataset_dir: str, dataset_id: str, node_stats_df: pd.DataFrame) -> None:
    """Write node_stats DataFrame to a {dataset_id}__node_stats LanceDB table (full replace)."""
    import lancedb

    db_uri = os.path.join(dataset_dir, "lancedb")
    os.makedirs(db_uri, exist_ok=True)
    db = lancedb.connect(db_uri)
    table_name = f"{dataset_id}__node_stats"

    if node_stats_df.empty:
        try:
            db.drop_table(table_name, ignore_missing=True)
        except TypeError:
            pass
        print(f"No node stats to write to LanceDB table '{table_name}'")
        return

    tbl = db.create_table(table_name, node_stats_df, mode="overwrite")

    tbl.create_scalar_index("tweet_id", index_type="BTREE")
    tbl.create_scalar_index("ls_index", index_type="BTREE")
    tbl.create_scalar_index("thread_root_id", index_type="BTREE")

    print(f"LanceDB: wrote {len(node_stats_df)} node stats to '{table_name}' with indexes")


def build_links_graph(
    dataset_id: str,
    *,
    scope_id: str | None = None,
    data_dir: str | None = None,
    incremental: bool = False,
    changed_tweet_ids: list[str] | None = None,
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
    tweet_id_to_ls_index = _build_tweet_lookup(source_df)
    tweet_ids = set(tweet_id_to_ls_index.keys())

    normalized_changed_ids = {
        normalized
        for normalized in (
            _normalize_tweet_id(value)
            for value in (changed_tweet_ids or [])
        )
        if normalized
    }

    # Scope-specific link builds are always rebuilt from scratch.
    incremental_requested = bool(incremental and normalized_changed_ids and not scope_id)
    incremental_used = False

    links_dir = os.path.join(dataset_dir, "links")
    os.makedirs(links_dir, exist_ok=True)
    edges_path = os.path.join(links_dir, "edges.parquet")

    if incremental_requested and os.path.exists(edges_path):
        existing_edges_raw = pd.read_parquet(edges_path)
        existing_edges = _canonicalize_edges_df(existing_edges_raw)

        # Safety valve: if a non-empty legacy artifact cannot be canonicalized,
        # do a full rebuild instead of silently dropping unrelated edges.
        if not existing_edges_raw.empty and existing_edges.empty:
            print(
                "WARNING: Existing links artifact could not be canonicalized for incremental merge; "
                "falling back to full rebuild."
            )
            edges_df = _build_edges_for_sources(source_df, tweet_id_to_ls_index=tweet_id_to_ls_index)
        else:
            existing_edges = existing_edges[existing_edges["src_tweet_id"].isin(tweet_ids)].copy()

            impacted_source_ids = {tweet_id for tweet_id in normalized_changed_ids if tweet_id in tweet_ids}
            if not existing_edges.empty:
                impacted_from_targets = existing_edges[
                    existing_edges["dst_tweet_id"].isin(normalized_changed_ids)
                ]["src_tweet_id"].tolist()
                impacted_source_ids.update(impacted_from_targets)

            if impacted_source_ids:
                impacted_source_df = source_df[source_df["id"].isin(impacted_source_ids)].copy()
                recomputed_edges = _build_edges_for_sources(
                    impacted_source_df,
                    tweet_id_to_ls_index=tweet_id_to_ls_index,
                )
                preserved_edges = existing_edges[
                    ~existing_edges["src_tweet_id"].isin(impacted_source_ids)
                ].copy()
                edges_df = _canonicalize_edges_df(pd.concat([preserved_edges, recomputed_edges], ignore_index=True))
            else:
                edges_df = existing_edges
            incremental_used = True
    else:
        edges_df = _build_edges_for_sources(source_df, tweet_id_to_ls_index=tweet_id_to_ls_index)

    edges_df = _refresh_edge_targets(edges_df, tweet_id_to_ls_index=tweet_id_to_ls_index)
    edges_df = edges_df[edges_df["src_tweet_id"].isin(tweet_ids)].copy().reset_index(drop=True)
    node_stats_df = _build_node_stats_df(edges_df=edges_df, tweet_id_to_ls_index=tweet_id_to_ls_index)

    node_stats_path = os.path.join(links_dir, "node_link_stats.parquet")
    meta_path = os.path.join(links_dir, "meta.json")

    edges_df.to_parquet(edges_path, index=False)
    node_stats_df.to_parquet(node_stats_path, index=False)

    # Write to LanceDB (dataset-global only, not scope-specific builds)
    if not scope_id:
        try:
            _write_lance_edges(dataset_dir, dataset_id, edges_df)
            _write_lance_node_stats(dataset_dir, dataset_id, node_stats_df)
        except Exception as e:
            print(f"WARNING: LanceDB write failed (parquet artifacts are fine): {e}")

    edge_kind_counts = {
        "reply": int((edges_df["edge_kind"] == "reply").sum()) if not edges_df.empty else 0,
        "quote": int((edges_df["edge_kind"] == "quote").sum()) if not edges_df.empty else 0,
    }

    if edges_df.empty:
        internal_mask = pd.Series(dtype=bool)
    else:
        internal_mask = edges_df["src_ls_index"].notna() & edges_df["dst_ls_index"].notna()

    internal_edge_kind_counts = {
        "reply": int(((edges_df["edge_kind"] == "reply") & internal_mask).sum()) if not edges_df.empty else 0,
        "quote": int(((edges_df["edge_kind"] == "quote") & internal_mask).sum()) if not edges_df.empty else 0,
    }
    internal_internal_count = int(internal_mask.sum()) if not edges_df.empty else 0

    meta = {
        "dataset_id": dataset_id,
        "scope_id": scope_id,
        "schema_version": "links-v2",
        "built_at": datetime.now(timezone.utc).isoformat(),
        "ls_version": __version__,
        "nodes": int(len(node_stats_df)),
        "edges": int(len(edges_df)),
        "edge_kind_counts": edge_kind_counts,
        "internal_edge_kind_counts": internal_edge_kind_counts,
        "internal_edges": internal_internal_count,
        "internal_internal_edges": internal_internal_count,
        "incremental_requested": bool(incremental_requested),
        "incremental": bool(incremental_used),
        "changed_tweet_ids_count": int(len(normalized_changed_ids)),
    }

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return {
        "dataset_id": dataset_id,
        "scope_id": scope_id,
        "nodes": int(len(node_stats_df)),
        "edges": int(len(edges_df)),
        "edge_kind_counts": edge_kind_counts,
        "internal_edge_kind_counts": internal_edge_kind_counts,
        "internal_edges": internal_internal_count,
        "links_dir": links_dir,
        "edges_path": edges_path,
        "node_stats_path": node_stats_path,
        "meta_path": meta_path,
        "incremental_requested": bool(incremental_requested),
        "incremental": bool(incremental_used),
        "changed_tweet_ids_count": int(len(normalized_changed_ids)),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build reply/quote link graph artifacts for a dataset")
    parser.add_argument("dataset_id", type=str, help="Dataset identifier")
    parser.add_argument("--scope_id", type=str, default=None, help="Optional scope id to restrict links")
    parser.add_argument("--data_dir", type=str, default=None, help="Override LATENT_SCOPE_DATA directory")
    parser.add_argument(
        "--incremental",
        action="store_true",
        help="Incrementally rebuild links for changed tweet ids when prior artifacts exist",
    )
    parser.add_argument(
        "--changed_tweet_id",
        action="append",
        default=[],
        help="Tweet id changed in this import batch (repeat flag for multiple ids)",
    )
    args = parser.parse_args()

    result = build_links_graph(
        args.dataset_id,
        scope_id=args.scope_id,
        data_dir=args.data_dir,
        incremental=args.incremental,
        changed_tweet_ids=args.changed_tweet_id,
    )

    print(f"DATASET_ID: {result['dataset_id']}")
    if result.get("scope_id"):
        print(f"SCOPE_ID: {result['scope_id']}")
    print(f"NODES: {result['nodes']}")
    print(f"EDGES: {result['edges']}")
    print(f"REPLY_EDGES: {result['edge_kind_counts']['reply']}")
    print(f"QUOTE_EDGES: {result['edge_kind_counts']['quote']}")
    print(f"INCREMENTAL: {result['incremental']}")
    print(f"LINKS_DIR: {result['links_dir']}")


if __name__ == "__main__":
    main()
