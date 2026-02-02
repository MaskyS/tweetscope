import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import styles from './TabHeader.module.scss';

export default function TabHeader({
  categories,
  scrollX,
  columnWidth,
  focusedIndex,
  onTabClick,
  initialOffset,
  tocWidth
}) {
  const [expandedId, setExpandedId] = useState(null);
  // Tabs scroll in sync with content (1:1) to stay aligned with their feeds
  const tabTranslate = initialOffset - scrollX;

  const toggleExpand = (id, e) => {
    e.stopPropagation();
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div className={styles.headerContainer}>
      <div
        className={styles.tabRow}
        style={{ transform: `translateX(${tabTranslate}px)` }}
      >
        {/* Spacer for ToC */}
        <div style={{ flex: `0 0 ${tocWidth}px` }} />
        {categories.map((category, index) => {
          const isFocused = index === focusedIndex;
          const distance = Math.abs(index - focusedIndex);
          const opacity = distance === 0 ? 1 : distance === 1 ? 0.7 : 0.4;
          const isExpanded = expandedId === category.id;

          return (
            <div
              key={category.id}
              className={styles.tabWrapper}
              style={{ width: columnWidth - 32 }}
            >
              <button
                className={`${styles.tab} ${isFocused ? styles.focused : ''}`}
                style={{ opacity }}
                onClick={() => onTabClick(index)}
              >
                <span className={styles.label}>{category.label}</span>
              </button>
              <AnimatePresence>
                {isFocused && (
                  <motion.div
                    className={styles.description}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                  >
                    <p className={`${styles.descriptionText} ${isExpanded ? styles.expanded : ''}`}>
                      {category.description}
                    </p>
                    {category.description.length > 120 && (
                      <button
                        className={styles.readMoreBtn}
                        onClick={(e) => toggleExpand(category.id, e)}
                      >
                        {isExpanded ? 'less' : 'more'}
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}
