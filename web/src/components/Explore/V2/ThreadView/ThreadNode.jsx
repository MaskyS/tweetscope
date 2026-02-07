import { memo } from 'react';
import { ExternalLink } from 'lucide-react';
import TweetCard from '../TweetFeed/TweetCard';
import styles from './ThreadView.module.scss';

/**
 * Renders a single node in the thread view.
 * - Internal tweets (with row data) render as a compact TweetCard
 * - External tweets (no ls_index) render as a placeholder
 */
function ThreadNode({
  node,
  isCurrent = false,
  isMuted = false,
  depth = 0,
  dataset,
  clusterMap,
  nodeStats,
  onViewThread,
  onViewQuotes,
  maxIndent = 4,
}) {
  const indentLevel = Math.min(depth, maxIndent);
  const hasRow = node.row != null;
  const tweetId = node.tweet_id;
  const lsIndex = node.ls_index;

  const username = hasRow ? (node.row.username || node.row.display_name) : null;
  const twitterUrl = username && tweetId
    ? `https://twitter.com/${username}/status/${tweetId}`
    : tweetId
      ? `https://twitter.com/i/web/status/${tweetId}`
      : null;

  return (
    <div
      className={`${styles.threadNode} ${isCurrent ? styles.current : ''} ${isMuted ? styles.muted : ''}`}
      style={{ marginLeft: `${indentLevel * 20}px` }}
    >
      {/* Thread connector line */}
      {indentLevel > 0 && (
        <div className={styles.connectorLine} style={{ left: `${(indentLevel - 1) * 20 + 10}px` }} />
      )}

      {hasRow ? (
        <div className={styles.internalTweet}>
          <TweetCard
            row={node.row}
            textColumn={dataset?.text_column}
            clusterInfo={clusterMap?.[lsIndex]}
            nodeStats={nodeStats?.get(lsIndex)}
            onViewThread={onViewThread && lsIndex != null ? () => onViewThread(lsIndex) : undefined}
            onViewQuotes={onViewQuotes && lsIndex != null ? () => onViewQuotes(lsIndex) : undefined}
          />
        </div>
      ) : (
        <div className={styles.externalTweet}>
          <div className={styles.externalContent}>
            <span className={styles.externalLabel}>Tweet not in dataset</span>
            {twitterUrl && (
              <a
                href={twitterUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.externalLink}
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink size={13} />
                <span>View on Twitter</span>
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ThreadNode);
