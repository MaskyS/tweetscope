"""Tweetscope importer for twitterapi.io live API and saved JSON responses.

Fetches tweets for any public account via twitterapi.io and normalizes them
into the tweetscope ImportResult schema (same shape as twitter.py's
_flatten_tweet output).

Usage (live fetch)::

    from latentscope.importers.twitterapi_io import fetch_twitterapi_io

    result = fetch_twitterapi_io(
        username="elonmusk",
        api_key="your-twitterapi-io-key",
        max_pages=5,
    )
    # result.profile  -> dict with username, display_name, bio, etc.
    # result.rows     -> list of dicts matching tweetscope's flat tweet schema
    # result.source   -> "twitterapi_io"

Usage (saved JSON)::

    from latentscope.importers.twitterapi_io import load_twitterapi_io_json

    result = load_twitterapi_io_json("saved_response.json")
    # or pass an already-parsed dict/list:
    result = load_twitterapi_io_json({"tweets": [...]})

Environment:
    TWITTER_API_KEY: twitterapi.io API key (used if api_key param not provided)
"""

from __future__ import annotations

import html as _html
import json
import os
import time
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
# Constants
# ---------------------------------------------------------------------------
_SOURCE = "twitterapi_io"
_TWITTERAPI_IO_BASE = "https://api.twitterapi.io"
_USER_INFO_URL = f"{_TWITTERAPI_IO_BASE}/twitter/user/info"
_USER_TWEETS_URL = f"{_TWITTERAPI_IO_BASE}/twitter/user/last_tweets"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _to_int(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_date(value: Any) -> datetime | None:
    """Parse twitterapi.io date formats into datetime."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    text = str(value).strip()
    if not text:
        return None
    # twitterapi.io format: "Tue Dec 10 07:00:30 +0000 2024"
    try:
        return datetime.strptime(text, "%a %b %d %H:%M:%S %z %Y")
    except ValueError:
        pass
    # ISO format fallback
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _extract_urls(
    tweet: dict[str, Any],
) -> tuple[list[str], list[str], list[dict[str, Any]]]:
    """Extract URLs and media from twitterapi.io tweet entities."""
    urls: list[str] = []
    media_urls: list[str] = []
    url_entities: list[dict[str, Any]] = []

    entities = tweet.get("entities") or {}
    for url_obj in entities.get("urls", []) or []:
        expanded = url_obj.get("expanded_url")
        short = url_obj.get("url")
        display = url_obj.get("display_url")
        if expanded:
            urls.append(str(expanded))
        url_entities.append({
            "kind": "url",
            "url": str(short) if short else None,
            "expanded_url": str(expanded) if expanded else None,
            "display_url": str(display) if display else None,
            "indices": url_obj.get("indices") if isinstance(url_obj.get("indices"), list) else None,
        })

    # twitterapi.io may embed media in entities.media or extendedEntities.media
    for source_key in ("entities", "extendedEntities"):
        for media_obj in (tweet.get(source_key) or {}).get("media", []) or []:
            media_url = media_obj.get("media_url_https") or media_obj.get("media_url")
            short = media_obj.get("url")
            expanded = media_obj.get("expanded_url")
            display = media_obj.get("display_url")
            if media_url and str(media_url) not in media_urls:
                media_urls.append(str(media_url))
            url_entities.append({
                "kind": "media",
                "url": str(short) if short else None,
                "expanded_url": str(expanded) if expanded else None,
                "display_url": str(display) if display else None,
                "media_url": str(media_url) if media_url else None,
                "media_type": media_obj.get("type"),
                "indices": media_obj.get("indices") if isinstance(media_obj.get("indices"), list) else None,
            })

    # Deduplicate URLs
    urls = list(dict.fromkeys(urls))
    media_urls = list(dict.fromkeys(media_urls))
    return urls, media_urls, url_entities


def _build_profile(user_data: dict[str, Any]) -> dict[str, Any]:
    """Convert twitterapi.io user info to tweetscope profile dict."""
    if not user_data or not isinstance(user_data, dict):
        return {}
    return {
        "username": user_data.get("userName") or user_data.get("username"),
        "display_name": user_data.get("name"),
        "account_id": user_data.get("id"),
        "created_at": user_data.get("createdAt"),
        "bio": user_data.get("description", ""),
        "website": "",
        "location": user_data.get("location", ""),
        "avatar_url": user_data.get("profilePicture"),
        "header_url": user_data.get("coverPicture"),
        "followers": _to_int(user_data.get("followers")),
        "following": _to_int(user_data.get("following")),
        "statuses_count": _to_int(user_data.get("statusesCount")),
        "is_verified": bool(user_data.get("isBlueVerified")),
    }


def _flatten_twitterapi_io_tweet(
    tweet: dict[str, Any],
    fallback_username: str | None = None,
    fallback_display_name: str | None = None,
) -> dict[str, Any]:
    """Convert a twitterapi.io tweet object to tweetscope's flat row schema."""
    author = tweet.get("author") or {}
    username = author.get("userName") or fallback_username
    display_name = author.get("name") or fallback_display_name

    dt = _parse_date(tweet.get("createdAt") or tweet.get("created_at"))
    created_at_iso = dt.isoformat() if dt else None

    text_raw = str(tweet.get("text") or "")
    text = _html.unescape(text_raw)

    urls, media_urls, url_entities = _extract_urls(tweet)

    # Replace t.co links in text with expanded URLs
    for ue in url_entities:
        token = ue.get("url")
        replacement = ue.get("expanded_url") or ue.get("media_url") or ue.get("display_url")
        if token and replacement and "t.co/" in str(token) and token in text:
            text = text.replace(str(token), str(replacement))

    is_reply = bool(tweet.get("isReply") or tweet.get("inReplyToId"))
    is_retweet = bool(tweet.get("retweeted_tweet")) or text.startswith("RT @")

    # Quoted tweet ID
    quoted_tweet = tweet.get("quoted_tweet") or {}
    quoted_status_id = quoted_tweet.get("id") if isinstance(quoted_tweet, dict) else None

    return {
        "id": str(tweet.get("id") or ""),
        "liked_tweet_id": None,
        "text": text,
        "text_raw": text_raw,
        "created_at": created_at_iso or tweet.get("createdAt"),
        "created_at_raw": tweet.get("createdAt"),
        "favorites": _to_int(tweet.get("likeCount")),
        "retweets": _to_int(tweet.get("retweetCount")),
        "replies": _to_int(tweet.get("replyCount")),
        "quotes": _to_int(tweet.get("quoteCount")),
        "views": _to_int(tweet.get("viewCount")),
        "bookmarks": _to_int(tweet.get("bookmarkCount")),
        "lang": tweet.get("lang"),
        "source": tweet.get("source"),
        "username": username,
        "display_name": display_name,
        "in_reply_to_status_id": tweet.get("inReplyToId"),
        "in_reply_to_screen_name": tweet.get("inReplyToUsername"),
        "quoted_status_id": quoted_status_id,
        "conversation_id": tweet.get("conversationId"),
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


# ---------------------------------------------------------------------------
# HTTP helpers (pure stdlib — no dependency on requests)
# ---------------------------------------------------------------------------
def _api_request(
    url: str,
    params: dict[str, str],
    api_key: str,
    timeout: int = 30,
    retries: int = 3,
) -> dict[str, Any] | None:
    """Make an authenticated GET request to twitterapi.io with retries."""
    import urllib.error
    import urllib.parse
    import urllib.request

    query_string = urllib.parse.urlencode(params)
    full_url = f"{url}?{query_string}"
    headers = {
        "X-API-Key": api_key,
    }

    for attempt in range(retries):
        try:
            req = urllib.request.Request(full_url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = min(2 ** attempt * 2, 30)
                time.sleep(wait)
                continue
            if e.code in (401, 403):
                raise ValueError(
                    f"Authentication failed (HTTP {e.code}). Check your API key."
                ) from e
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries - 1:
                return None
            time.sleep(2 ** attempt)
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def fetch_twitterapi_io(
    username: str,
    api_key: str | None = None,
    *,
    max_pages: int = 10,
    include_replies: bool = True,
    include_retweets: bool = True,
    timeout: int = 30,
) -> ImportResult:
    """Fetch all available tweets for a user via twitterapi.io.

    Args:
        username: Twitter/X handle (without @).
        api_key: twitterapi.io API key. Falls back to TWITTER_API_KEY env var.
        max_pages: Maximum pagination pages to fetch (20 tweets per page).
        include_replies: Whether to include reply tweets.
        include_retweets: Whether to include retweets.
        timeout: HTTP request timeout in seconds.

    Returns:
        ImportResult with profile, rows, and source="twitterapi_io".

    Raises:
        ValueError: If no API key is provided or auth fails.
    """
    api_key = api_key or os.environ.get("TWITTER_API_KEY")
    if not api_key:
        raise ValueError(
            "twitterapi.io API key required. Pass api_key= or set TWITTER_API_KEY env var."
        )

    username = username.lstrip("@").strip()
    if not username:
        raise ValueError("Username is required")

    # 1) Fetch user profile
    user_resp = _api_request(
        _USER_INFO_URL,
        {"userName": username},
        api_key,
        timeout=timeout,
    )
    if not user_resp or user_resp.get("status") != "success":
        raise ValueError(
            f"Failed to fetch user info for @{username}: "
            f"{(user_resp or {}).get('msg', 'unknown error')}"
        )

    user_data = user_resp.get("data", {})
    profile = _build_profile(user_data)

    # 2) Paginate through tweets
    rows: list[dict[str, Any]] = []
    cursor: str | None = None

    for _page in range(max_pages):
        params: dict[str, str] = {"userName": username}
        if cursor:
            params["cursor"] = cursor

        resp = _api_request(
            _USER_TWEETS_URL,
            params,
            api_key,
            timeout=timeout,
        )
        if not resp:
            break

        tweets = resp.get("tweets") or resp.get("data") or []
        if not tweets:
            break

        for tw in tweets:
            row = _flatten_twitterapi_io_tweet(
                tw,
                fallback_username=profile.get("username"),
                fallback_display_name=profile.get("display_name"),
            )
            if not include_replies and row["is_reply"]:
                continue
            if not include_retweets and row["is_retweet"]:
                continue
            rows.append(row)

        cursor = resp.get("next_cursor") or resp.get("nextCursor")
        if not cursor or not resp.get("has_next_page", True):
            break

        # Small delay between pages to be polite
        time.sleep(0.3)

    return ImportResult(profile=profile, rows=rows, source=_SOURCE)


def load_twitterapi_io_json(
    data: str | dict[str, Any] | list[dict[str, Any]],
    *,
    username: str | None = None,
) -> ImportResult:
    """Load tweets from a twitterapi.io JSON file, response dict, or tweet list.

    Accepts:
    - A file path (str ending in .json or containing path separators)
    - A raw API response dict ``{"tweets": [...], ...}``
    - A bare list of tweet objects

    Parameters
    ----------
    data
        File path, API response dict, or list of tweet dicts.
    username
        Optional username override for the profile.

    Returns
    -------
    ImportResult
        Normalised result with ``source="twitterapi_io"``.
    """
    # If it's a string, treat as file path
    if isinstance(data, str):
        with open(data, "r", encoding="utf-8") as f:
            data = json.load(f)

    # Extract user/profile data if present
    user_data: dict[str, Any] = {}
    if isinstance(data, dict):
        user_data = data.get("user") or data.get("profile") or {}
        tweets = data.get("tweets") or data.get("data") or []
        if not isinstance(tweets, list):
            tweets = []
    elif isinstance(data, list):
        tweets = data
    else:
        raise TypeError(f"Expected str, dict, or list, got {type(data).__name__}")

    profile = _build_profile(user_data)

    rows: list[dict[str, Any]] = []
    for tweet in tweets:
        if not isinstance(tweet, dict):
            continue
        row = _flatten_twitterapi_io_tweet(
            tweet,
            fallback_username=profile.get("username") or username,
            fallback_display_name=profile.get("display_name"),
        )
        if not row["id"] or not row["text"]:
            continue
        rows.append(row)

        # Capture profile from the first tweet's author block if not set
        if not profile.get("username"):
            profile = _build_profile(tweet.get("author") or {})

    if username and not profile.get("username"):
        profile["username"] = username

    return ImportResult(profile=profile, rows=rows, source=_SOURCE)
