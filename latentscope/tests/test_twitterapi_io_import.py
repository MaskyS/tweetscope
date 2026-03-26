"""Tests for the twitterapi.io JSON importer."""

import json
import os
import tempfile

import pytest

from latentscope.importers.twitterapi_io import (
    _flatten_twitterapi_io_tweet,
    fetch_twitterapi_io,
    load_twitterapi_io_json,
)


def _make_tweet(**overrides):
    """Build a minimal twitterapi.io tweet object."""
    tweet = {
        "type": "tweet",
        "id": "123456",
        "url": "https://x.com/testuser/status/123456",
        "text": "Hello world",
        "source": "Twitter Web App",
        "retweetCount": 5,
        "replyCount": 2,
        "likeCount": 10,
        "quoteCount": 1,
        "viewCount": 500,
        "bookmarkCount": 3,
        "createdAt": "2026-01-15T12:00:00.000Z",
        "lang": "en",
        "isReply": False,
        "inReplyToId": None,
        "conversationId": "123456",
        "inReplyToUsername": None,
        "author": {
            "type": "user",
            "userName": "testuser",
            "id": "999",
            "name": "Test User",
            "profilePicture": "https://pbs.twimg.com/profile/test.jpg",
            "coverPicture": "https://pbs.twimg.com/banner/test.jpg",
            "description": "A test account",
            "location": "Testville",
            "followers": 1000,
            "following": 200,
        },
        "entities": {"hashtags": [], "urls": [], "user_mentions": []},
    }
    tweet.update(overrides)
    return tweet


def test_basic_tweet_normalisation():
    row = _flatten_twitterapi_io_tweet(_make_tweet())
    assert row["id"] == "123456"
    assert row["text"] == "Hello world"
    assert row["favorites"] == 10
    assert row["retweets"] == 5
    assert row["replies"] == 2
    assert row["quotes"] == 1
    assert row["views"] == 500
    assert row["bookmarks"] == 3
    assert row["username"] == "testuser"
    assert row["display_name"] == "Test User"
    assert row["lang"] == "en"
    assert row["is_reply"] is False
    assert row["is_retweet"] is False
    assert row["is_like"] is False
    assert row["tweet_type"] == "tweet"
    assert row["archive_source"] == "twitterapi_io"
    assert row["conversation_id"] == "123456"


def test_html_entity_decoding():
    row = _flatten_twitterapi_io_tweet(_make_tweet(text="A &amp; B &lt;3"))
    assert row["text"] == "A & B <3"
    assert row["text_raw"] == "A &amp; B &lt;3"


def test_url_entity_extraction():
    tweet = _make_tweet(
        text="Check this https://t.co/abc",
        entities={
            "hashtags": [],
            "urls": [
                {
                    "url": "https://t.co/abc",
                    "expanded_url": "https://example.com/article",
                    "display_url": "example.com/article",
                    "indices": [11, 31],
                }
            ],
            "user_mentions": [],
        },
    )
    row = _flatten_twitterapi_io_tweet(tweet)
    assert "https://example.com/article" in row["text"]
    assert "t.co" not in row["text"]
    urls = json.loads(row["urls_json"])
    assert "https://example.com/article" in urls


def test_reply_detection():
    row = _flatten_twitterapi_io_tweet(_make_tweet(isReply=True, inReplyToId="999"))
    assert row["is_reply"] is True
    assert row["in_reply_to_status_id"] == "999"


def test_retweet_detection_via_text():
    row = _flatten_twitterapi_io_tweet(_make_tweet(text="RT @other: some tweet"))
    assert row["is_retweet"] is True


def test_retweet_detection_via_retweeted_tweet():
    row = _flatten_twitterapi_io_tweet(
        _make_tweet(retweeted_tweet={"id": "555", "text": "original"})
    )
    assert row["is_retweet"] is True


def test_quoted_tweet_id():
    row = _flatten_twitterapi_io_tweet(
        _make_tweet(quoted_tweet={"id": "777", "text": "quoted"})
    )
    assert row["quoted_status_id"] == "777"


def test_date_parsing():
    # ISO format
    row = _flatten_twitterapi_io_tweet(
        _make_tweet(createdAt="2026-01-15T12:00:00.000Z")
    )
    assert row["created_at"] is not None
    assert "2026-01-15" in row["created_at"]

    # Twitter native format
    row2 = _flatten_twitterapi_io_tweet(
        _make_tweet(createdAt="Tue Dec 10 07:00:30 +0000 2024")
    )
    assert row2["created_at"] is not None
    assert "2024-12-10" in row2["created_at"]


