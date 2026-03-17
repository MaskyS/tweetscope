export const FEED_CAROUSEL_COLUMN_WIDTH = 550;
export const FEED_CAROUSEL_GAP = 32;
export const FEED_CAROUSEL_LIST_WIDTH = 360;
export const FEED_CAROUSEL_PREFETCH_RADIUS = 1;

function clampIndex(index, count) {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

export function getCenterOffset(viewportWidth) {
  return (viewportWidth - FEED_CAROUSEL_COLUMN_WIDTH) / 2;
}

export function getSpacerWidth({ paddingLeft, viewportWidth }) {
  const targetStart = getCenterOffset(viewportWidth);
  const currentStart = paddingLeft + FEED_CAROUSEL_LIST_WIDTH + FEED_CAROUSEL_GAP;
  return Math.max(0, targetStart - currentStart);
}

export function getTrackOffset({ paddingLeft, viewportWidth }) {
  return (
    paddingLeft +
    FEED_CAROUSEL_LIST_WIDTH +
    FEED_CAROUSEL_GAP +
    getSpacerWidth({ paddingLeft, viewportWidth })
  );
}

export function getEffectiveItemWidth() {
  return FEED_CAROUSEL_COLUMN_WIDTH + FEED_CAROUSEL_GAP;
}

export function getClosestSortedIndex(scrollLeft, geometry, count) {
  if (count <= 0) return 0;

  const viewportCenter = geometry.viewportWidth / 2;
  const targetCenter =
    scrollLeft +
    viewportCenter -
    getTrackOffset(geometry) -
    FEED_CAROUSEL_COLUMN_WIDTH / 2;
  const index = Math.round(targetCenter / getEffectiveItemWidth());

  return clampIndex(index, count);
}

export function getScrollTargetForColumn(sortedIndex, geometry) {
  if (sortedIndex <= 0) return 0;

  const columnStart = getTrackOffset(geometry) + sortedIndex * getEffectiveItemWidth();
  return Math.max(0, columnStart - getCenterOffset(geometry.viewportWidth));
}

export function getSnapTargetForScrollLeft(scrollLeft, geometry, count) {
  const sortedIndex = getClosestSortedIndex(scrollLeft, geometry, count);

  return {
    sortedIndex,
    scrollLeft: getScrollTargetForColumn(sortedIndex, geometry),
  };
}

export function getPrefetchOriginalIndices(
  virtualItems,
  sortToOriginal,
  count,
  extraRadius = FEED_CAROUSEL_PREFETCH_RADIUS
) {
  if (!Array.isArray(virtualItems) || virtualItems.length === 0 || count <= 0) {
    return [];
  }

  const start = clampIndex(virtualItems[0]?.index - extraRadius, count);
  const end = clampIndex(virtualItems[virtualItems.length - 1]?.index + extraRadius, count);
  const indices = [];

  for (let sortedIndex = start; sortedIndex <= end; sortedIndex += 1) {
    const originalIndex = sortToOriginal[sortedIndex];
    if (Number.isInteger(originalIndex)) {
      indices.push(originalIndex);
    }
  }

  return indices;
}
