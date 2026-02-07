import { useState, useRef, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import TabHeader from './TabHeader';
import CarouselTOC from './CarouselTOC';
import FeedColumn from './FeedColumn';
import styles from './FeedCarousel.module.scss';

const COLUMN_WIDTH = 550;
const GAP = 32;
const TOC_WIDTH = 280;
const PADDING_LEFT = 32;

const getSpacerWidth = () => {
  const targetStart = (window.innerWidth - COLUMN_WIDTH) / 2;
  const currentStart = PADDING_LEFT + TOC_WIDTH + GAP;
  return Math.max(0, targetStart - currentStart);
};

export default function FeedCarousel({
  topLevelClusters,
  columnData,
  getColumnRows,
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
}) {
  const containerRef = useRef(null);
  const [scrollX, setScrollX] = useState(0);
  const [spacerWidth, setSpacerWidth] = useState(getSpacerWidth());
  const initialOffset = PADDING_LEFT;

  // Update spacer on resize
  useEffect(() => {
    const handleResize = () => setSpacerWidth(getSpacerWidth());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const scrollLeft = containerRef.current.scrollLeft;
    setScrollX(scrollLeft);

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

    if (closestIndex !== focusedClusterIndex) {
      onFocusedIndexChange(closestIndex);
    }
  }, [spacerWidth, topLevelClusters.length, focusedClusterIndex, onFocusedIndexChange]);

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

  const getFocusState = (index) => {
    const distance = Math.abs(index - focusedClusterIndex);
    if (distance === 0) return 'focused';
    if (distance <= 2) return 'adjacent';
    return 'far';
  };

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
          const col = columnData[index] || {};
          const tweets = getColumnRows(index);

          return (
            <motion.div
              key={cluster.cluster}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05, duration: 0.3 }}
              style={{ flexShrink: 0 }}
            >
              <FeedColumn
                cluster={cluster}
                tweets={tweets}
                focusState={getFocusState(index)}
                columnWidth={COLUMN_WIDTH}
                subClusters={cluster.children}
                activeSubCluster={activeSubClusters[index] || null}
                onSubClusterSelect={(subId) => setSubClusterFilter(index, subId)}
                dataset={dataset}
                clusterMap={clusterMap}
                loading={col.loading}
                hasMore={col.hasMore}
                onLoadMore={() => loadMore(index)}
                onHover={onHover}
                onClick={onClick}
                hoveredIndex={hoveredIndex}
              />
            </motion.div>
          );
        })}
      </div>

      <div className={styles.fadeRight} />
    </div>
  );
}
