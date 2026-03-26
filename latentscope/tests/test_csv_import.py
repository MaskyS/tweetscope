"""Tests for the CSV importer."""

import json
import os
import tempfile

from latentscope.importers.csv_import import load_csv, load_csv_string


_BASIC_CSV = """\
tweet_id,text,created_at,username,display_name,favorite_count,retweet_count,reply_count,lang
100,Hello world,2026-01-15T12:00:00Z,alice,Alice,10,5,2,en
101,"RT @bob: retweet test",2026-01-16T12:00:00Z,alice,Alice,0,3,0,en
102,Reply to thread,2026-01-17T12:00:00Z,alice,Alice,7,1,1,en
"""


def test_basic_csv_load():
    result = load_csv_string(_BASIC_CSV)
    assert result.source == "csv_import"
    assert len(result.rows) == 3
    assert result.profile["username"] == "alice"

    row = result.rows[0]
    assert row["id"] == "100"
    assert row["text"] == "Hello world"
    assert row["favorites"] == 10
    assert row["retweets"] == 5
    assert row["replies"] == 2
    assert row["lang"] == "en"
    assert row["username"] == "alice"
    assert row["display_name"] == "Alice"
    assert row["is_like"] is False
    assert row["tweet_type"] == "tweet"
    assert row["archive_source"] == "csv_import"


def test_retweet_detection():
    result = load_csv_string(_BASIC_CSV)
    rt_row = result.rows[1]
    assert rt_row["is_retweet"] is True


def test_html_entity_decoding():
    csv_text = "id,text\n200,A &amp; B &lt;3\n"
    result = load_csv_string(csv_text)
    assert result.rows[0]["text"] == "A & B <3"
    assert result.rows[0]["text_raw"] == "A &amp; B &lt;3"


def test_url_parsing_json_array():
    csv_text = 'id,text,urls\n300,Check it,"[""https://example.com"",""https://test.org""]"\n'
    result = load_csv_string(csv_text)
    urls = json.loads(result.rows[0]["urls_json"])
    assert urls == ["https://example.com", "https://test.org"]


def test_url_parsing_comma_separated():
    csv_text = 'id,text,urls\n400,Links,"https://a.com,https://b.com"\n'
    result = load_csv_string(csv_text)
    urls = json.loads(result.rows[0]["urls_json"])
    assert "https://a.com" in urls
    assert "https://b.com" in urls


def test_tsv_auto_detection():
    tsv = "id\ttext\tusername\n500\tHello\tbob\n"
    result = load_csv_string(tsv)
    assert len(result.rows) == 1
    assert result.rows[0]["id"] == "500"
    assert result.rows[0]["username"] == "bob"


def test_alternative_column_names():
    csv_text = "status_id,content,screen_name,likes,date\n600,Test tweet,charlie,15,2026-02-01\n"
    result = load_csv_string(csv_text)
    row = result.rows[0]
    assert row["id"] == "600"
    assert row["text"] == "Test tweet"
    assert row["username"] == "charlie"
    assert row["favorites"] == 15
    assert row["created_at"] == "2026-02-01"


def test_fallback_username():
    csv_text = "id,text\n700,No user column\n"
    result = load_csv_string(csv_text, username="fallback_user", display_name="Fallback")
    assert result.rows[0]["username"] == "fallback_user"
    assert result.rows[0]["display_name"] == "Fallback"
    assert result.profile["username"] == "fallback_user"


def test_skips_empty_rows():
    csv_text = "id,text\n,,\n800,Valid\n"
    result = load_csv_string(csv_text)
    assert len(result.rows) == 1
    assert result.rows[0]["id"] == "800"


def test_load_csv_from_file():
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".csv", delete=False, encoding="utf-8"
    ) as f:
        f.write("id,text,username\n900,File test,dave\n")
        path = f.name
    try:
        result = load_csv(path)
        assert len(result.rows) == 1
        assert result.rows[0]["id"] == "900"
        assert result.rows[0]["username"] == "dave"
    finally:
        os.unlink(path)


def test_reply_detection_via_in_reply_to():
    csv_text = "id,text,in_reply_to_status_id\n1000,Reply here,999\n"
    result = load_csv_string(csv_text)
    assert result.rows[0]["is_reply"] is True
    assert result.rows[0]["in_reply_to_status_id"] == "999"


def test_schema_keys_match_flatten_tweet():
    """Ensure CSV importer output keys match the canonical schema."""
    from latentscope.importers.twitter import _flatten_tweet

    canonical = _flatten_tweet({"tweet": {"id_str": "1", "full_text": "test"}})
    result = load_csv_string("id,text\n1,test\n")
    csv_row = result.rows[0]
    assert set(canonical.keys()) == set(csv_row.keys()), (
        f"Key mismatch: canonical has {set(canonical.keys()) - set(csv_row.keys())}, "
        f"csv has {set(csv_row.keys()) - set(canonical.keys())}"
    )
