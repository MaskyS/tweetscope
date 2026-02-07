import { useEffect, useRef } from 'react';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import useThreadData from '../../../../hooks/useThreadData';
import ThreadNode from './ThreadNode';
import styles from './ThreadView.module.scss';

/**
 * Thread reading panel that replaces TopicTree + TweetFeed in the sidebar
 * when the user clicks "View Thread" on a connected tweet.
 */
export default function ThreadView({
  datasetId,
  tweetId,
  currentLsIndex,
  nodeStats,
  clusterMap,
  dataset,
  onBack,
  onViewThread,
  onViewQuotes,
  showHeader = true,
  onThreadDataChange,
}) {
  const {
    parentChain,
    currentTweet,
    descendants,
    edges,
    internalIndices,
    loading,
    error,
    tweetCount,
  } = useThreadData(datasetId, tweetId, currentLsIndex, !!tweetId);

  const scrollRef = useRef(null);
  const currentRef = useRef(null);

  // Auto-scroll to the current tweet when thread loads
  useEffect(() => {
    if (!loading && currentRef.current && scrollRef.current) {
      const timer = setTimeout(() => {
        currentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [loading, tweetId]);

  useEffect(() => {
    if (!onThreadDataChange) return;
    onThreadDataChange({
      internalIndices,
      edges,
      loading,
      error,
    });
  }, [internalIndices, edges, loading, error, onThreadDataChange]);

  return (
    <div className={styles.threadView}>
      {/* Header */}
      {showHeader && (
        <div className={styles.header}>
          <button className={styles.backButton} onClick={onBack} type="button">
            <ArrowLeft size={16} />
            <span>Back to feed</span>
          </button>
          <div className={styles.headerInfo}>
            <MessageSquare size={14} />
            <span>
              {loading ? 'Loading thread...' : `Thread (${tweetCount} tweets)`}
            </span>
          </div>
        </div>
      )}

      {/* Thread content */}
      <div className={styles.scrollContainer} ref={scrollRef}>
        {error && (
          <div className={styles.errorState}>
            Failed to load thread. <button onClick={onBack}>Go back</button>
          </div>
        )}

        {loading && (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <span>Loading thread...</span>
          </div>
        )}

        {!loading && !error && (
          <div className={styles.threadContent}>
            {/* Parent chain (ancestors — muted) */}
            {parentChain.length > 0 && (
              <div className={styles.parentSection}>
                {parentChain.map((node) => (
                  <ThreadNode
                    key={node.tweet_id}
                    node={node}
                    isMuted
                    depth={0}
                    dataset={dataset}
                    clusterMap={clusterMap}
                    nodeStats={nodeStats}
                    onViewThread={onViewThread}
                    onViewQuotes={onViewQuotes}
                  />
                ))}
              </div>
            )}

            {/* Current tweet (highlighted) */}
            {currentTweet && (
              <div ref={currentRef}>
                <ThreadNode
                  node={currentTweet}
                  isCurrent
                  depth={0}
                  dataset={dataset}
                  clusterMap={clusterMap}
                  nodeStats={nodeStats}
                  onViewThread={onViewThread}
                  onViewQuotes={onViewQuotes}
                />
              </div>
            )}

            {/* Descendants (replies) */}
            {descendants.length > 0 && (
              <div className={styles.descendantsSection}>
                {descendants.map((node) => (
                  <ThreadNode
                    key={node.tweet_id}
                    node={node}
                    depth={node.depth}
                    dataset={dataset}
                    clusterMap={clusterMap}
                    nodeStats={nodeStats}
                    onViewThread={onViewThread}
                    onViewQuotes={onViewQuotes}
                  />
                ))}
              </div>
            )}

            {/* Empty state — no thread found */}
            {!loading && parentChain.length === 0 && descendants.length === 0 && currentTweet && (
              <div className={styles.emptyState}>
                This tweet does not appear to be part of a thread.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
