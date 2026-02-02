import { useState, useEffect, useRef, memo, useMemo } from 'react';
import PropTypes from 'prop-types';
import { Heart, Repeat2, ExternalLink, Twitter } from 'lucide-react';
import { getClusterColorCSS } from '../DeckGLScatter';
import { useColorMode } from '../../../../hooks/useColorMode';
import { urlResolver } from '../../../../lib/urlResolver';
import TwitterEmbed from './TwitterEmbed';
import styles from './TweetCard.module.scss';

// Extract t.co links from text
function extractTcoLinks(text) {
  const regex = /https?:\/\/t\.co\/[a-zA-Z0-9]+/g;
  return text.match(regex) || [];
}

// Common date column names to auto-detect
const DATE_COLUMN_NAMES = ['created_at', 'date', 'timestamp', 'time', 'posted_at', 'published_at'];

// Format date in Twitter style (relative or absolute)
function formatDate(dateValue) {
  if (!dateValue) return null;

  try {
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return null;

    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    // Within last hour
    if (diffMins < 60) return `${diffMins}m`;
    // Within last 24 hours
    if (diffHours < 24) return `${diffHours}h`;
    // Within last 7 days
    if (diffDays < 7) return `${diffDays}d`;
    // Same year
    if (date.getFullYear() === now.getFullYear()) {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    // Different year
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return null;
  }
}

// Format large numbers (e.g., 22181 -> 22.2K)
function formatCount(num) {
  if (num === undefined || num === null) return null;
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}

TweetCard.propTypes = {
  row: PropTypes.object.isRequired,
  textColumn: PropTypes.string.isRequired,
  dateColumn: PropTypes.string,
  clusterInfo: PropTypes.object,
  similarity: PropTypes.number,
  isHighlighted: PropTypes.bool,
  onHover: PropTypes.func,
  onClick: PropTypes.func,
  showFeatures: PropTypes.bool,
};

function TweetCard({
  row,
  textColumn,
  dateColumn,
  clusterInfo,
  similarity,
  isHighlighted = false,
  onHover,
  onClick,
  showFeatures = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const [showFullEmbed, setShowFullEmbed] = useState(false);
  const [resolvedMedia, setResolvedMedia] = useState([]);
  const [quotedTweets, setQuotedTweets] = useState([]);
  const [isVisible, setIsVisible] = useState(false);
  const [hasResolved, setHasResolved] = useState(false);
  const cardRef = useRef(null);
  const isMountedRef = useRef(true);
  const { colorMode } = useColorMode();

  // Track mount state
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const text = row[textColumn] || '';
  const tcoLinks = useMemo(() => extractTcoLinks(text), [text]);

  // IntersectionObserver - only resolve URLs when card is visible
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect(); // Only need to detect visibility once
        }
      },
      { rootMargin: '100px' } // Start loading slightly before visible
    );

    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  // Resolve t.co links only when visible and not already resolved
  useEffect(() => {
    if (!isVisible || hasResolved || tcoLinks.length === 0) return;

    setHasResolved(true);

    console.log('[TweetCard] Resolving t.co links:', tcoLinks);

    urlResolver.resolve(tcoLinks)
      .then((results) => {
        console.log('[TweetCard] .then() called, isMounted=', isMountedRef.current, 'results=', results);
        if (!isMountedRef.current) return;
        console.log('[TweetCard] URL resolution results:', JSON.stringify(results, null, 2));

        // Filter images
        const media = results.filter(
          (r) => r.type === 'image' && r.media_url && !r.error
        );
        console.log('[TweetCard] Filtered media:', media);
        setResolvedMedia(media);

        // Filter quoted tweets
        const quotes = results.filter(
          (r) => r.type === 'quote' && r.media_url && !r.error
        );
        console.log('[TweetCard] Filtered quotes:', quotes);
        console.log('[TweetCard] Quote media_urls (should be strings):', quotes.map(q => ({
          media_url: q.media_url,
          type: typeof q.media_url,
          final: q.final
        })));
        setQuotedTweets(quotes);
      })
      .catch((err) => {
        console.error('[TweetCard] URL resolution error:', err);
        if (isMountedRef.current) {
          setResolvedMedia([]);
          setQuotedTweets([]);
        }
      });
  }, [isVisible, hasResolved, tcoLinks]);
  const clusterNumber = clusterInfo?.cluster ?? 0;
  const clusterLabel = clusterInfo?.label || `Cluster ${clusterNumber}`;
  const avatarColor = getClusterColorCSS(clusterNumber);

  // Tweet metadata
  const username = row.username;
  const displayName = row.display_name || clusterLabel;
  const favorites = row.favorites;
  const retweets = row.retweets;
  const tweetId = row.id ? String(row.id) : null;
  const tweetUrl = username && tweetId ? `https://twitter.com/${username}/status/${tweetId}` : null;

  // Auto-detect date column if not specified
  const dateValue = useMemo(() => {
    if (dateColumn && row[dateColumn]) {
      return row[dateColumn];
    }
    // Try to auto-detect
    for (const col of DATE_COLUMN_NAMES) {
      if (row[col]) return row[col];
    }
    return null;
  }, [row, dateColumn]);

  const formattedDate = useMemo(() => formatDate(dateValue), [dateValue]);

  // Get first letter or number for avatar
  const avatarText = clusterLabel.charAt(0).toUpperCase() || clusterNumber;

  // Check if text is long enough to need truncation
  const needsTruncation = text.length > 305;

  const handleMouseEnter = () => {
    if (onHover) onHover(row.ls_index);
  };

  const handleMouseLeave = () => {
    if (onHover) onHover(null);
  };

  const handleClick = () => {
    if (onClick) onClick(row.ls_index);
  };

  const handleShowMore = (e) => {
    e.stopPropagation();
    setExpanded(!expanded);
  };

  const handleShowEmbed = (e) => {
    e.stopPropagation();
    setShowFullEmbed(!showFullEmbed);
  };

  return (
    <div
      ref={cardRef}
      className={`${styles.tweetCard} ${isHighlighted ? styles.tweetCardHighlighted : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
    >
      <div className={styles.tweetHeader}>
        {/* Avatar */}
        <div className={styles.avatar} style={{ backgroundColor: avatarColor }}>
          {avatarText}
        </div>

        {/* Header content */}
        <div className={styles.headerContent}>
          {/* Name row */}
          <div className={styles.headerRow}>
            <span className={styles.clusterLabel}>{displayName}</span>
            {username ? (
              <span className={styles.clusterHandle}>@{username}</span>
            ) : (
              <span className={styles.clusterHandle}>@cluster_{clusterNumber}</span>
            )}
            <span className={styles.separator}>·</span>
            {formattedDate ? (
              <span className={styles.date} title={dateValue}>{formattedDate}</span>
            ) : (
              <span className={styles.index}>#{row.idx + 1}</span>
            )}
          </div>

          {/* Tweet body */}
          <div
            className={`${styles.tweetBody} ${!expanded && needsTruncation ? styles.tweetBodyTruncated : ''}`}
          >
            {text}
          </div>

          {/* Show more button */}
          {needsTruncation && (
            <span className={styles.showMore} onClick={handleShowMore}>
              {expanded ? 'Show less' : 'Show more'}
            </span>
          )}

          {/* Media preview - lazy loaded when visible */}
          {resolvedMedia.length > 0 && (
            <div className={styles.mediaContainer}>
              {resolvedMedia.map((media, idx) => (
                <a
                  key={idx}
                  href={media.final}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.mediaLink}
                  onClick={(e) => e.stopPropagation()}
                >
                  <img
                    src={media.media_url}
                    alt="Tweet media"
                    className={styles.mediaImage}
                    loading="lazy"
                  />
                </a>
              ))}
            </div>
          )}

          {/* Quoted tweets - use official Twitter embeds */}
          {quotedTweets.length > 0 && (
            <div className={styles.quotedTweetsContainer}>
              {quotedTweets.map((quote, idx) => (
                <div key={idx} onClick={(e) => e.stopPropagation()}>
                  <TwitterEmbed
                    tweetId={String(quote.media_url)}
                    tweetUrl={quote.final}
                    theme={colorMode}
                    hideConversation={true}
                    compact={true}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Full tweet embed (on demand) - shows all media, quotes, etc. */}
          {showFullEmbed && tweetUrl && (
            <div onClick={(e) => e.stopPropagation()}>
              <TwitterEmbed
                tweetId={tweetId}
                tweetUrl={tweetUrl}
                theme={colorMode}
                hideConversation={true}
              />
            </div>
          )}

          {/* Metrics row */}
          <div className={styles.metricsRow}>
            {/* Likes */}
            {favorites !== undefined && (
              <div className={styles.metricBadge} title={`${favorites.toLocaleString()} likes`}>
                <Heart size={14} className={styles.metricIcon} />
                <span>{formatCount(favorites)}</span>
              </div>
            )}

            {/* Retweets */}
            {retweets !== undefined && (
              <div className={styles.metricBadge} title={`${retweets.toLocaleString()} retweets`}>
                <Repeat2 size={14} className={styles.metricIcon} />
                <span>{formatCount(retweets)}</span>
              </div>
            )}

            {/* Twitter link */}
            {tweetUrl && (
              <>
                <a
                  href={tweetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.twitterLink}
                  onClick={(e) => e.stopPropagation()}
                  title="View on X/Twitter"
                >
                  <ExternalLink size={14} />
                  <span>View</span>
                </a>
                <button
                  className={`${styles.embedButton} ${showFullEmbed ? styles.embedButtonActive : ''}`}
                  onClick={handleShowEmbed}
                  title={showFullEmbed ? 'Hide embed' : 'Show official X embed'}
                >
                  <Twitter size={14} />
                  <span>{showFullEmbed ? 'Hide' : 'Embed'}</span>
                </button>
              </>
            )}

            {/* Similarity badge */}
            {similarity !== undefined && (
              <div className={styles.similarityBadge}>
                <span className={styles.similarityIcon}>~</span>
                <span>{(similarity * 100).toFixed(1)}%</span>
              </div>
            )}

            {/* Feature bars (simplified) */}
            {showFeatures && row.sae_indices && row.sae_acts && (
              <div className={styles.featureContainer}>
                <div className={styles.featureBars}>
                  {row.sae_acts.slice(0, 10).map((act, i) => (
                    <div
                      key={i}
                      className={styles.featureBar}
                      style={{ height: `${Math.min(act * 100, 100)}%` }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(TweetCard);
