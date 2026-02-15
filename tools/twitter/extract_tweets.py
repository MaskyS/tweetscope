"""Extract a subset of tweets for SAE testing."""

import json
from pathlib import Path


def extract_test_tweets(
    input_file: str,
    output_file: str = None,
    max_tweets: int = 500,
    min_text_length: int = 50,
    min_favorites: int = 10,
    language: str = "en"
) -> list[dict]:
    """
    Extract a subset of tweets for SAE testing.

    Args:
        input_file: Path to patio11_twitter_archive.json
        output_file: Optional path to save extracted tweets
        max_tweets: Maximum number of tweets to extract
        min_text_length: Minimum tweet text length (chars)
        min_favorites: Minimum favorite count filter
        language: Language code to filter (e.g., "en")

    Returns:
        List of tweet dictionaries with normalized fields
    """
    print(f"Loading {input_file}...")
    with open(input_file, 'r') as f:
        data = json.load(f)

    print(f"Total tweets in archive: {len(data['tweets'])}")

    # Extract account info for username/display_name
    account = data['account'][0]['account']
    username = account['username']
    display_name = account['accountDisplayName']
    print(f"Account: @{username} ({display_name})")

    # First pass: collect all qualifying tweets
    candidates = []
    for tweet_obj in data['tweets']:
        tweet = tweet_obj['tweet']

        # Apply filters
        if tweet.get('lang') != language:
            continue
        if len(tweet['full_text']) < min_text_length:
            continue
        if int(tweet.get('favorite_count', 0)) < min_favorites:
            continue

        # Extract normalized fields
        normalized = {
            'id': tweet['id_str'],
            'text': tweet['full_text'],
            'created_at': tweet['created_at'],
            'favorites': int(tweet.get('favorite_count', 0)),
            'retweets': int(tweet.get('retweet_count', 0)),
            'username': username,
            'display_name': display_name,
        }
        candidates.append(normalized)

    print(f"Tweets passing filters: {len(candidates)}")

    # Sort by favorites (highest first) and take top N
    candidates.sort(key=lambda x: x['favorites'], reverse=True)
    tweets = candidates[:max_tweets]

    print(f"Selected top {len(tweets)} tweets by engagement")

    # Stats
    if tweets:
        avg_len = sum(len(t['text']) for t in tweets) / len(tweets)
        avg_fav = sum(t['favorites'] for t in tweets) / len(tweets)
        print(f"Average text length: {avg_len:.0f} chars")
        print(f"Average favorites: {avg_fav:.0f}")
        print(f"Favorites range: {tweets[-1]['favorites']} - {tweets[0]['favorites']}")

    # Save to file
    if output_file:
        with open(output_file, 'w') as f:
            json.dump(tweets, f, indent=2)
        print(f"Saved to {output_file}")

    return tweets


if __name__ == "__main__":
    project_root = Path(__file__).parent.parent

    tweets = extract_test_tweets(
        input_file=str(project_root / "patio11_twitter_archive.json"),
        output_file=str(project_root / "test_tweets_500.json"),
        max_tweets=500,
        min_text_length=50,
        min_favorites=10,
        language="en"
    )

    # Show a few samples
    print("\n--- Sample tweets ---")
    for t in tweets[:3]:
        print(f"\n[{t['favorites']} favs] {t['text'][:100]}...")
