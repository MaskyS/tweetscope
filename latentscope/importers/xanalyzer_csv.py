"""Tweetscope importer for X_Account_Analyzer CSV exports.

Reads the ``detailed.csv`` files produced by X_Account_Analyzer and normalizes
them into tweetscope's ImportResult schema.  This lets you:

  1. Scan accounts with X_Account_Analyzer (quantitative analytics)
  2. Import the results into tweetscope (visual topic exploration)

Usage (standalone)::

    from tweetscope_importers.xanalyzer_csv import load_xanalyzer_csv

Usage (inside tweetscope)::

    from latentscope.importers.xanalyzer_csv import load_xanalyzer_csv

    result = load_xanalyzer_csv("output/20260315_scan/detailed.csv")
    # result.profile  -> inferred from CSV data + optional summary.csv
    # result.rows     -> list of dicts matching tweetscope's flat tweet schema
    # result.source   -> "xanalyzer_csv"

Supported CSV columns (from X_Account_Analyzer's Tweet dataclass):
    date, handle, text, url, post_type, views, likes, rts, replies,
    quotes, engagement, sentiment_score, sentiment_label, author_unverified

Also supports the ``summary.csv`` format for profile-level metadata.
"""

from __future__ import annotations

import csv
import html as _html
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

# ---------------------------------------------------------------------------
# Shared types — use tweetscope's ImportResult when available, otherwise
# define a compatible local version for standalone usage.
# ---------------------------------------------------------------------------
try:
    from latentscope.importers.twitter import ImportResult
except ImportError:

    @dataclass
    class ImportResult:  # type: ignore[no-redef]
        """Normalized import payload ready for tabular ingestion."""

        profile: dict[str, Any]
        rows: list[dict[str, Any]]
        source: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_SOURCE = "xanalyzer_csv"


