import assert from 'node:assert/strict';
import test from 'node:test';

import { sortClusterItems, sortClusters } from './sortClusters.js';

test('sortClusterItems keeps the unclustered bucket at the end by default', () => {
  const items = [
    { cluster: { cluster: 'unknown', label: 'Unclustered', cumulativeLikes: 999 }, originalIndex: 0 },
    { cluster: { cluster: 'a', label: 'Alpha', cumulativeLikes: 10 }, originalIndex: 1 },
    { cluster: { cluster: 'b', label: 'Beta', cumulativeLikes: 20 }, originalIndex: 2 },
  ];

  const result = sortClusterItems(items, 'popular');

  assert.deepEqual(result.sortToOriginal, [2, 1, 0]);
  assert.equal(result.unclustered?.originalIndex, 0);
});

test('sortClusters no longer downranks the unclustered bucket for carousel ordering', () => {
  const clusters = [
    { cluster: 'unknown', label: 'Unclustered', cumulativeLikes: 999 },
    { cluster: 'a', label: 'Alpha', cumulativeLikes: 10 },
    { cluster: 'b', label: 'Beta', cumulativeLikes: 20 },
  ];

  const result = sortClusters(clusters, 'popular');

  assert.deepEqual(result.sortToOriginal, [0, 2, 1]);
  assert.equal(result.sortedClusters[0]?.cluster, 'unknown');
});
