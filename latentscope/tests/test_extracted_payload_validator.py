import pytest

from latentscope.importers.twitter import (
    EXTRACTED_ARCHIVE_FORMAT,
    validate_extracted_archive_payload,
)


def _valid_payload():
    return {
        "archive_format": EXTRACTED_ARCHIVE_FORMAT,
        "profile": {"username": "alice"},
        "tweets": [{"tweet": {"id_str": "1", "full_text": "hello"}}],
        "likes": [{"like": {"tweetId": "2"}}],
        "tweet_count": 1,
        "likes_count": 1,
        "total_count": 2,
    }


def test_validate_extracted_payload_accepts_minimal_valid():
    counts = validate_extracted_archive_payload(_valid_payload(), require_archive_format=True)
    assert counts == {"tweet_count": 1, "likes_count": 1, "total_count": 2}


def test_validate_extracted_payload_rejects_wrong_archive_format():
    payload = _valid_payload()
    payload["archive_format"] = "something_else"
    with pytest.raises(ValueError, match="archive_format must be"):
        validate_extracted_archive_payload(payload, require_archive_format=True)


def test_validate_extracted_payload_allows_missing_archive_format_when_not_required():
    payload = _valid_payload()
    payload.pop("archive_format", None)
    counts = validate_extracted_archive_payload(payload, require_archive_format=False)
    assert counts["total_count"] == 2


def test_validate_extracted_payload_rejects_missing_profile():
    payload = _valid_payload()
    payload.pop("profile", None)
    with pytest.raises(ValueError, match="Missing required field: profile"):
        validate_extracted_archive_payload(payload, require_archive_format=True)


def test_validate_extracted_payload_rejects_empty_tweets_and_likes():
    payload = _valid_payload()
    payload["tweets"] = []
    payload["likes"] = []
    payload["tweet_count"] = 0
    payload["likes_count"] = 0
    payload["total_count"] = 0
    with pytest.raises(ValueError, match="at least one tweet or like"):
        validate_extracted_archive_payload(payload, require_archive_format=True)


def test_validate_extracted_payload_rejects_tweet_missing_id():
    payload = _valid_payload()
    payload["tweets"] = [{"tweet": {"full_text": "hi"}}]
    with pytest.raises(ValueError, match="missing id_str/id"):
        validate_extracted_archive_payload(payload, require_archive_format=True)


def test_validate_extracted_payload_rejects_like_missing_id():
    payload = _valid_payload()
    payload["likes"] = [{"like": {}}]
    with pytest.raises(ValueError, match="likes\\[0\\] missing"):
        validate_extracted_archive_payload(payload, require_archive_format=True)


def test_validate_extracted_payload_rejects_count_mismatch():
    payload = _valid_payload()
    payload["tweet_count"] = 2
    with pytest.raises(ValueError, match="tweet_count does not match"):
        validate_extracted_archive_payload(payload, require_archive_format=True)

