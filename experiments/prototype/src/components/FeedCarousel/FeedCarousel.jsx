import { useState, useRef, useCallback, useEffect } from 'react';
import TabHeader from '../TabHeader/TabHeader';
import FeedColumn from '../FeedColumn/FeedColumn';
import { categories, getTweetsForCategory } from '../../data/visakanvData';
import styles from './FeedCarousel.module.scss';

const COLUMN_WIDTH = 400;
const GAP = 32;
const TOC_WIDTH = 280;
const PADDING_LEFT = 32;

// Calculate spacer width to center first feed
// First feed should start at (viewport - column) / 2
// Currently starts at: padding + toc + gap = 32 + 280 + 32 = 344
const getSpacerWidth = () => {
  const targetStart = (window.innerWidth - COLUMN_WIDTH) / 2;
  const currentStart = PADDING_LEFT + TOC_WIDTH + GAP;
  return Math.max(0, targetStart - currentStart);
};

const getInitialOffset = () => PADDING_LEFT;

export default function FeedCarousel() {
  const containerRef = useRef(null);
  const [scrollX, setScrollX] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [tweetsByCategory, setTweetsByCategory] = useState({});
  const [initialOffset, setInitialOffset] = useState(getInitialOffset());
  const [spacerWidth, setSpacerWidth] = useState(getSpacerWidth());
  const [hoveredTocIndex, setHoveredTocIndex] = useState(null);
  const hoverTimeoutRef = useRef(null);

  useEffect(() => {
    const tweets = {};
    categories.forEach(cat => {
      tweets[cat.id] = getTweetsForCategory(cat.id);
    });
    setTweetsByCategory(tweets);

    // Update dimensions on resize
    const handleResize = () => {
      setInitialOffset(getInitialOffset());
      setSpacerWidth(getSpacerWidth());
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const scrollLeft = containerRef.current.scrollLeft;
    setScrollX(scrollLeft);

    // Calculate focused index based on which column center is closest to viewport center
    const viewportCenter = window.innerWidth / 2;
    const contentBeforeFeeds = PADDING_LEFT + TOC_WIDTH + GAP + spacerWidth;
    const effectiveColumnWidth = COLUMN_WIDTH + GAP;

    // Find which column is closest to viewport center
    let closestIndex = 0;
    let closestDistance = Infinity;

    for (let i = 0; i < categories.length; i++) {
      const columnStart = contentBeforeFeeds + i * effectiveColumnWidth - scrollLeft;
      const columnCenter = columnStart + COLUMN_WIDTH / 2;
      const distance = Math.abs(columnCenter - viewportCenter);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = i;
      }
    }

    setFocusedIndex(closestIndex);
  }, [spacerWidth]);

  const handleTabClick = useCallback((index) => {
    if (!containerRef.current) return;
    // Scroll so the clicked column is centered
    const contentBeforeFeeds = PADDING_LEFT + TOC_WIDTH + GAP + spacerWidth;
    const effectiveColumnWidth = COLUMN_WIDTH + GAP;
    const columnStart = contentBeforeFeeds + index * effectiveColumnWidth;
    const scrollTarget = columnStart - (window.innerWidth - COLUMN_WIDTH) / 2;
    containerRef.current.scrollTo({
      left: Math.max(0, scrollTarget),
      behavior: 'smooth'
    });
  }, [spacerWidth]);

  const getFocusState = (index) => {
    const distance = Math.abs(index - focusedIndex);
    if (distance === 0) return 'focused';
    if (distance <= 2) return 'adjacent';
    return 'far';
  };

  const handleTocMouseEnter = useCallback((index) => {
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredTocIndex(index);
    }, 1000);
  }, []);

  const handleTocMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setHoveredTocIndex(null);
  }, []);

  return (
    <div className={styles.wrapper}>
      <TabHeader
        categories={categories}
        scrollX={scrollX}
        columnWidth={COLUMN_WIDTH + GAP}
        focusedIndex={focusedIndex}
        onTabClick={handleTabClick}
        initialOffset={initialOffset}
        tocWidth={TOC_WIDTH + GAP + spacerWidth}
      />
      <div
        ref={containerRef}
        className={styles.carousel}
        onScroll={handleScroll}
      >
        <nav className={styles.toc}>
          <ul className={styles.tocList}>
            {categories.map((category, index) => (
              <li
                key={category.id}
                className={styles.tocListItem}
                onMouseEnter={() => handleTocMouseEnter(index)}
                onMouseLeave={handleTocMouseLeave}
              >
                {hoveredTocIndex === index && (
                  <p className={styles.tocDesc}>{category.description}</p>
                )}
                <button
                  className={`${styles.tocItem} ${index === focusedIndex ? styles.tocActive : ''}`}
                  onClick={() => handleTabClick(index)}
                >
                  {category.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {/* Spacer to center the first feed */}
        <div className={styles.spacer} style={{ width: spacerWidth }} />
        {categories.map((category, index) => (
          <FeedColumn
            key={category.id}
            tweets={tweetsByCategory[category.id] || []}
            focusState={getFocusState(index)}
            columnWidth={COLUMN_WIDTH}
          />
        ))}
      </div>
      <div className={styles.fadeRight} />
    </div>
  );
}
