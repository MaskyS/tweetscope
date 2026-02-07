import { useState, useCallback, useRef, useEffect, memo } from 'react';
import styles from './CarouselTOC.module.scss';

function CarouselTOC({
  topLevelClusters,
  focusedIndex,
  onClickCluster,
  onClickSubCluster,
}) {
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const hoverTimeoutRef = useRef(null);

  const handleMouseEnter = useCallback((index) => {
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredIndex(index);
    }, 800);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setHoveredIndex(null);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }
    };
  }, []);

  if (!topLevelClusters?.length) return null;

  return (
    <div className={styles.toc} role="navigation" aria-label="Topic navigation">
      <div className={styles.tocList}>
        {topLevelClusters.map((cluster, index) => (
          <div
            key={cluster.cluster}
            className={styles.tocGroup}
            onMouseEnter={() => handleMouseEnter(index)}
            onMouseLeave={handleMouseLeave}
          >
            {/* Hover tooltip */}
            {hoveredIndex === index && cluster.description && (
              <div className={styles.tooltip}>{cluster.description}</div>
            )}

            {/* Top-level cluster */}
            <button
              className={`${styles.tocItem} ${index === focusedIndex ? styles.active : ''}`}
              onClick={() => onClickCluster(index)}
            >
              <span className={styles.tocLabel}>{cluster.label}</span>
              <span className={styles.tocCount}>{cluster.count || cluster.cumulativeCount || 0}</span>
            </button>

            {/* Sub-clusters (indented) */}
            {cluster.children?.length > 0 && (
              <div className={styles.subList}>
                {cluster.children.map((sub) => (
                  <div key={sub.cluster}>
                    <button
                      className={styles.subItem}
                      onClick={() => {
                        onClickCluster(index);
                        if (onClickSubCluster) onClickSubCluster(index, sub.cluster);
                      }}
                    >
                      <span className={styles.subLabel}>{sub.label}</span>
                      <span className={styles.subCount}>{sub.count || 0}</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default memo(CarouselTOC);