def _to_int(value: Any, default: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _to_float(value: Any, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _parse_date(value: Any) -> datetime | None:
    """Parse dates from X_Account_Analyzer CSV (ISO 8601 format)."""
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    # ISO 8601 with timezone
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        pass
    # Twitter's native format: "Thu Jan 22 12:32:00 +0000 2026"
    try:
        return datetime.strptime(text, "%a %b %d %H:%M:%S %z %Y")
    except ValueError:
        pass
    # Simple date: "2026-01-22"
    try:
        return datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        return None


def _extract_tweet_id_from_url(url: str) -> str:
    """Extract tweet ID from a Twitter/X URL."""
    if not url:
        return ""
    # Match: https://x.com/user/status/1234567890
    match = re.search(r"/status/(\d+)", url)
    if match:
        return match.group(1)
    return ""


def _post_type_to_flags(post_type: str) -> tuple[bool, bool]:
    """Convert X_Account_Analyzer post_type to (is_reply, is_retweet) flags."""
    pt = str(post_type).lower().strip()
    is_reply = pt == "reply"
    is_retweet = pt in ("retweet", "rt")
    return is_reply, is_retweet


def _flatten_xanalyzer_row(
    row: dict[str, str],
    fallback_username: str | None = None,
) -> dict[str, Any]:
    """Convert an X_Account_Analyzer detailed CSV row to tweetscope flat schema."""
    handle = (
        row.get("handle")
        or row.get("username")
        or row.get("userName")
        or fallback_username
        or ""
    )
    handle = handle.lstrip("@").strip()

    text_raw = str(row.get("text") or "")
    text = _html.unescape(text_raw)

    url = row.get("url") or ""
    tweet_id = _extract_tweet_id_from_url(url)

    dt = _parse_date(row.get("date") or row.get("created_at"))
    created_at_iso = dt.isoformat() if dt else row.get("date")

    post_type = row.get("post_type") or "original"
    is_reply, is_retweet = _post_type_to_flags(post_type)

    # Also detect retweets by text prefix if post_type not set
    if not is_retweet and text.startswith("RT @"):
        is_retweet = True

    # Extract URLs from text (simple heuristic)
    urls_in_text = re.findall(r"https?://\S+", text)

    return {
        "id": tweet_id,
        "liked_tweet_id": None,
        "text": text,
        "text_raw": text_raw,
        "created_at": created_at_iso,
        "created_at_raw": row.get("date"),
        "favorites": _to_int(row.get("likes")),
        "retweets": _to_int(row.get("rts") or row.get("retweets")),
        "replies": _to_int(row.get("replies")),
        "quotes": _to_int(row.get("quotes")),
        "views": _to_int(row.get("views")),
        "engagement": _to_int(row.get("engagement")),
        "lang": None,
        "source": None,
        "username": handle,
        "display_name": None,
        "in_reply_to_status_id": None,
        "in_reply_to_screen_name": None,
        "quoted_status_id": None,
        "conversation_id": None,
        "is_reply": is_reply,
        "is_retweet": is_retweet,
        "is_like": False,
        "urls_json": json.dumps(urls_in_text, ensure_ascii=False) if urls_in_text else "[]",
        "media_urls_json": "[]",
        "url_entities_json": "[]",
        "tweet_type": "tweet",
        "archive_source": _SOURCE,
        "note_tweet_id": None,
        # Extra fields from X_Account_Analyzer (preserved for downstream use)
        "sentiment_score": _to_float(row.get("sentiment_score")),
        "sentiment_label": row.get("sentiment_label") or "",
        "post_type_original": post_type,
        "tweet_url": url,
    }


def _infer_profile_from_rows(
    rows: list[dict[str, Any]],
    summary_data: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build a profile dict from CSV data."""
    # Find the most common username
    usernames: dict[str, int] = {}
    for row in rows:
        u = row.get("username") or ""
        if u:
            usernames[u] = usernames.get(u, 0) + 1

    primary_username = ""
    if usernames:
        primary_username = max(usernames, key=lambda k: usernames[k])

    profile: dict[str, Any] = {
        "username": primary_username,
        "display_name": None,
        "account_id": None,
        "created_at": None,
        "bio": "",
        "website": "",
        "location": "",
        "avatar_url": None,
        "header_url": None,
    }

    # Enrich from summary.csv if available
    if summary_data:
        profile["followers"] = _to_int(summary_data.get("followers"))
        profile["display_name"] = (
            summary_data.get("name") or summary_data.get("display_name")
        )

    return profile


def _load_summary_for_handle(
    summary_path: str,
    handle: str | None = None,
) -> dict[str, str] | None:
    """Try to load matching row from summary.csv."""
    if not os.path.isfile(summary_path):
        return None
    try:
        with open(summary_path, "r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                row_handle = (row.get("handle") or "").lstrip("@").strip().lower()
                if handle is None or row_handle == handle.lower():
                    return dict(row)
    except (OSError, csv.Error):
        pass
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def load_xanalyzer_csv(
    detailed_csv_path: str,
    *,
    summary_csv_path: str | None = None,
    username: str | None = None,
) -> ImportResult:
    """Load an X_Account_Analyzer detailed.csv into tweetscope format.

    Args:
        detailed_csv_path: Path to the detailed.csv file.
        summary_csv_path: Optional path to summary.csv for profile enrichment.
            If not provided, looks for summary.csv in the same directory.
        username: Override/filter username (useful when CSV contains multiple
            handles).

    Returns:
        ImportResult with normalized rows.

    Raises:
        FileNotFoundError: If the CSV file doesn't exist.
        ValueError: If the CSV has no recognizable columns.
    """
    if not os.path.isfile(detailed_csv_path):
        raise FileNotFoundError(f"CSV not found: {detailed_csv_path}")

    # Auto-discover summary.csv
    if summary_csv_path is None:
        csv_dir = os.path.dirname(detailed_csv_path)
        for candidate in ("summary.csv", "summary_results.csv"):
            path = os.path.join(csv_dir, candidate)
            if os.path.isfile(path):
                summary_csv_path = path
                break

    # Read detailed CSV
    rows: list[dict[str, Any]] = []
    with open(detailed_csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise ValueError(f"CSV has no headers: {detailed_csv_path}")

        # Validate that this looks like an X_Account_Analyzer export
        known_fields = {
            "text", "handle", "date", "likes", "views", "url",
            "post_type", "rts", "replies", "engagement",
            "sentiment_score", "sentiment_label",
        }
        found_fields = set(reader.fieldnames) & known_fields
        if len(found_fields) < 3:
            raise ValueError(
                f"CSV doesn't look like an X_Account_Analyzer detailed export. "
                f"Found columns: {reader.fieldnames}"
            )

        for csv_row in reader:
            row = _flatten_xanalyzer_row(csv_row, fallback_username=username)
            # Filter by username if specified
            if username and row["username"].lower() != username.lstrip("@").lower():
                continue
            rows.append(row)

    if not rows:
        raise ValueError(f"No tweet rows found in {detailed_csv_path}")

    # Build profile
    summary_data = None
    if summary_csv_path:
        inferred_handle = username or (rows[0]["username"] if rows else None)
        summary_data = _load_summary_for_handle(summary_csv_path, inferred_handle)

    profile = _infer_profile_from_rows(rows, summary_data)

    # Override username if provided
    if username:
        profile["username"] = username.lstrip("@").strip()

    return ImportResult(profile=profile, rows=rows, source=_SOURCE)