def test_load_from_api_response_dict():
    payload = {
        "tweets": [_make_tweet(), _make_tweet(id="999", text="Second tweet")],
        "has_next_page": False,
        "next_cursor": "",
    }
    result = load_twitterapi_io_json(payload)
    assert result.source == "twitterapi_io"
    assert len(result.rows) == 2
    assert result.profile["username"] == "testuser"
    assert result.rows[0]["id"] == "123456"
    assert result.rows[1]["id"] == "999"


def test_load_from_bare_list():
    result = load_twitterapi_io_json([_make_tweet()])
    assert len(result.rows) == 1
    assert result.source == "twitterapi_io"


def test_load_from_file_path():
    payload = {
        "user": {
            "userName": "fileuser",
            "name": "File User",
            "id": "888",
        },
        "tweets": [_make_tweet()],
    }
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    ) as f:
        json.dump(payload, f)
        path = f.name
    try:
        result = load_twitterapi_io_json(path)
        assert len(result.rows) == 1
        assert result.profile["username"] == "fileuser"
    finally:
        os.unlink(path)


def test_load_skips_empty_tweets():
    result = load_twitterapi_io_json([_make_tweet(id="", text="")])
    assert len(result.rows) == 0


def test_username_override():
    tweet = _make_tweet()
    del tweet["author"]
    result = load_twitterapi_io_json([tweet], username="override_user")
    assert result.profile["username"] == "override_user"


def test_fetch_requires_api_key():
    """fetch_twitterapi_io raises ValueError without an API key."""
    # Ensure env var is not set
    old = os.environ.pop("TWITTER_API_KEY", None)
    try:
        try:
            fetch_twitterapi_io("testuser")
            assert False, "Should have raised ValueError"
        except ValueError as e:
            assert "API key required" in str(e)
    finally:
        if old is not None:
            os.environ["TWITTER_API_KEY"] = old


def test_profile_includes_follower_counts():
    result = load_twitterapi_io_json({
        "user": {
            "userName": "richprofile",
            "name": "Rich Profile",
            "id": "111",
            "followers": 5000,
            "following": 300,
            "statusesCount": 1200,
            "isBlueVerified": True,
        },
        "tweets": [_make_tweet()],
    })
    assert result.profile["followers"] == 5000
    assert result.profile["following"] == 300
    assert result.profile["statuses_count"] == 1200
    assert result.profile["is_verified"] is True


def test_schema_keys_match_flatten_tweet():
    """Ensure twitterapi_io rows have all canonical keys (plus extras)."""
    from latentscope.importers.twitter import _flatten_tweet

    canonical = _flatten_tweet({"tweet": {"id_str": "1", "full_text": "test"}})
    twitterapi = _flatten_twitterapi_io_tweet(_make_tweet())

    # twitterapi_io has all canonical keys
    canonical_keys = set(canonical.keys())
    twitterapi_keys = set(twitterapi.keys())
    missing = canonical_keys - twitterapi_keys
    assert not missing, f"Missing canonical keys: {missing}"

    # Extra keys are expected (quotes, views, bookmarks)
    extras = twitterapi_keys - canonical_keys
    assert "quotes" in extras
    assert "views" in extras
    assert "bookmarks" in extras


def test_extended_entities_media_extraction():
    """Media in extendedEntities should be extracted."""
    tweet = _make_tweet(
        extendedEntities={
            "media": [
                {
                    "media_url_https": "https://pbs.twimg.com/media/photo.jpg",
                    "url": "https://t.co/media1",
                    "expanded_url": "https://x.com/user/status/1/photo/1",
                    "type": "photo",
                    "indices": [20, 40],
                }
            ]
        },
    )
    row = _flatten_twitterapi_io_tweet(tweet)
    media = json.loads(row["media_urls_json"])
    assert "https://pbs.twimg.com/media/photo.jpg" in media
    entities = json.loads(row["url_entities_json"])
    media_entities = [e for e in entities if e["kind"] == "media"]
    assert len(media_entities) >= 1
    assert media_entities[0]["media_type"] == "photo"


def test_load_json_rejects_invalid_type():
    """load_twitterapi_io_json raises TypeError for non-str/dict/list."""
    with pytest.raises(TypeError, match="Expected str, dict, or list"):
        load_twitterapi_io_json(12345)  # type: ignore[arg-type]


def test_empty_author_uses_fallback():
    """When author is empty, fallback_username and fallback_display_name are used."""
    tweet = _make_tweet()
    tweet["author"] = {}
    row = _flatten_twitterapi_io_tweet(tweet, fallback_username="fb_user", fallback_display_name="FB Name")
    assert row["username"] == "fb_user"
    assert row["display_name"] == "FB Name"
