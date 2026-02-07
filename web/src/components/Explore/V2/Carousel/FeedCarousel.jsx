import { useState, useRef, useCallback, useEffect, useMemo, memo } from 'react';
import { motion } from 'framer-motion';
import TabHeader from './TabHeader';
import CarouselTOC from './CarouselTOC';
import FeedColumn from './FeedColumn';
import ThreadOverlay from './ThreadOverlay';
import styles from './FeedCarousel.module.scss';

const COLUMN_WIDTH = 550;
const GAP = 32;
const TOC_WIDTH = 280;
const PADDING_LEFT = 32;
const VISIBLE_COLUMN_RADIUS = 3;

// Hoisted to avoid new object refs on every render
const MOTION_INITIAL = { opacity: 0, y: 20 };
const MOTION_ANIMATE = { opacity: 1, y: 0 };
const MOTION_TRANSITION = { duration: 0.25 };
const MOTION_STYLE = { flexShrink: 0 };

const getSpacerWidth = () => {
  const targetStart = (window.innerWidth - COLUMN_WIDTH) / 2;
  const currentStart = PADDING_LEFT + TOC_WIDTH + GAP;
  return Math.max(0, targetStart - currentStart);
};

function FeedCarousel({
  topLevelClusters,
  columnData,
  columnRowsMap,
  loadMore,
  activeSubClusters,
  setSubClusterFilter,
  dataset,
  clusterMap,
  focusedClusterIndex,
  onFocusedIndexChange,
  onHover,
  onClick,
  hoveredIndex,
  nodeStats,
  onViewQuotes,
}) {
  const containerRef = useRef(null);
  const scrollRafRef = useRef(null);
  const latestScrollLeftRef = useRef(0);
  const focusedIndexRef = useRef(focusedClusterIndex);
  focusedIndexRef.current = focusedClusterIndex;
  const [scrollX, setScrollX] = useState(0);
  const [spacerWidth, setSpacerWidth] = useState(getSpacerWidth());
  const [overlayTweetId, setOverlayTweetId] = useState(null);
  const [overlayLsIndex, setOverlayLsIndex] = useState(null);
  const initialOffset = PADDING_LEFT;

  // Update spacer on resize
  useEffect(() => {
    const handleResize = () => setSpacerWidth(getSpacerWidth());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    latestScrollLeftRef.current = containerRef.current.scrollLeft;
    if (scrollRafRef.current !== null) return;

    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const scrollLeft = latestScrollLeftRef.current;
      setScrollX((prev) => (prev === scrollLeft ? prev : scrollLeft));

      // Find which column center is closest to viewport center
      const viewportCenter = window.innerWidth / 2;
      const contentBefore = PADDING_LEFT + TOC_WIDTH + GAP + spacerWidth;
      const effectiveWidth = COLUMN_WIDTH + GAP;

      let closestIndex = 0;
      let closestDistance = Infinity;

      for (let i = 0; i < topLevelClusters.length; i++) {
        const columnStart = contentBefore + i * effectiveWidth - scrollLeft;
        const columnCenter = columnStart + COLUMN_WIDTH / 2;
        const distance = Math.abs(columnCenter - viewportCenter);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = i;
        }
      }

      if (closestIndex !== focusedIndexRef.current) {
        onFocusedIndexChange(closestIndex);
      }
    });
  }, [spacerWidth, topLevelClusters.length, onFocusedIndexChange]);

  const scrollToColumn = useCallback(
    (index) => {
      if (!containerRef.current) return;
      const contentBefore = PADDING_LEFT + TOC_WIDTH + GAP + spacerWidth;
      const effectiveWidth = COLUMN_WIDTH + GAP;
      const columnStart = contentBefore + index * effectiveWidth;
      const scrollTarget = columnStart - (window.innerWidth - COLUMN_WIDTH) / 2;
      containerRef.current.scrollTo({
        left: Math.max(0, scrollTarget),
        behavior: 'smooth',
      });
    },
    [spacerWidth]
  );

  const handleSubClusterClick = useCallback(
    (columnIndex, subClusterId) => {
      setSubClusterFilter(columnIndex, subClusterId);
    },
    [setSubClusterFilter]
  );

  const handleOpenThreadOverlay = useCallback((lsIndex) => {
    const tid = nodeStats?.get(lsIndex)?.tweetId;
    if (!tid) return;
    setOverlayTweetId(tid);
    setOverlayLsIndex(lsIndex);
  }, [nodeStats]);

  const handleCloseThreadOverlay = useCallback(() => {
    setOverlayTweetId(null);
    setOverlayLsIndex(null);
  }, []);

  const getFocusState = (index) => {
    const distance = Math.abs(index - focusedClusterIndex);
    if (distance === 0) return 'focused';
    if (distance <= 2) return 'adjacent';
    return 'far';
  };

  const { visibleStart, visibleEnd } = useMemo(() => {
    if (!topLevelClusters?.length) return { visibleStart: 0, visibleEnd: 0 };
    const lastIndex = topLevelClusters.length - 1;
    return {
      visibleStart: Math.max(0, focusedClusterIndex - VISIBLE_COLUMN_RADIUS),
      visibleEnd: Math.min(lastIndex, focusedClusterIndex + VISIBLE_COLUMN_RADIUS),
    };
  }, [focusedClusterIndex, topLevelClusters.length]);

  if (!topLevelClusters?.length) {
    return (
      <div className={styles.emptyCarousel}>
        <p>No hierarchical clusters available for carousel view.</p>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <TabHeader
        clusters={topLevelClusters}
        scrollX={scrollX}
        columnWidth={COLUMN_WIDTH + GAP}
        focusedIndex={focusedClusterIndex}
        onTabClick={scrollToColumn}
        initialOffset={initialOffset}
        tocWidth={TOC_WIDTH + GAP + spacerWidth}
      />

      <div ref={containerRef} className={styles.carousel} onScroll={handleScroll}>
        <CarouselTOC
          topLevelClusters={topLevelClusters}
          focusedIndex={focusedClusterIndex}
          onClickCluster={scrollToColumn}
          onClickSubCluster={handleSubClusterClick}
        />

        {/* Spacer to center first feed */}
        <div className={styles.spacer} style={{ width: spacerWidth }} />

        {topLevelClusters.map((cluster, index) => {
          if (index < visibleStart || index > visibleEnd) {
            return (
              <div
                key={cluster.cluster}
                className={styles.columnPlaceholder}
                style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH }}
                aria-hidden="true"
              />
            );
          }

          const col = columnData[index] || {};
          const tweets = columnRowsMap[index] || [];

          return (
            <motion.div
              key={cluster.cluster}
              initial={MOTION_INITIAL}
              animate={MOTION_ANIMATE}
              transition={MOTION_TRANSITION}
              style={MOTION_STYLE}
            >
              <FeedColumn
                columnIndex={index}
                cluster={cluster}
                tweets={tweets}
                focusState={getFocusState(index)}
                columnWidth={COLUMN_WIDTH}
                subClusters={cluster.children}
                activeSubCluster={activeSubClusters[index] || null}
                onSubClusterSelect={handleSubClusterClick}
                dataset={dataset}
                clusterMap={clusterMap}
                loading={col.loading}
                hasMore={col.hasMore}
                onLoadMore={loadMore}
                onHover={onHover}
                onClick={onClick}
                hoveredIndex={hoveredIndex}
                nodeStats={nodeStats}
                onViewThread={handleOpenThreadOverlay}
                onViewQuotes={onViewQuotes}
              />
            </motion.div>
          );
        })}
      </div>

      <ThreadOverlay
        open={!!overlayTweetId}
        dataset={dataset}
        tweetId={overlayTweetId}
        currentLsIndex={overlayLsIndex}
        nodeStats={nodeStats}
        clusterMap={clusterMap}
        onClose={handleCloseThreadOverlay}
        onViewThread={handleOpenThreadOverlay}
        onViewQuotes={onViewQuotes}
      />
    </div>
  );
}

export default memo(FeedCarousel);
