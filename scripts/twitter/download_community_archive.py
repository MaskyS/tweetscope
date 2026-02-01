#!/usr/bin/env python3
"""
Download tweets or raw user data from the Community Archive.

The Community Archive (https://www.community-archive.org/) is a public archive
of Twitter data. This script supports three modes:

1. raw: Downloads the full JSON archive (tweets, likes, followers, etc.)
2. tweets: Queries just tweets via Supabase API (with pagination)
3. extract: Downloads raw archive, extracts just tweets + profile (fast & clean)

Usage:
    # Download full raw archive for a user
    uv run scripts/twitter/download_community_archive.py defenderofbasic --mode raw

    # Download just tweets via API (paginated, slower)
    uv run scripts/twitter/download_community_archive.py defenderofbasic --mode tweets

    # Extract tweets + profile from raw archive (recommended)
    uv run scripts/twitter/download_community_archive.py defenderofbasic --mode extract

    # Specify output file
    uv run scripts/twitter/download_community_archive.py defenderofbasic -o my_tweets.json
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError


# Community Archive API configuration
SUPABASE_URL = "https://fabxmporizzqflnftavs.supabase.co"
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhYnhtcG9yaXp6cWZsbmZ0YXZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjIyNDQ5MTIsImV4cCI6MjAzNzgyMDkxMn0.UIEJiUNkLsW28tBHmG-RQDW-I5JNlJLt62CSk9D_qG8"
BLOB_STORAGE_BASE = f"{SUPABASE_URL}/storage/v1/object/public/archives"


def download_raw_archive(username: str, output_file: str = None) -> dict:
    """
    Download the full raw archive JSON for a user from blob storage.

    Args:
        username: Twitter username (case-insensitive, will be lowercased)
        output_file: Optional path to save the archive

    Returns:
        The parsed archive JSON data
    """
    username_lower = username.lower()
    url = f"{BLOB_STORAGE_BASE}/{username_lower}/archive.json"

    print(f"Downloading raw archive from: {url}")

    try:
        with urlopen(url) as response:
            data = json.loads(response.read().decode('utf-8'))
    except HTTPError as e:
        if e.code == 404:
            print(f"Error: User '{username}' not found in Community Archive.")
            print("The user may not have uploaded their archive, or the username may be incorrect.")
            sys.exit(1)
        raise

    # Print summary
    print(f"\nArchive downloaded for @{username}")
    if 'account' in data and data['account']:
        account = data['account'][0].get('account', {}) if isinstance(data['account'], list) else data['account']
        print(f"  Display name: {account.get('accountDisplayName', 'N/A')}")
        print(f"  Account ID: {account.get('accountId', 'N/A')}")

    print(f"  Tweets: {len(data.get('tweets', []))}")
    print(f"  Likes: {len(data.get('like', []))}")
    print(f"  Followers: {len(data.get('follower', []))}")
    print(f"  Following: {len(data.get('following', []))}")

    if output_file:
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"\nSaved to: {output_file}")

    return data


def supabase_request(endpoint: str, params: dict = None) -> list:
    """Make an authenticated request to the Supabase REST API."""
    url = f"{SUPABASE_URL}/rest/v1/{endpoint}"

    if params:
        query_string = "&".join(f"{k}={v}" for k, v in params.items())
        url = f"{url}?{query_string}"

    request = Request(url)
    request.add_header("apikey", SUPABASE_ANON_KEY)
    request.add_header("Authorization", f"Bearer {SUPABASE_ANON_KEY}")

    with urlopen(request) as response:
        return json.loads(response.read().decode('utf-8'))


def get_account_id(username: str) -> tuple[str, str]:
    """
    Get the account ID for a given username (case-insensitive).

    Returns:
        Tuple of (account_id, actual_username)
    """
    # Use ilike for case-insensitive matching
    result = supabase_request("account", {
        "username": f"ilike.{username}",
        "select": "account_id,username"
    })

    if not result:
        print(f"Error: Username '{username}' not found in Community Archive database.")
        sys.exit(1)

    return result[0]['account_id'], result[0]['username']


def download_tweets_paginated(
    username: str,
    output_file: str = None,
    page_size: int = 1000
) -> list:
    """
    Download all tweets for a user via the Supabase API with pagination.

    Args:
        username: Twitter username
        output_file: Optional path to save tweets
        page_size: Number of tweets per API request

    Returns:
        List of tweet objects
    """
    print(f"Looking up account ID for @{username}...")
    account_id, actual_username = get_account_id(username)
    print(f"  Found: @{actual_username} (ID: {account_id})")

    print(f"\nDownloading tweets (page size: {page_size})...")

    all_tweets = []
    offset = 0

    while True:
        params = {
            "account_id": f"eq.{account_id}",
            "order": "created_at.desc",
            "limit": str(page_size),
            "offset": str(offset)
        }

        tweets = supabase_request("tweets", params)

        if not tweets:
            break

        all_tweets.extend(tweets)
        print(f"  Fetched {len(all_tweets)} tweets...")

        if len(tweets) < page_size:
            break

        offset += page_size

    print(f"\nTotal tweets downloaded: {len(all_tweets)}")

    if output_file:
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(all_tweets, f, indent=2, ensure_ascii=False)
        print(f"Saved to: {output_file}")

    return all_tweets


def extract_tweets_and_profile(username: str, output_file: str = None, year: int = None) -> dict:
    """
    Download raw archive and extract just tweets + profile info.

    This is the recommended mode: fast (single download) and clean output.

    Args:
        username: Twitter username
        output_file: Optional path to save extracted data
        year: Optional year to filter tweets (e.g., 2023 for only 2023 tweets)

    Returns:
        Dict with 'profile' and 'tweets' keys
    """
    username_lower = username.lower()
    url = f"{BLOB_STORAGE_BASE}/{username_lower}/archive.json"

    print(f"Downloading raw archive from: {url}")

    try:
        with urlopen(url) as response:
            raw_data = json.loads(response.read().decode('utf-8'))
    except HTTPError as e:
        if e.code == 404:
            print(f"Error: User '{username}' not found in Community Archive.")
            print("The user may not have uploaded their archive, or the username may be incorrect.")
            sys.exit(1)
        raise

    # Extract account info
    account_data = {}
    if raw_data.get('account'):
        acc = raw_data['account']
        if isinstance(acc, list) and acc:
            account_data = acc[0].get('account', {})
        elif isinstance(acc, dict):
            account_data = acc.get('account', acc)

    # Extract profile info
    profile_data = {}
    if raw_data.get('profile'):
        prof = raw_data['profile']
        if isinstance(prof, list) and prof:
            profile_data = prof[0].get('profile', {})
        elif isinstance(prof, dict):
            profile_data = prof.get('profile', prof)

    # Flatten profile
    profile = {
        'username': account_data.get('username', username),
        'account_id': account_data.get('accountId'),
        'display_name': account_data.get('accountDisplayName'),
        'created_at': account_data.get('createdAt'),
        'bio': profile_data.get('description', {}).get('bio', ''),
        'website': profile_data.get('description', {}).get('website', ''),
        'location': profile_data.get('description', {}).get('location', ''),
        'avatar_url': profile_data.get('avatarMediaUrl'),
        'header_url': profile_data.get('headerMediaUrl'),
    }

    # Extract and flatten tweets
    tweets = []
    for tweet_obj in raw_data.get('tweets', []):
        t = tweet_obj.get('tweet', tweet_obj)

        # Extract basic tweet info
        tweet = {
            'id': t.get('id_str') or t.get('id'),
            'text': t.get('full_text', ''),
            'created_at': t.get('created_at'),
            'favorite_count': int(t.get('favorite_count', 0)),
            'retweet_count': int(t.get('retweet_count', 0)),
            'reply_count': int(t.get('reply_count', 0)),
            'lang': t.get('lang'),
            'source': t.get('source'),
            'in_reply_to_user_id': t.get('in_reply_to_user_id_str'),
            'in_reply_to_screen_name': t.get('in_reply_to_screen_name'),
            'in_reply_to_status_id': t.get('in_reply_to_status_id_str'),
        }

        # Extract media URLs if present
        media = t.get('extended_entities', {}).get('media', [])
        if media:
            tweet['media_urls'] = [m.get('media_url_https') for m in media if m.get('media_url_https')]

        # Extract URLs if present
        urls = t.get('entities', {}).get('urls', [])
        if urls:
            tweet['urls'] = [u.get('expanded_url') for u in urls if u.get('expanded_url')]

        tweets.append(tweet)

    # Sort tweets by created_at (newest first)
    # Twitter date format: "Wed Sep 27 16:00:53 +0000 2023"
    def parse_twitter_date(date_str):
        if not date_str:
            return datetime.min
        try:
            return datetime.strptime(date_str, "%a %b %d %H:%M:%S %z %Y")
        except (ValueError, TypeError):
            return datetime.min

    tweets.sort(key=lambda x: parse_twitter_date(x.get('created_at')), reverse=True)

    # Filter by year if specified
    if year:
        original_count = len(tweets)
        tweets = [t for t in tweets if parse_twitter_date(t.get('created_at')).year == year]
        print(f"  Filtered to year {year}: {len(tweets)} tweets (from {original_count})")

    result = {
        'profile': profile,
        'tweets': tweets,
        'tweet_count': len(tweets),
    }

    if year:
        result['year_filter'] = year

    print(f"\nExtracted data for @{profile['username']}")
    print(f"  Display name: {profile['display_name']}")
    print(f"  Account ID: {profile['account_id']}")
    print(f"  Tweets: {len(tweets)}")

    if output_file:
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"\nSaved to: {output_file}")

    return result


def main():
    parser = argparse.ArgumentParser(
        description="Download tweets or raw user data from the Community Archive.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Extract tweets + profile (recommended - fast & clean)
  uv run scripts/twitter/download_community_archive.py defenderofbasic --mode extract

  # Extract only tweets from a specific year
  uv run scripts/twitter/download_community_archive.py visakanv --year 2023

  # Download full raw archive (includes tweets, likes, followers, etc.)
  uv run scripts/twitter/download_community_archive.py defenderofbasic --mode raw

  # Download just tweets via API (paginated, slower but gets DB format)
  uv run scripts/twitter/download_community_archive.py defenderofbasic --mode tweets

  # Save to specific file
  uv run scripts/twitter/download_community_archive.py patio11 -o patio11_tweets.json

Modes:
  extract  Download raw archive, extract tweets + profile (recommended)
  raw      Download full raw archive (tweets, likes, followers, etc.)
  tweets   Query tweets via Supabase API with pagination

About the Community Archive:
  https://www.community-archive.org/
  A public archive of Twitter data uploaded by users.
"""
    )

    parser.add_argument(
        "username",
        help="Twitter username (without @)"
    )
    parser.add_argument(
        "-m", "--mode",
        choices=["extract", "raw", "tweets"],
        default="extract",
        help="Download mode (default: extract)"
    )
    parser.add_argument(
        "-o", "--output",
        help="Output file path (default: <username>_<mode>.json)"
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=1000,
        help="Page size for API pagination (default: 1000, only used with --mode tweets)"
    )
    parser.add_argument(
        "-y", "--year",
        type=int,
        help="Filter tweets to a specific year (e.g., --year 2023). Only used with --mode extract"
    )

    args = parser.parse_args()

    # Determine output file suffix
    suffix_map = {"extract": "tweets", "raw": "archive", "tweets": "api_tweets"}
    suffix = suffix_map.get(args.mode, args.mode)

    # Add year to suffix if filtering
    if args.year and args.mode == "extract":
        suffix = f"tweets_{args.year}"

    if args.output:
        output_file = args.output
    else:
        output_file = f"{args.username.lower()}_{suffix}.json"

    # Download based on mode
    if args.mode == "raw":
        download_raw_archive(args.username, output_file)
    elif args.mode == "tweets":
        download_tweets_paginated(args.username, output_file, args.page_size)
    else:  # extract
        extract_tweets_and_profile(args.username, output_file, year=args.year)


if __name__ == "__main__":
    main()
