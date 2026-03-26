"""Import tweets from generic CSV files exported by Twitter/X tools.

Handles the common CSV column conventions used by Twitter/X analysis tools
and data export extensions (Chrome extensions, analytics platforms, etc.).
The importer auto-detects column names from several known variants and
normalises each row into the same flat dict produced by
:func:`latentscope.importers.twitter._flatten_tweet`.

Typical usage::

    from latentscope.importers.csv_import import load_csv

    result = load_csv("tweets.csv")
    # result.rows  -> list[dict] ready for DataFrame / ingest

Supports:
* Generic Twitter CSV exports with common column names
* Tab-separated files (auto-detected via csv.Sniffer)
* Flexible column alias matching (60+ known variants)
"""

from __future__ import annotations

import csv
import html as _html
import io
import json
from typing import Any

try:
    from latentscope.importers.twitter import ImportResult
except ImportError:  # standalone / test usage
    from dataclasses import dataclass

    @dataclass
    class ImportResult:  # type: ignore[no-redef]
        profile: dict[str, Any]
        rows: list[dict[str, Any]]
        source: str


_SOURCE = "csv_import"

# Maps canonical field names to known CSV column name variants (lowercase).
_COLUMN_ALIASES: dict[str, list[str]] = {
    "id": ["id", "tweet_id", "id_str", "status_id", "tweet id"],
    "text": ["text", "full_text", "tweet_text", "content", "tweet", "body", "tweet text", "full text"],
    "created_at": ["created_at", "date", "timestamp", "datetime", "created at", "time", "posted_at"],
    "username": ["username", "screen_name", "user", "handle", "user_screen_name", "author", "screen name"],
    "display_name": ["display_name", "name", "user_name", "author_name", "display name"],
    "favorites": ["favorites", "favorite_count", "likes", "like_count", "likecount", "favourite_count", "favorite count", "like count"],
    "retweets": ["retweets", "retweet_count", "rt_count", "retweetcount", "retweet count"],
    "replies": ["replies", "reply_count", "replycount", "reply count"],
    "lang": ["lang", "language"],
    "source": ["source", "client", "app"],
    "in_reply_to_status_id": ["in_reply_to_status_id", "in_reply_to_id", "reply_to_id", "in_reply_to_status_id_str"],
    "in_reply_to_screen_name": ["in_reply_to_screen_name", "reply_to_user", "in_reply_to_user"],
    "conversation_id": ["conversation_id", "conversation_id_str"],
    "quoted_status_id": ["quoted_status_id", "quoted_tweet_id", "quote_id"],
    "is_reply": ["is_reply"],
    "is_retweet": ["is_retweet", "is_rt"],
    "urls": ["urls", "url", "links", "expanded_url"],
    "media_urls": ["media_urls", "media_url", "media", "image_url", "photo_url"],
}


def _to_int(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    s = str(value).strip().lower()
    return s in ("true", "1", "yes", "t")


def _build_column_map(headers: list[str]) -> dict[str, str | None]:
    """Map canonical field names to actual CSV column names.

    Returns a dict ``{canonical_name: actual_column_name_or_None}``.
    """
    lower_to_actual: dict[str, str] = {}
    for h in headers:
        lower_to_actual[h.strip().lower()] = h

    mapping: dict[str, str | None] = {}
    for canonical, aliases in _COLUMN_ALIASES.items():
        mapping[canonical] = None
        for alias in aliases:
            if alias in lower_to_actual:
                mapping[canonical] = lower_to_actual[alias]
                break
    return mapping


def _parse_urls_field(value: str | None) -> list[str]:
    """Parse a URL field that may be JSON array, comma/space separated, or a single URL."""
    if not value or not str(value).strip():
        return []
    text = str(value).strip()
    # Try JSON array first
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(u) for u in parsed if u]
        except (json.JSONDecodeError, TypeError):
            pass
    # Comma or space separated
    for sep in (",", " "):
        if sep in text:
            parts = [p.strip() for p in text.split(sep) if p.strip()]
            if all(p.startswith("http") for p in parts):
                return parts
    # Single URL
    if text.startswith("http"):
        return [text]
    return []


