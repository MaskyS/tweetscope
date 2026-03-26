"""Tests for the X_Account_Analyzer CSV importer."""

import json
import os
import tempfile

import pytest

from latentscope.importers.xanalyzer_csv import (
    _extract_tweet_id_from_url,
    _flatten_xanalyzer_row,
    _post_type_to_flags,
    load_xanalyzer_csv,
)


# Sample X_Account_Analyzer detailed.csv content
_DETAILED_CSV = """\
date,handle,text,url,post_type,views,likes,rts,replies,quotes,engagement,sentiment_score,sentiment_label
2026-01-15T12:00:00Z,@alice,Hello world,https://x.com/alice/status/100,original,500,10,5,2,1,18,0.8,positive
2026-01-16T12:00:00Z,@alice,Thanks for sharing!,https://x.com/alice/status/101,reply,200,3,0,1,0,4,0.6,positive
2026-01-17T12:00:00Z,@alice,RT @bob: Great thread,https://x.com/alice/status/102,retweet,1000,0,15,0,0,15,-0.1,neutral
"""

_SUMMARY_CSV = """\
handle,name,followers,following,tweets_count
@alice,Alice Smith,5000,300,1200
"""


def _write_temp_csv(content: str, name: str = "detailed.csv") -> str:
    """Write CSV content to a temp file and return its path."""
    tmpdir = tempfile.mkdtemp()
    path = os.path.join(tmpdir, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


def test_extract_tweet_id_from_url():
    assert _extract_tweet_id_from_url("https://x.com/alice/status/123456") == "123456"
    assert _extract_tweet_id_from_url("https://twitter.com/bob/status/789") == "789"
    assert _extract_tweet_id_from_url("https://example.com/not-a-tweet") == ""
    assert _extract_tweet_id_from_url("") == ""


def test_post_type_to_flags():
    assert _post_type_to_flags("reply") == (True, False)
    assert _post_type_to_flags("retweet") == (False, True)
    assert _post_type_to_flags("rt") == (False, True)
    assert _post_type_to_flags("original") == (False, False)
    assert _post_type_to_flags("Reply") == (True, False)  # case-insensitive


def test_flatten_xanalyzer_row():
    csv_row = {
        "date": "2026-01-15T12:00:00Z",
        "handle": "@alice",
        "text": "Hello &amp; world",
        "url": "https://x.com/alice/status/100",
        "post_type": "original",
        "views": "500",
        "likes": "10",
        "rts": "5",
        "replies": "2",
        "quotes": "1",
        "engagement": "18",
        "sentiment_score": "0.8",
        "sentiment_label": "positive",
    }
    row = _flatten_xanalyzer_row(csv_row)
    assert row["id"] == "100"
    assert row["text"] == "Hello & world"
    assert row["text_raw"] == "Hello &amp; world"
    assert row["username"] == "alice"
    assert row["favorites"] == 10
    assert row["retweets"] == 5
    assert row["replies"] == 2
    assert row["quotes"] == 1
    assert row["views"] == 500
    assert row["is_reply"] is False
    assert row["is_retweet"] is False
    assert row["is_like"] is False
    assert row["tweet_type"] == "tweet"
    assert row["archive_source"] == "xanalyzer_csv"
    assert row["sentiment_score"] == 0.8
    assert row["sentiment_label"] == "positive"
    assert row["tweet_url"] == "https://x.com/alice/status/100"


def test_flatten_reply_row():
    row = _flatten_xanalyzer_row({
        "text": "Reply text",
        "url": "https://x.com/alice/status/200",
        "post_type": "reply",
        "handle": "@alice",
    })
    assert row["is_reply"] is True
    assert row["is_retweet"] is False


def test_flatten_retweet_row():
    row = _flatten_xanalyzer_row({
        "text": "RT @bob: original",
        "url": "https://x.com/alice/status/300",
        "post_type": "retweet",
        "handle": "@alice",
    })
    assert row["is_retweet"] is True
    assert row["is_reply"] is False


def test_retweet_detection_by_text_prefix():
    """Even with post_type=original, RT @ prefix should trigger is_retweet."""
    row = _flatten_xanalyzer_row({
        "text": "RT @someone: content here",
        "url": "https://x.com/alice/status/400",
        "post_type": "original",
        "handle": "@alice",
    })
    assert row["is_retweet"] is True


def test_load_xanalyzer_csv_basic():
    path = _write_temp_csv(_DETAILED_CSV)
    try:
        result = load_xanalyzer_csv(path)
        assert result.source == "xanalyzer_csv"
        assert len(result.rows) == 3
        assert result.profile["username"] == "alice"
        assert result.rows[0]["id"] == "100"
        assert result.rows[1]["is_reply"] is True
        assert result.rows[2]["is_retweet"] is True
    finally:
        os.unlink(path)


def test_load_xanalyzer_csv_with_summary():
    tmpdir = tempfile.mkdtemp()
    detailed_path = os.path.join(tmpdir, "detailed.csv")
    summary_path = os.path.join(tmpdir, "summary.csv")

    with open(detailed_path, "w", encoding="utf-8") as f:
        f.write(_DETAILED_CSV)
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(_SUMMARY_CSV)

    try:
        result = load_xanalyzer_csv(detailed_path)
        # summary.csv should be auto-discovered
        assert result.profile["display_name"] == "Alice Smith"
        assert result.profile["followers"] == 5000
    finally:
        os.unlink(detailed_path)
        os.unlink(summary_path)
        os.rmdir(tmpdir)


def test_load_xanalyzer_csv_username_filter():
    csv_content = """\
date,handle,text,url,post_type,views,likes,rts,replies,quotes,engagement,sentiment_score,sentiment_label
2026-01-15T12:00:00Z,@alice,Alice tweet,https://x.com/alice/status/100,original,500,10,5,2,1,18,0.8,positive
2026-01-16T12:00:00Z,@bob,Bob tweet,https://x.com/bob/status/200,original,300,5,2,1,0,8,0.5,neutral
"""
    path = _write_temp_csv(csv_content)
    try:
        result = load_xanalyzer_csv(path, username="alice")
        assert len(result.rows) == 1
        assert result.rows[0]["username"] == "alice"
        assert result.profile["username"] == "alice"
    finally:
        os.unlink(path)


def test_load_xanalyzer_csv_file_not_found():
    with pytest.raises(FileNotFoundError):
        load_xanalyzer_csv("/nonexistent/path/detailed.csv")


def test_load_xanalyzer_csv_invalid_format():
    csv_content = "col_a,col_b\n1,2\n"
    path = _write_temp_csv(csv_content)
    try:
        with pytest.raises(ValueError, match="doesn't look like"):
            load_xanalyzer_csv(path)
    finally:
        os.unlink(path)


def test_url_extraction_from_text():
    row = _flatten_xanalyzer_row({
        "text": "Check https://example.com and https://test.org",
        "url": "https://x.com/alice/status/500",
        "handle": "@alice",
    })
    urls = json.loads(row["urls_json"])
    assert "https://example.com" in urls
    assert "https://test.org" in urls


def test_schema_has_canonical_keys():
    """Ensure xanalyzer_csv rows have all canonical keys from _flatten_tweet."""
    from latentscope.importers.twitter import _flatten_tweet

    canonical = _flatten_tweet({"tweet": {"id_str": "1", "full_text": "test"}})
    xanalyzer = _flatten_xanalyzer_row({
        "text": "test",
        "url": "https://x.com/u/status/1",
        "handle": "@u",
    })

    canonical_keys = set(canonical.keys())
    xanalyzer_keys = set(xanalyzer.keys())
    missing = canonical_keys - xanalyzer_keys
    assert not missing, f"Missing canonical keys: {missing}"

    # Extra keys are expected
    extras = xanalyzer_keys - canonical_keys
    assert "sentiment_score" in extras
    assert "sentiment_label" in extras
    assert "post_type_original" in extras
    assert "tweet_url" in extras
