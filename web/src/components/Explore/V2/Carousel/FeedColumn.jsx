import { useCallback } from 'react';
import TweetCard from '../TweetFeed/TweetCard';
import SubClusterPills from './SubClusterPills';
import styles from './FeedColumn.module.scss';

export default function FeedColumn({
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
}) {
  const handleLoadMore = useCallback(() => {
    if (onLoadMore) onLoadMore();
  }, [onLoadMore]);

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
        onSelect={onSubClusterSelect}
      />

      <div className={styles.tweetScroll}>
        {tweets.map((row) => (
          <TweetCard
            key={row.ls_index ?? row.index}
            row={row}
            textColumn={dataset?.text_column}
            clusterInfo={clusterMap?.[row.ls_index]}
            isHighlighted={hoveredIndex === row.ls_index}
            onHover={onHover}
            onClick={onClick}
          />
        ))}

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
