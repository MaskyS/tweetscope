import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import styles from './TabHeader.module.scss';

export default function TabHeader({
  clusters,
  scrollX,
  columnWidth,
  focusedIndex,
  onTabClick,
  initialOffset,
  tocWidth,
}) {
  const [expandedDesc, setExpandedDesc] = useState(null);

  const tabTranslate = initialOffset - scrollX;

  return (
    <div className={styles.header}>
      <div
        className={styles.tabRow}
        style={{
          transform: `translateX(${tabTranslate}px)`,
          paddingLeft: tocWidth,
        }}
      >
        {clusters.map((cluster, index) => {
          const isFocused = index === focusedIndex;
          const distance = Math.abs(index - focusedIndex);
          const opacity = distance === 0 ? 1 : distance === 1 ? 0.7 : 0.4;

          return (
            <button
              key={cluster.cluster}
              className={`${styles.tab} ${isFocused ? styles.focused : ''}`}
              style={{ width: columnWidth, opacity }}
              onClick={() => onTabClick(index)}
            >
              <span className={styles.tabLabel}>{cluster.label}</span>

              <AnimatePresence>
                {isFocused && cluster.description && (
                  <motion.div
                    className={styles.tabDescription}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                  >
                    <p
                      className={`${styles.descText} ${expandedDesc === index ? styles.expanded : ''}`}
                    >
                      {cluster.description}
                    </p>
                    {cluster.description?.length > 120 && (
                      <button
                        className={styles.moreBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedDesc(expandedDesc === index ? null : index);
                        }}
                      >
                        {expandedDesc === index ? 'less' : 'more'}
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </button>
          );
        })}
      </div>
    </div>
  );
}
