import { useCallback, useMemo, useRef, useEffect } from 'react';
import { VariableSizeList as List } from 'react-window';
import PropTypes from 'prop-types';
import { useFilter } from '../../../../contexts/FilterContext';
import TweetCard from './TweetCard';
import styles from './TweetFeed.module.scss';

TweetFeed.propTypes = {
  dataset: PropTypes.object.isRequired,
  distances: PropTypes.array,
  clusterMap: PropTypes.object,
  sae_id: PropTypes.string,
  feature: PropTypes.number,
  features: PropTypes.array,
  onHover: PropTypes.func,
  onClick: PropTypes.func,
  hoveredIndex: PropTypes.number,
  height: PropTypes.number,
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
  height = 600,
  dateColumn = null,
}) {
  const { dataTableRows, page, setPage, totalPages, loading } = useFilter();
  const listRef = useRef(null);
  const rowHeights = useRef({});

  // Calculate row height based on content
  const getRowHeight = useCallback(
    (index) => {
      if (rowHeights.current[index]) {
        return rowHeights.current[index];
      }

      const row = dataTableRows[index];
      if (!row) return 100;

      const text = row[dataset.text_column] || '';
      const textLength = text.length;

      // Base height for avatar + header
      const baseHeight = 70;
      // Estimate text height (roughly 60 chars per line, 20px per line, max 4 lines when truncated)
      const lines = Math.min(Math.ceil(textLength / 50), 4);
      const textHeight = lines * 22;
      // Metrics row (always present now with likes/retweets/twitter link)
      const metricsHeight = 40;
      // Padding
      const padding = 24;

      const totalHeight = baseHeight + textHeight + metricsHeight + padding;
      rowHeights.current[index] = totalHeight;

      return totalHeight;
    },
    [dataTableRows, dataset.text_column]
  );

  // Reset row heights when data changes
  useEffect(() => {
    rowHeights.current = {};
    if (listRef.current) {
      listRef.current.resetAfterIndex(0);
    }
  }, [dataTableRows]);

  // Handle scroll to load more
  const handleScroll = useCallback(
    ({ scrollOffset, scrollUpdateWasRequested }) => {
      if (scrollUpdateWasRequested) return;

      const listHeight = height;
      const totalHeight = dataTableRows.reduce((acc, _, i) => acc + getRowHeight(i), 0);

      // Load next page when near bottom (within 200px)
      if (scrollOffset + listHeight > totalHeight - 200) {
        if (page < totalPages - 1 && !loading) {
          setPage((prev) => prev + 1);
        }
      }
    },
    [height, dataTableRows, getRowHeight, page, totalPages, loading, setPage]
  );

  // Row renderer for react-window
  const Row = useCallback(
    ({ index, style }) => {
      const row = dataTableRows[index];
      if (!row) return null;

      const clusterInfo = clusterMap[row.ls_index];
      const similarity = distances.length > 0 ? 1 - distances[row.idx] : undefined;
      const isHighlighted = hoveredIndex === row.ls_index;

      return (
        <div style={style}>
          <TweetCard
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
        </div>
      );
    },
    [dataTableRows, clusterMap, distances, hoveredIndex, dataset.text_column, dateColumn, onHover, onClick, sae_id]
  );

  // Pagination controls
  const renderPagination = useMemo(() => {
    if (totalPages <= 1) return null;

    return (
      <div className={styles.pagination}>
        <button onClick={() => setPage(0)} disabled={page === 0}>
          First
        </button>
        <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
          Prev
        </button>
        <span>
          Page {page + 1} of {totalPages}
        </span>
        <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}>
          Next
        </button>
        <button onClick={() => setPage(totalPages - 1)} disabled={page === totalPages - 1}>
          Last
        </button>
      </div>
    );
  }, [page, totalPages, setPage]);

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

      <List
        ref={listRef}
        height={height - 50} // Account for pagination
        itemCount={dataTableRows.length}
        itemSize={getRowHeight}
        width="100%"
        onScroll={handleScroll}
        className={styles.tweetList}
      >
        {Row}
      </List>

      {renderPagination}
    </div>
  );
}

export default TweetFeed;
