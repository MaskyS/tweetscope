import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEED_CAROUSEL_COLUMN_WIDTH,
  FEED_CAROUSEL_GAP,
  FEED_CAROUSEL_LIST_WIDTH,
  getClosestSortedIndex,
  getEffectiveItemWidth,
  getPrefetchOriginalIndices,
  getSnapTargetForScrollLeft,
  getScrollTargetForColumn,
  getSpacerWidth,
  getTrackOffset,
} from './feedCarouselVirtualization.js';

test('spacer width keeps the first column centered relative to the viewport', () => {
  const geometry = { paddingLeft: 0, viewportWidth: 1440 };

  assert.equal(getSpacerWidth(geometry), 53);
  assert.equal(getTrackOffset(geometry), 445);
});

test('effective item width includes the inter-column gap', () => {
  assert.equal(getEffectiveItemWidth(), FEED_CAROUSEL_COLUMN_WIDTH + FEED_CAROUSEL_GAP);
});

test('column scroll target returns to true start for the first item', () => {
  const geometry = { paddingLeft: 0, viewportWidth: 1440 };

  assert.equal(getScrollTargetForColumn(0, geometry), 0);
  assert.equal(getScrollTargetForColumn(1, geometry), 582);
});

test('closest sorted index tracks the centered column', () => {
  const geometry = { paddingLeft: 0, viewportWidth: 1440 };
  const count = 20;

  assert.equal(getClosestSortedIndex(0, geometry, count), 0);
  assert.equal(getClosestSortedIndex(582, geometry, count), 1);
  assert.equal(getClosestSortedIndex(582 * 3, geometry, count), 3);
  assert.equal(getClosestSortedIndex(999999, geometry, count), count - 1);
});

test('snap target resolves to the nearest centered column offset', () => {
  const geometry = { paddingLeft: 0, viewportWidth: 1440 };
  const count = 20;

  assert.deepEqual(getSnapTargetForScrollLeft(0, geometry, count), {
    sortedIndex: 0,
    scrollLeft: 0,
  });
  assert.deepEqual(getSnapTargetForScrollLeft(400, geometry, count), {
    sortedIndex: 1,
    scrollLeft: 582,
  });
  assert.deepEqual(getSnapTargetForScrollLeft(850, geometry, count), {
    sortedIndex: 1,
    scrollLeft: 582,
  });
});

test('prefetch indices include one extra item on each side of the virtual range', () => {
  const virtualItems = [{ index: 4 }, { index: 5 }, { index: 6 }];
  const sortToOriginal = [10, 11, 12, 13, 14, 15, 16, 17];

  assert.deepEqual(getPrefetchOriginalIndices(virtualItems, sortToOriginal, sortToOriginal.length), [
    13,
    14,
    15,
    16,
    17,
  ]);
});

test('prefetch indices clamp to the list bounds', () => {
  const virtualItems = [{ index: 0 }, { index: 1 }];
  const sortToOriginal = [20, 21, 22];

  assert.deepEqual(getPrefetchOriginalIndices(virtualItems, sortToOriginal, sortToOriginal.length), [
    20,
    21,
    22,
  ]);
});

test('track offset always includes the list width and one inter-region gap', () => {
  const geometry = { paddingLeft: 24, viewportWidth: 1728 };

  assert.equal(
    getTrackOffset(geometry),
    24 + FEED_CAROUSEL_LIST_WIDTH + FEED_CAROUSEL_GAP + getSpacerWidth(geometry)
  );
});
