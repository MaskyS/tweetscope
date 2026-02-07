import { useCallback, memo } from 'react';
import TweetCard from '../TweetFeed/TweetCard';
import SubClusterPills from './SubClusterPills';
import styles from './FeedColumn.module.scss';

function FeedColumn({
  columnIndex,
  cluster,
  tweets,
  focusState,
  columnWidth,
  subClusters,
  activeSubCluster,
  onSubClusterSelect,
  dataset,
  clusterMap,
  loading,
  hasMore,
  onLoadMore,
  onHover,
  onClick,
  hoveredIndex,
  nodeStats,
  onViewThread,
  onViewQuotes,
}) {
  const handleLoadMore = useCallback(() => {
    if (onLoadMore) onLoadMore(columnIndex);
  }, [onLoadMore, columnIndex]);

  const handleSelectSubCluster = useCallback(
    (subClusterId) => {
      if (onSubClusterSelect) onSubClusterSelect(columnIndex, subClusterId);
    },
    [onSubClusterSelect, columnIndex]
  );

  return (
    <div
      className={`${styles.column} ${styles[focusState]}`}
      style={{ width: columnWidth, minWidth: columnWidth }}
    >
      <div className={styles.columnHeader}>
        <h3 className={styles.clusterLabel}>{cluster?.label}</h3>
        {cluster?.count > 0 && (
          <span className={styles.clusterCount}>{cluster.count} tweets</span>
        )}
      </div>

      <SubClusterPills
        subClusters={subClusters}
        activeSubCluster={activeSubCluster}
        onSelect={handleSelectSubCluster}
      />

      <div className={styles.tweetScroll}>
        {tweets.map((row) => {
          const rowStats = nodeStats?.get(row.ls_index);
          return (
            <div
              key={row.ls_index ?? row.index}
              className={rowStats?.threadDepth > 0 ? styles.replyDepthIndicator : undefined}
            >
              <TweetCard
                row={row}
                textColumn={dataset?.text_column}
                clusterInfo={clusterMap?.[row.ls_index]}
                isHighlighted={hoveredIndex === row.ls_index}
                onHover={onHover}
                onClick={onClick}
                nodeStats={rowStats}
                onViewThread={onViewThread ? () => onViewThread(row.ls_index) : undefined}
                onViewQuotes={onViewQuotes ? () => onViewQuotes(row.ls_index) : undefined}
              />
            </div>
          );
        })}

        {loading && (
          <div className={styles.loadingRow}>
            <div className={styles.spinner} />
          </div>
        )}

        {hasMore && !loading && (
          <button className={styles.loadMoreBtn} onClick={handleLoadMore}>
            Load more
          </button>
        )}

        {!loading && tweets.length === 0 && (
          <div className={styles.emptyState}>No tweets in this cluster</div>
        )}
      </div>
    </div>
  );
}

export default memo(FeedColumn);
