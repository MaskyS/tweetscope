/**
 * Sort cluster items by mode, optionally keeping 'unknown' (unclustered) at the end.
 *
 * @param {Array<{cluster: object, originalIndex: number}>} items
 *   Items wrapping a cluster object and its original position.
 * @param {string} mode - 'popular' | 'largest' | 'az' | 'similar'
 * @param {'asc' | 'desc'} [direction]
 * @param {{keepUnclusteredLast?: boolean}} [options]
 * @returns {{
 *   sortedItems: Array<{cluster: object, originalIndex: number}>,
 *   sortToOriginal: number[],
 *   originalToSort: number[],
 *   unclustered: {cluster: object, originalIndex: number} | null
 * }}
 */
function getDisplayCentroidX(cluster) {
  return cluster?.display_centroid_x ?? cluster?.centroid_x;
}

function getDisplayCentroidY(cluster) {
  return cluster?.display_centroid_y ?? cluster?.centroid_y;
}

export const DEFAULT_SORT_DIRECTIONS = {
  popular: 'desc',
  largest: 'desc',
  az: 'asc',
  similar: 'asc',
};

export function sortClusterItems(items, mode, direction, options = {}) {
  const { keepUnclusteredLast = true } = options;
  const sorted = keepUnclusteredLast ? [] : [...items];
  let unc = null;

  if (keepUnclusteredLast) {
    items.forEach((item) => {
      if (String(item.cluster.cluster) === 'unknown') {
        unc = item;
      } else {
        sorted.push(item);
      }
    });
  }

  switch (mode) {
    case 'largest':
      sorted.sort(
        (a, b) =>
          (b.cluster.cumulativeCount || b.cluster.count || 0) -
          (a.cluster.cumulativeCount || a.cluster.count || 0)
      );
      break;
    case 'az':
      sorted.sort((a, b) =>
        (a.cluster.label || '').localeCompare(b.cluster.label || '')
      );
      break;
    case 'similar': {
      const withC = sorted.filter(
        ({ cluster }) => getDisplayCentroidX(cluster) != null && getDisplayCentroidY(cluster) != null
      );
      const noC = sorted.filter(
        ({ cluster }) => getDisplayCentroidX(cluster) == null || getDisplayCentroidY(cluster) == null
      );
      if (withC.length > 0) {
        const cx =
          withC.reduce((s, { cluster }) => s + getDisplayCentroidX(cluster), 0) / withC.length;
        const cy =
          withC.reduce((s, { cluster }) => s + getDisplayCentroidY(cluster), 0) / withC.length;
        withC.sort(
          (a, b) =>
            Math.atan2(getDisplayCentroidY(a.cluster) - cy, getDisplayCentroidX(a.cluster) - cx) -
            Math.atan2(getDisplayCentroidY(b.cluster) - cy, getDisplayCentroidX(b.cluster) - cx)
        );
        sorted.length = 0;
        sorted.push(...withC, ...noC);
      }
      break;
    }
    case 'popular':
    default:
      sorted.sort(
        (a, b) => (b.cluster.cumulativeLikes || 0) - (a.cluster.cumulativeLikes || 0)
      );
      break;
  }

  const defaultDirection = DEFAULT_SORT_DIRECTIONS[mode] || DEFAULT_SORT_DIRECTIONS.popular;
  const resolvedDirection = direction === 'asc' || direction === 'desc' ? direction : defaultDirection;
  if (resolvedDirection !== defaultDirection) {
    sorted.reverse();
  }

  if (keepUnclusteredLast && unc) sorted.push(unc);

  // Build bidirectional index mappings
  const sortToOriginal = sorted.map((r) => r.originalIndex);
  const originalToSort = new Array(items.length);
  sortToOriginal.forEach((origIdx, sortIdx) => {
    originalToSort[origIdx] = sortIdx;
  });

  return { sortedItems: sorted, sortToOriginal, originalToSort, unclustered: unc };
}

/**
 * Convenience: sort raw cluster objects (wraps them with originalIndex automatically).
 */
export function sortClusters(clusters, mode, direction) {
  const items = clusters.map((c, i) => ({ cluster: c, originalIndex: i }));
  const { sortedItems, sortToOriginal, originalToSort } = sortClusterItems(
    items,
    mode,
    direction,
    { keepUnclusteredLast: false }
  );
  return {
    sortedClusters: sortedItems.map((r) => r.cluster),
    sortToOriginal,
    originalToSort,
  };
}
