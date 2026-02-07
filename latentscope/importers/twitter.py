"""Helpers for importing Twitter/X archive data into Latent Scope."""

from __future__ import annotations

import json
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.error import HTTPError
from urllib.request import urlopen


COMMUNITY_ARCHIVE_BLOB_BASE = (
    "https://fabxmporizzqflnftavs.supabase.co/storage/v1/object/public/archives"
)


@dataclass
class ImportResult:
    """Normalized import payload ready for tabular ingestion."""

    profile: dict[str, Any]
    rows: list[dict[str, Any]]
    source: str


def _parse_ytd_js_payload(raw_text: str) -> Any:
    """
    Parse Twitter/X archive JS payload files shaped like:
      window.YTD.tweets.part0 = [ ... ];
    """
    text = raw_text.strip()
    equals_idx = text.find("=")
    if equals_idx < 0:
        raise ValueError("Invalid YTD payload: missing assignment")
    payload = text[equals_idx + 1 :].strip()
    if payload.endswith(";"):
        payload = payload[:-1].strip()
    return json.loads(payload)


def _to_int(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_date_any(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value

    text = str(value).strip()
    if not text:
        return None

    # Native tweet date format: Thu Jan 22 12:32:00 +0000 2026
    try:
        return datetime.strptime(text, "%a %b %d %H:%M:%S %z %Y")
    except ValueError:
        pass

    # ISO date format with optional Z suffix.
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _extract_profile_from_native(account_data: Any, profile_data: Any) -> dict[str, Any]:
    account = {}
    if isinstance(account_data, list) and account_data:
        account = account_data[0].get("account", {})
    elif isinstance(account_data, dict):
        account = account_data.get("account", account_data)

    profile = {}
    if isinstance(profile_data, list) and profile_data:
        profile = profile_data[0].get("profile", {})
    elif isinstance(profile_data, dict):
        profile = profile_data.get("profile", profile_data)

    return {
        "username": account.get("username"),
        "display_name": account.get("accountDisplayName"),
        "account_id": account.get("accountId"),
        "created_at": account.get("createdAt"),
        "bio": profile.get("description", {}).get("bio", ""),
        "website": profile.get("description", {}).get("website", ""),
        "location": profile.get("description", {}).get("location", ""),
        "avatar_url": profile.get("avatarMediaUrl"),
        "header_url": profile.get("headerMediaUrl"),
    }


def _flatten_tweet(
    tweet_obj: dict[str, Any],
    username: str | None = None,
    display_name: str | None = None,
    source: str = "x_native",
) -> dict[str, Any]:
    t = tweet_obj.get("tweet", tweet_obj)
    dt = _parse_date_any(t.get("created_at"))
    created_at_iso = dt.isoformat() if dt else None
    text = t.get("full_text") or t.get("text") or ""

    # We rely on content text for t.co parsing in the web client.
    # Keep auxiliary URL fields as serialized JSON strings.
    urls = []
    for url in t.get("entities", {}).get("urls", []) or []:
        expanded = url.get("expanded_url")
        if expanded:
            urls.append(expanded)

    media_urls = []
    for media in t.get("extended_entities", {}).get("media", []) or []:
        media_url = media.get("media_url_https") or media.get("media_url")
        if media_url:
            media_urls.append(media_url)

    is_reply = bool(t.get("in_reply_to_status_id_str") or t.get("in_reply_to_status_id"))
    is_retweet = bool(t.get("retweeted_status")) or str(text).startswith("RT @")

    return {
        "id": str(t.get("id_str") or t.get("id") or ""),
        "liked_tweet_id": None,
        "text": str(text),
        "created_at": created_at_iso or t.get("created_at"),
        "created_at_raw": t.get("created_at"),
        "favorites": _to_int(t.get("favorite_count")),
        "retweets": _to_int(t.get("retweet_count")),
        "replies": _to_int(t.get("reply_count")),
        "lang": t.get("lang"),
        "source": t.get("source"),
        "username": username or t.get("user", {}).get("screen_name"),
        "display_name": display_name,
        "in_reply_to_status_id": t.get("in_reply_to_status_id_str") or t.get("in_reply_to_status_id"),
        "in_reply_to_screen_name": t.get("in_reply_to_screen_name"),
        "is_reply": is_reply,
        "is_retweet": is_retweet,
        "is_like": False,
        "urls_json": json.dumps(urls, ensure_ascii=False) if urls else "[]",
        "media_urls_json": json.dumps(media_urls, ensure_ascii=False) if media_urls else "[]",
        "tweet_type": "tweet",
        "archive_source": source,
    }


def _flatten_note_tweet(
    note_obj: dict[str, Any],
    username: str | None = None,
    display_name: str | None = None,
    source: str = "x_native",
) -> dict[str, Any] | None:
    note = note_obj.get("noteTweet", note_obj)
    core = note.get("core", {})
    text = core.get("text", "")
    if not text:
        return None

    dt = _parse_date_any(note.get("createdAt"))
    created_at_iso = dt.isoformat() if dt else None

    urls = []
    for url in core.get("urls", []) or []:
        expanded = url.get("expandedUrl")
        if expanded:
            urls.append(expanded)

    return {
        "id": str(note.get("noteTweetId") or ""),
        "liked_tweet_id": None,
        "text": str(text),
        "created_at": created_at_iso or note.get("createdAt"),
        "created_at_raw": note.get("createdAt"),
        "favorites": 0,
        "retweets": 0,
        "replies": 0,
        "lang": None,
        "source": None,
        "username": username,
        "display_name": display_name,
        "in_reply_to_status_id": None,
        "in_reply_to_screen_name": None,
        "is_reply": False,
        "is_retweet": False,
        "is_like": False,
        "urls_json": json.dumps(urls, ensure_ascii=False) if urls else "[]",
        "media_urls_json": "[]",
        "tweet_type": "note_tweet",
        "archive_source": source,
    }


def _flatten_like(
    like_obj: dict[str, Any],
    username: str | None = None,
    display_name: str | None = None,
    source: str = "x_native",
) -> dict[str, Any] | None:
    like = like_obj.get("like", like_obj)
    tweet_id = like.get("tweetId") or like.get("tweet_id") or like.get("id_str") or like.get("id")
    if not tweet_id:
        return None

    expanded_url = like.get("expandedUrl") or like.get("expanded_url")
    full_text = like.get("fullText") or like.get("full_text") or like.get("text") or ""
    text = str(full_text).strip()
    if not text:
        text = str(expanded_url or f"Liked tweet {tweet_id}")

    urls = []
    if expanded_url:
        urls.append(expanded_url)

    return {
        "id": f"like-{tweet_id}",
        "liked_tweet_id": str(tweet_id),
        "text": text,
        "created_at": like.get("createdAt") or like.get("created_at"),
        "created_at_raw": like.get("createdAt") or like.get("created_at"),
        "favorites": 0,
        "retweets": 0,
        "replies": 0,
        "lang": None,
        "source": None,
        "username": username,
        "display_name": display_name,
        "in_reply_to_status_id": None,
        "in_reply_to_screen_name": None,
        "is_reply": False,
        "is_retweet": False,
        "is_like": True,
        "urls_json": json.dumps(urls, ensure_ascii=False) if urls else "[]",
        "media_urls_json": "[]",
        "tweet_type": "like",
        "archive_source": source,
    }


def load_native_x_archive_zip(zip_path: str) -> ImportResult:
    """Load and normalize a native X export archive zip."""
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = set(zf.namelist())

        if "data/tweets.js" not in names:
            raise ValueError("Invalid X archive zip: expected data/tweets.js")

        account_raw = _parse_ytd_js_payload(
            zf.read("data/account.js").decode("utf-8")
        ) if "data/account.js" in names else []
        profile_raw = _parse_ytd_js_payload(
            zf.read("data/profile.js").decode("utf-8")
        ) if "data/profile.js" in names else []
        tweets_raw = _parse_ytd_js_payload(zf.read("data/tweets.js").decode("utf-8"))
        notes_raw = _parse_ytd_js_payload(
            zf.read("data/note-tweet.js").decode("utf-8")
        ) if "data/note-tweet.js" in names else []
        likes_raw = _parse_ytd_js_payload(
            zf.read("data/like.js").decode("utf-8")
        ) if "data/like.js" in names else []

    profile = _extract_profile_from_native(account_raw, profile_raw)
    username = profile.get("username")
    display_name = profile.get("display_name")

    rows: list[dict[str, Any]] = []
    for tw in tweets_raw:
        rows.append(_flatten_tweet(tw, username=username, display_name=display_name, source="x_native"))
    for nt in notes_raw:
        row = _flatten_note_tweet(nt, username=username, display_name=display_name, source="x_native")
        if row:
            rows.append(row)
    for lk in likes_raw:
        row = _flatten_like(lk, username=username, display_name=display_name, source="x_native")
        if row:
            rows.append(row)

    return ImportResult(profile=profile, rows=rows, source="x_native")


def _extract_profile_from_community_raw(raw_data: dict[str, Any], username: str) -> dict[str, Any]:
    account_data = {}
    if raw_data.get("account"):
        acc = raw_data["account"]
        if isinstance(acc, list) and acc:
            account_data = acc[0].get("account", {})
        elif isinstance(acc, dict):
            account_data = acc.get("account", acc)

    profile_data = {}
    if raw_data.get("profile"):
        prof = raw_data["profile"]
        if isinstance(prof, list) and prof:
            profile_data = prof[0].get("profile", {})
        elif isinstance(prof, dict):
            profile_data = prof.get("profile", prof)

    return {
        "username": account_data.get("username", username),
        "account_id": account_data.get("accountId"),
        "display_name": account_data.get("accountDisplayName"),
        "created_at": account_data.get("createdAt"),
        "bio": profile_data.get("description", {}).get("bio", ""),
        "website": profile_data.get("description", {}).get("website", ""),
        "location": profile_data.get("description", {}).get("location", ""),
        "avatar_url": profile_data.get("avatarMediaUrl"),
        "header_url": profile_data.get("headerMediaUrl"),
    }


def fetch_community_archive(username: str) -> dict[str, Any]:
    """Fetch raw community archive payload for a username."""
    url = f"{COMMUNITY_ARCHIVE_BLOB_BASE}/{username.lower()}/archive.json"
    try:
        with urlopen(url) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as err:
        if err.code == 404:
            raise ValueError(
                f"Community archive user '{username}' not found"
            ) from err
        raise


def load_community_archive_raw(raw_data: dict[str, Any], username: str) -> ImportResult:
    """Load and normalize raw community archive JSON payload."""
    profile = _extract_profile_from_community_raw(raw_data, username)
    normalized: list[dict[str, Any]] = []
    for tweet_obj in raw_data.get("tweets", []):
        normalized.append(
            _flatten_tweet(
                tweet_obj,
                username=profile.get("username"),
                display_name=profile.get("display_name"),
                source="community_archive",
            )
        )
    for like_obj in raw_data.get("likes", []):
        row = _flatten_like(
            like_obj,
            username=profile.get("username"),
            display_name=profile.get("display_name"),
            source="community_archive",
        )
        if row:
            normalized.append(row)
    return ImportResult(profile=profile, rows=normalized, source="community_archive")


def load_community_extracted_json(path: str) -> ImportResult:
    """
    Load output from scripts/twitter/download_community_archive.py --mode extract.
    Format:
      {"profile": {...}, "tweets": [...], "tweet_count": N}
    """
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    profile = payload.get("profile", {})
    username = profile.get("username")
    display_name = profile.get("display_name")

    rows = []
    for tweet in payload.get("tweets", []):
        rows.append(
            _flatten_tweet(
                tweet,
                username=username,
                display_name=display_name,
                source="community_archive",
            )
        )
    for like_obj in payload.get("likes", []):
        row = _flatten_like(
            like_obj,
            username=username,
            display_name=display_name,
            source="community_archive",
        )
        if row:
            rows.append(row)

    return ImportResult(profile=profile, rows=rows, source="community_archive")


def apply_filters(
    rows: list[dict[str, Any]],
    *,
    year: int | None = None,
    lang: str | None = None,
    min_favorites: int = 0,
    min_text_length: int = 0,
    exclude_replies: bool = False,
    exclude_retweets: bool = False,
    top_n: int | None = None,
    sort: str = "recent",
) -> list[dict[str, Any]]:
    """Apply common tweet filters and return sorted rows."""
    result: list[dict[str, Any]] = []

    for row in rows:
        text = row.get("text") or ""
        if min_text_length and len(text) < min_text_length:
            continue
        if lang and row.get("lang") != lang:
            continue
        if min_favorites and _to_int(row.get("favorites")) < min_favorites:
            continue
        if exclude_replies and row.get("is_reply"):
            continue
        if exclude_retweets and row.get("is_retweet"):
            continue
        if year is not None:
            dt = _parse_date_any(row.get("created_at"))
            if not dt or dt.year != year:
                continue
        result.append(row)

    if sort == "engagement":
        result.sort(key=lambda r: (_to_int(r.get("favorites")), _to_int(r.get("retweets"))), reverse=True)
    else:
        def _recent_sort_key(row: dict[str, Any]) -> float:
            dt = _parse_date_any(row.get("created_at"))
            if not dt:
                return float("-inf")
            try:
                return float(dt.timestamp())
            except Exception:
                return float("-inf")

        result.sort(key=_recent_sort_key, reverse=True)

    if top_n is not None and top_n > 0:
        return result[:top_n]
    return result


def sanitize_dataset_id(value: str) -> str:
    """Normalize dataset identifiers to safe slugs."""
    lowered = value.strip().lower()
    lowered = re.sub(r"[^a-z0-9_-]+", "-", lowered)
    lowered = re.sub(r"-{2,}", "-", lowered).strip("-")
    if not lowered:
        raise ValueError("Invalid dataset id")
    return lowered