def _flatten_csv_row(
    row: dict[str, str],
    col_map: dict[str, str | None],
    *,
    default_username: str | None = None,
    default_display_name: str | None = None,
) -> dict[str, Any] | None:
    """Normalise a single CSV row to the canonical schema."""

    def _get(canonical: str) -> str | None:
        actual = col_map.get(canonical)
        if actual is None:
            return None
        val = row.get(actual, "").strip()
        return val if val else None

    tweet_id = _get("id") or ""
    text_raw = _get("text") or ""
    if not tweet_id or not text_raw:
        return None

    text = _html.unescape(text_raw)

    # URL handling
    urls = _parse_urls_field(_get("urls"))
    media_urls = _parse_urls_field(_get("media_urls"))
    url_entities: list[dict[str, Any]] = []
    for u in urls:
        url_entities.append({
            "kind": "url",
            "url": None,
            "expanded_url": u,
            "display_url": None,
            "indices": None,
        })

    # Reply / retweet detection
    is_reply_field = _get("is_reply")
    is_retweet_field = _get("is_retweet")
    in_reply_to = _get("in_reply_to_status_id")
    is_reply = _to_bool(is_reply_field) if is_reply_field else bool(in_reply_to)
    is_retweet = _to_bool(is_retweet_field) if is_retweet_field else text.startswith("RT @")

    username = _get("username") or default_username
    display_name = _get("display_name") or default_display_name

    return {
        "id": str(tweet_id),
        "liked_tweet_id": None,
        "text": text,
        "text_raw": text_raw,
        "created_at": _get("created_at"),
        "created_at_raw": _get("created_at"),
        "favorites": _to_int(_get("favorites")),
        "retweets": _to_int(_get("retweets")),
        "replies": _to_int(_get("replies")),
        "lang": _get("lang"),
        "source": _get("source"),
        "username": username,
        "display_name": display_name,
        "in_reply_to_status_id": in_reply_to,
        "in_reply_to_screen_name": _get("in_reply_to_screen_name"),
        "quoted_status_id": _get("quoted_status_id"),
        "conversation_id": _get("conversation_id"),
        "is_reply": is_reply,
        "is_retweet": is_retweet,
        "is_like": False,
        "urls_json": json.dumps(urls, ensure_ascii=False) if urls else "[]",
        "media_urls_json": json.dumps(media_urls, ensure_ascii=False) if media_urls else "[]",
        "url_entities_json": json.dumps(url_entities, ensure_ascii=False) if url_entities else "[]",
        "tweet_type": "tweet",
        "archive_source": _SOURCE,
        "note_tweet_id": None,
    }


def load_csv(
    path: str,
    *,
    username: str | None = None,
    display_name: str | None = None,
    encoding: str = "utf-8",
) -> ImportResult:
    """Load tweets from a CSV file.

    Parameters
    ----------
    path
        Path to the CSV (or TSV) file.
    username
        Fallback username when the CSV does not contain a username column.
    display_name
        Fallback display name.
    encoding
        File encoding (default ``utf-8``).

    Returns
    -------
    ImportResult
        Normalised result with ``source="csv_import"``.
    """
    with open(path, "r", encoding=encoding, newline="") as fh:
        sample = fh.read(4096)
        fh.seek(0)

        # Auto-detect delimiter (CSV vs TSV)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
        except csv.Error:
            dialect = csv.excel  # type: ignore[assignment]

        reader = csv.DictReader(fh, dialect=dialect)
        headers = reader.fieldnames or []
        col_map = _build_column_map(headers)

        rows: list[dict[str, Any]] = []
        profile: dict[str, Any] = {}

        for csv_row in reader:
            row = _flatten_csv_row(
                csv_row,
                col_map,
                default_username=username,
                default_display_name=display_name,
            )
            if row is None:
                continue
            rows.append(row)

            # Build profile from first row that has a username
            if not profile and row.get("username"):
                profile = {
                    "username": row["username"],
                    "display_name": row.get("display_name"),
                }

    if username and not profile.get("username"):
        profile["username"] = username
    if display_name and not profile.get("display_name"):
        profile["display_name"] = display_name

    return ImportResult(profile=profile, rows=rows, source=_SOURCE)


def load_csv_string(
    content: str,
    *,
    username: str | None = None,
    display_name: str | None = None,
) -> ImportResult:
    """Load tweets from a CSV string (convenience for testing / in-memory data).

    Same as :func:`load_csv` but reads from a string rather than a file path.
    """
    # Auto-detect delimiter
    try:
        dialect = csv.Sniffer().sniff(content[:4096], delimiters=",\t;|")
    except csv.Error:
        dialect = csv.excel  # type: ignore[assignment]

    reader = csv.DictReader(io.StringIO(content), dialect=dialect)
    headers = reader.fieldnames or []
    col_map = _build_column_map(headers)

    rows: list[dict[str, Any]] = []
    profile: dict[str, Any] = {}

    for csv_row in reader:
        row = _flatten_csv_row(
            csv_row,
            col_map,
            default_username=username,
            default_display_name=display_name,
        )
        if row is None:
            continue
        rows.append(row)
        if not profile and row.get("username"):
            profile = {
                "username": row["username"],
                "display_name": row.get("display_name"),
            }

    if username and not profile.get("username"):
        profile["username"] = username
    if display_name and not profile.get("display_name"):
        profile["display_name"] = display_name

    return ImportResult(profile=profile, rows=rows, source=_SOURCE)
