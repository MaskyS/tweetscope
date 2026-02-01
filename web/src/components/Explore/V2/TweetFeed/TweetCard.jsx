import { useState, memo, useMemo } from 'react';
import PropTypes from 'prop-types';
import { getClusterColorCSS } from '../DeckGLScatter';
import styles from './TweetCard.module.scss';

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

  const text = row[textColumn] || '';
  const clusterNumber = clusterInfo?.cluster ?? 0;
  const clusterLabel = clusterInfo?.label || `Cluster ${clusterNumber}`;
  const avatarColor = getClusterColorCSS(clusterNumber);

  // Tweet metadata
  const username = row.username;
  const displayName = row.display_name || clusterLabel;
  const favorites = row.favorites;
  const retweets = row.retweets;
  const tweetId = row.id;
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
  const needsTruncation = text.length > 280;

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

  return (
    <div
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

          {/* Metrics row */}
          <div className={styles.metricsRow}>
            {/* Likes */}
            {favorites !== undefined && (
              <div className={styles.metricBadge} title={`${favorites.toLocaleString()} likes`}>
                <span className={styles.metricIcon}>❤️</span>
                <span>{formatCount(favorites)}</span>
              </div>
            )}

            {/* Retweets */}
            {retweets !== undefined && (
              <div className={styles.metricBadge} title={`${retweets.toLocaleString()} retweets`}>
                <span className={styles.metricIcon}>🔄</span>
                <span>{formatCount(retweets)}</span>
              </div>
            )}

            {/* Twitter link */}
            {tweetUrl && (
              <a
                href={tweetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.twitterLink}
                onClick={(e) => e.stopPropagation()}
                title="View on Twitter"
              >
                View
              </a>
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
