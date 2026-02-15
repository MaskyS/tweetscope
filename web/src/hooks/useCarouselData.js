import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useScope } from '@/contexts/ScopeContext';
import { queryClient } from '@/lib/apiService';

const ROWS_PER_PAGE = 30;
const PREFETCH_RANGE = 2; // Fetch columns within focusedIndex +/- this range

const EMPTY_CLUSTERS = [];
const EMPTY_MAPPING = { clusterToTopLevel: {}, indicesByTopLevel: {} };
const EMPTY_ROWS_MAP = {};

export default function useCarouselData(focusedClusterIndex, enabled = true) {
  const { clusterHierarchy, scopeRows, dataset, scope, clusterMap } = useScope();

  // Per-column state: { [clusterIndex]: { rows: [], page: 0, loading: false, hasMore: true } }
  const [columnData, setColumnData] = useState({});
  const [activeSubClusters, setActiveSubClusters] = useState({}); // { [columnIndex]: subClusterId | null }
  const fetchedRef = useRef(new Set()); // Track which columns we've initiated fetches for

  // Ref for columnData so loadMore doesn't depend on it
  const columnDataRef = useRef(columnData);
  columnDataRef.current = columnData;

  // Extract top-level clusters (roots of the hierarchy)
  const topLevelClusters = useMemo(() => {
    if (!clusterHierarchy?.children) return EMPTY_CLUSTERS;
    return clusterHierarchy.children;
  }, [clusterHierarchy]);

  // Build a mapping: for each scopeRow cluster id → which top-level cluster it belongs to
  const { clusterToTopLevel, indicesByTopLevel } = useMemo(() => {
    if (!enabled || !topLevelClusters.length || !scopeRows?.length) {
      return EMPTY_MAPPING;
    }

    const c2tl = {}; // cluster id → top-level cluster id

    // Recursively walk the tree to map every cluster to its root
    const walkTree = (node, rootClusterId) => {
      c2tl[node.cluster] = rootClusterId;
      if (node.children) {
        node.children.forEach((child) => walkTree(child, rootClusterId));
      }
    };

    topLevelClusters.forEach((root) => walkTree(root, root.cluster));

    // Group scopeRow indices by top-level cluster, sorted by likes desc
    const groups = {};
    topLevelClusters.forEach((root) => {
      groups[root.cluster] = [];
    });

    scopeRows.forEach((row) => {
      if (row.deleted) return;
      const topLevel = c2tl[row.cluster];
      if (topLevel && groups[topLevel]) {
        groups[topLevel].push(row);
      }
    });

    // Sort each group by likes descending
    const indicesByTL = {};
    for (const [clusterId, rows] of Object.entries(groups)) {
      rows.sort((a, b) => {
        const aLikes = Number(a.favorites ?? a.favorite_count ?? a.like_count ?? a.likes ?? 0);
        const bLikes = Number(b.favorites ?? b.favorite_count ?? b.like_count ?? b.likes ?? 0);
        return bLikes - aLikes;
      });
      indicesByTL[clusterId] = rows.map((r) => r.ls_index);
    }

    return { clusterToTopLevel: c2tl, indicesByTopLevel: indicesByTL };
  }, [enabled, topLevelClusters, scopeRows]);

  // Fetch column data for a given column index
  const fetchColumnData = useCallback(
    (columnIndex, page = 0) => {
      const cluster = topLevelClusters[columnIndex];
      if (!cluster || !dataset) return;

      const allIndices = indicesByTopLevel[cluster.cluster] || [];
      const start = page * ROWS_PER_PAGE;
      const pageIndices = allIndices.slice(start, start + ROWS_PER_PAGE);

      if (pageIndices.length === 0) {
        setColumnData((prev) => ({
          ...prev,
          [columnIndex]: {
            ...(prev[columnIndex] || { rows: [] }),
            loading: false,
            hasMore: false,
          },
        }));
        return;
      }

      setColumnData((prev) => ({
        ...prev,
        [columnIndex]: {
          ...(prev[columnIndex] || { rows: [] }),
          loading: true,
          page,
        },
      }));

      queryClient
        .fetchDataFromIndices(dataset.id, pageIndices, scope?.id)
        .then((rows) => {
          // Map rows to include ls_index and idx (same as FilterContext does)
          const mappedRows = rows.map((row, i) => ({
            ...row,
            ls_index: row.index,
            idx: page * ROWS_PER_PAGE + i,
          }));
          setColumnData((prev) => {
            const existing = prev[columnIndex]?.rows || [];
            const newRows = page === 0 ? mappedRows : [...existing, ...mappedRows];
            return {
              ...prev,
              [columnIndex]: {
                rows: newRows,
                page,
                loading: false,
                hasMore: pageIndices.length === ROWS_PER_PAGE,
              },
            };
          });
        })
        .catch((err) => {
          console.error(`Failed to fetch column ${columnIndex} data:`, err);
          setColumnData((prev) => ({
            ...prev,
            [columnIndex]: {
              ...(prev[columnIndex] || { rows: [] }),
              loading: false,
            },
          }));
        });
    },
    [topLevelClusters, indicesByTopLevel, dataset, scope]
  );

  // Load more for a specific column — uses ref to avoid dep on columnData
  const loadMore = useCallback(
    (columnIndex) => {
      const col = columnDataRef.current[columnIndex];
      if (!col || col.loading || !col.hasMore) return;
      fetchColumnData(columnIndex, (col.page || 0) + 1);
    },
    [fetchColumnData]
  );

  // Lazy-load columns near the focused index (gated by enabled)
  useEffect(() => {
    if (!enabled || !topLevelClusters.length || !dataset) return;

    const start = Math.max(0, focusedClusterIndex - PREFETCH_RANGE);
    const end = Math.min(topLevelClusters.length - 1, focusedClusterIndex + PREFETCH_RANGE);

    for (let i = start; i <= end; i++) {
      if (!fetchedRef.current.has(i)) {
        fetchedRef.current.add(i);
        fetchColumnData(i, 0);
      }
    }
  }, [enabled, focusedClusterIndex, topLevelClusters, dataset, fetchColumnData]);

  // Reset when hierarchy changes
  useEffect(() => {
    setColumnData({});
    setActiveSubClusters({});
    fetchedRef.current = new Set();
  }, [clusterHierarchy]);

  // Sub-cluster filtering (client-side)
  const setSubClusterFilter = useCallback((columnIndex, subClusterId) => {
    setActiveSubClusters((prev) => ({
      ...prev,
      [columnIndex]: subClusterId, // null means "all"
    }));
  }, []);

  // Pre-computed per-column rows map — referentially stable per column
  const columnRowsMap = useMemo(() => {
    if (!enabled) return EMPTY_ROWS_MAP;
    const map = {};
    for (const [indexStr, col] of Object.entries(columnData)) {
      const index = Number(indexStr);
      if (!col?.rows) { map[index] = []; continue; }
      const activeSubCluster = activeSubClusters[index];
      if (!activeSubCluster) { map[index] = col.rows; continue; }
      map[index] = col.rows.filter((row) => {
        const info = clusterMap[row.ls_index];
        return info?.cluster === activeSubCluster;
      });
    }
    return map;
  }, [enabled, columnData, activeSubClusters, clusterMap]);

  return {
    topLevelClusters,
    columnData,
    columnRowsMap,
    loadMore,
    activeSubClusters,
    setSubClusterFilter,
    clusterToTopLevel,
    indicesByTopLevel,
  };
}
