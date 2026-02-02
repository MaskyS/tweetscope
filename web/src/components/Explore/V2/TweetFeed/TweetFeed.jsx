import { useCallback } from 'react';
import PropTypes from 'prop-types';
import { useFilter } from '../../../../contexts/FilterContext';
import TweetCard from './TweetCard';
import styles from './TweetFeed.module.scss';

TweetFeed.propTypes = {
  dataset: PropTypes.object.isRequired,
  distances: PropTypes.array,
  clusterMap: PropTypes.object,
  sae_id: PropTypes.string,
  onHover: PropTypes.func,
  onClick: PropTypes.func,
  hoveredIndex: PropTypes.number,
  dateColumn: PropTypes.string,
};

function TweetFeed({
  dataset,
  distances = [],
  clusterMap = {},
  sae_id = null,
  onHover = () => {},
  onClick = () => {},
  hoveredIndex = null,
  dateColumn = null,
}) {
  const { dataTableRows, page, setPage, totalPages, loading } = useFilter();

  // Load more button
  const handleLoadMore = useCallback(() => {
    if (page < totalPages - 1 && !loading) {
      setPage((prev) => prev + 1);
    }
  }, [page, totalPages, loading, setPage]);

  const hasMore = page < totalPages - 1;

  if (!dataTableRows || dataTableRows.length === 0) {
    return (
      <div className={styles.tweetFeedContainer}>
        <div className={styles.emptyState}>
          {loading ? 'Loading...' : 'No data to display'}
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.tweetFeedContainer} ${loading ? styles.loading : ''}`}>
      {loading && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingSpinner}></div>
        </div>
      )}

      <div className={styles.tweetList}>
        {dataTableRows.map((row) => {
          const clusterInfo = clusterMap[row.ls_index];
          const similarity = distances.length > 0 ? 1 - distances[row.idx] : undefined;
          const isHighlighted = hoveredIndex === row.ls_index;

          return (
            <TweetCard
              key={row.ls_index}
              row={row}
              textColumn={dataset.text_column}
              dateColumn={dateColumn}
              clusterInfo={clusterInfo}
              similarity={similarity}
              isHighlighted={isHighlighted}
              onHover={onHover}
              onClick={onClick}
              showFeatures={!!sae_id}
            />
          );
        })}
      </div>

      {hasMore && (
        <button
          className={styles.loadMoreBtn}
          onClick={handleLoadMore}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Load More'}
        </button>
      )}
    </div>
  );
}

export default TweetFeed;
