import { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react';
import { ChevronDown } from 'lucide-react';
import { groupRowsByThread } from '../../../../lib/groupRowsByThread';
import { EMBED_PRIORITY } from '../../../../lib/embedScheduler';
import { useScope } from '../../../../contexts/ScopeContext';
import { EmbedPriorityProvider } from '../../../../contexts/EmbedPriorityContext';
import TweetCard from '../TweetFeed/TweetCard';
import ThreadGroup from '../TweetFeed/ThreadGroup';
import StandaloneWithAncestors from '../TweetFeed/StandaloneWithAncestors';
import SubClusterPills from './SubClusterPills';
import { useClusterColorMap } from '../../../../contexts/ClusterColorContext';
import { resolveClusterColorCSS } from '../../../../hooks/useClusterColors';
import { useColorMode } from '../../../../hooks/useColorMode';
import styles from './FeedColumn.module.scss';

const FOCUS_TO_PRIORITY = {
  focused: EMBED_PRIORITY.FOCUSED,
  adjacent: EMBED_PRIORITY.ADJACENT,
  far: EMBED_PRIORITY.FAR,
};

const INITIAL_RENDER_BUDGET = 10;
const RENDER_CHUNK_SIZE = 20;

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
  nodeStats,
  onViewThread,
  onViewQuotes,
}) {
  const { scope } = useScope();
  const colorMap = useClusterColorMap();
  const { isDark } = useColorMode();
  const clusterColor = cluster?.cluster != null
    ? resolveClusterColorCSS(colorMap, cluster.cluster, isDark)
    : undefined;
  const [descExpanded, setDescExpanded] = useState(false);
  const [renderBudget, setRenderBudget] = useState(INITIAL_RENDER_BUDGET);
  const sentinelRef = useRef(null);
  const tweetScrollRef = useRef(null);

  // Reset render budget when the available list shrinks under the current budget.
  useEffect(() => {
    if (renderBudget !== INITIAL_RENDER_BUDGET && tweets.length < renderBudget) {
      setRenderBudget(INITIAL_RENDER_BUDGET);
    }
  }, [tweets.length, renderBudget]);

  const handleLoadMore = useCallback(() => {
    if (onLoadMore) onLoadMore(columnIndex);
  }, [onLoadMore, columnIndex]);

  const handleSelectSubCluster = useCallback(
    (subClusterId) => {
      if (onSubClusterSelect) onSubClusterSelect(columnIndex, subClusterId);
    },
    [onSubClusterSelect, columnIndex]
  );

  const groupedItems = useMemo(
    () => groupRowsByThread(tweets, nodeStats),
    [tweets, nodeStats]
  );

  // Slice groupedItems to render budget, respecting thread integrity
  const visibleItems = useMemo(() => {
    if (groupedItems.length <= renderBudget) return groupedItems;

    let count = 0;
    let cutoff = groupedItems.length;
    for (let i = 0; i < groupedItems.length; i++) {
      const item = groupedItems[i];
      const itemSize = item.type === 'thread' ? item.rows.length : 1;
      count += itemSize;
      // If adding this item would exceed budget, check if it's a thread group
      // straddling the boundary — include it fully to preserve thread integrity
      if (count >= renderBudget) {
        cutoff = i + 1; // include this item
        break;
      }
    }
    return groupedItems.slice(0, cutoff);
  }, [groupedItems, renderBudget]);

  const hasMoreToReveal = visibleItems.length < groupedItems.length;

  // IntersectionObserver sentinel to progressively reveal more items
  useEffect(() => {
    if (!hasMoreToReveal) return;
    const sentinel = sentinelRef.current;
    const tweetScroll = tweetScrollRef.current;
    if (!sentinel || !tweetScroll) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setRenderBudget((prev) => prev + RENDER_CHUNK_SIZE);
        }
      },
      {
        root: tweetScroll,
        rootMargin: '200px 0px',
      }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreToReveal]);

  const embedPriority = FOCUS_TO_PRIORITY[focusState] ?? EMBED_PRIORITY.FAR;

  return (
    <EmbedPriorityProvider value={embedPriority}>
    <div
      className={`${styles.columnOuter} ${styles[focusState]}`}
      style={{ width: columnWidth, minWidth: columnWidth }}
    >
      <div className={styles.columnHeader} style={{ '--col-color': clusterColor || 'transparent' }}>
        <div className={styles.columnHeaderTop}>
          <span className={styles.colorDot} />
          <h3 className={styles.clusterLabel}>{cluster?.label}</h3>
          {cluster?.count > 0 && (
            <span className={styles.clusterCount}>{cluster.count} tweets</span>
          )}
        </div>
        {cluster?.description && (
          <div className={styles.descriptionWrap}>
            <p className={`${styles.descText} ${descExpanded ? styles.expanded : ''}`}>
              {cluster.description}
            </p>
            {cluster.description.length > 120 && (
              <button
                className={styles.moreBtn}
                onClick={() => setDescExpanded((v) => !v)}
              >
                {descExpanded ? 'less' : 'more'}
              </button>
            )}
          </div>
        )}
      </div>

      <div className={styles.column}>
        <SubClusterPills
          subClusters={subClusters}
          activeSubCluster={activeSubCluster}
          onSelect={handleSelectSubCluster}
        />

        <div ref={tweetScrollRef} className={styles.tweetScroll}>
          <div className={styles.feedList}>
            {visibleItems.map((item) => {
              if (item.type === 'thread') {
                return (
                  <ThreadGroup
                    key={`thread-${item.threadRootId}`}
                    rows={item.rows}
                    threadRootId={item.threadRootId}
                    textColumn={dataset?.text_column}
                    clusterMap={clusterMap}
                    nodeStats={nodeStats}
                    onViewThread={onViewThread}
                    onViewQuotes={onViewQuotes}
                    hasMissingAncestors={item.hasMissingAncestors}
                    missingAncestorCount={item.missingAncestorCount}
                    globalThreadSize={item.globalThreadSize}
                    visibleCount={item.visibleCount}
                    borderless
                  />
                );
              }
              const row = item.row;
              if (item.hasMissingAncestors) {
                return (
                  <StandaloneWithAncestors
                    key={row.ls_index ?? row.index}
                    row={row}
                    textColumn={dataset?.text_column}
                    clusterMap={clusterMap}
                    nodeStats={nodeStats}
                    onViewThread={onViewThread}
                    onViewQuotes={onViewQuotes}
                    datasetId={dataset?.id}
                    scopeId={scope?.id}
                    dataset={dataset}
                  />
                );
              }
              return (
                <TweetCard
                  key={row.ls_index ?? row.index}
                  row={row}
                  textColumn={dataset?.text_column}
                  clusterInfo={clusterMap?.[row.ls_index]}
                  nodeStats={nodeStats?.get(row.ls_index)}
                  onViewThread={onViewThread}
                  onViewQuotes={onViewQuotes}
                />
              );
            })}
          </div>

          {/* Sentinel for progressive rendering */}
          {hasMoreToReveal && (
            <div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" />
          )}

          {loading && (
            <div className={styles.loadMoreWrap}>
              <div className={styles.spinner} />
            </div>
          )}

          {hasMore && !loading && (
            <div className={styles.loadMoreWrap}>
              <button className={styles.loadMoreBtn} onClick={handleLoadMore}>
                <ChevronDown size={14} />
                Load more tweets
              </button>
            </div>
          )}

          {!loading && tweets.length === 0 && !hasMore && (
            <div className={styles.emptyState}>No tweets in this cluster</div>
          )}

          {!loading && tweets.length === 0 && hasMore && (
            <div className={styles.emptyState}>Loading tweets...</div>
          )}
        </div>
      </div>
    </div>
    </EmbedPriorityProvider>
  );
}

export default memo(FeedColumn);
