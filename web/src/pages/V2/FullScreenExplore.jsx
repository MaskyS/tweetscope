import { useEffect, useState, useMemo, useCallback, useRef, startTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronsRight, GalleryHorizontalEnd, PanelRightClose, PanelRightOpen } from 'lucide-react';

import './Explore.css';
import { apiService, queryApi } from '../../lib/apiService';
import { appQueryClient } from '../../query/client';
import { queryKeys } from '../../query/keys';

import SubNav from '../../components/SubNav';
import VisualizationPane from '../../components/Explore/V2/VisualizationPane';
import TweetFeed from '../../components/Explore/V2/TweetFeed';
import FilterActions from '../../components/Explore/V2/FilterActions';
import FeedCarousel from '../../components/Explore/V2/Carousel/FeedCarousel';
import { HoverProvider } from '../../contexts/HoverContext';
import { ClusterColorProvider } from '../../contexts/ClusterColorContext';
import ThreadView from '../../components/Explore/V2/ThreadView/ThreadView';
import QuoteView from '../../components/Explore/V2/ThreadView/QuoteView';

import { ScopeProvider, useScope } from '../../contexts/ScopeContext';
import { FilterProvider, useFilter } from '../../contexts/FilterContext';
import useDebounce from '../../hooks/useDebounce';
import useSidebarState, { SIDEBAR_MODES } from '../../hooks/useSidebarState';
import useCarouselData from '../../hooks/useCarouselData';
import useTimelineData from '../../hooks/useTimelineData';
import useNodeStats from '../../hooks/useNodeStats';
import { useClusterColors } from '../../hooks/useClusterColors';

import { filterConstants } from '../../components/Explore/V2/Search/utils';

const EDGE_FETCH_MAX = 2500;
const SIDEBAR_CARD_FOCUS_ZOOM = 13;

const HOVER_METADATA_COLUMNS = [
  'id',
  'username',
  'display_name',
  'favorites',
  'favorite_count',
  'likes',
  'like_count',
  'retweets',
  'retweet_count',
  'created_at',
  'date',
  'timestamp',
  'time',
  'posted_at',
  'published_at',
  'tweet_type',
  'is_like',
  'urls_json',
  'media_urls_json',
];

function clampRangeToDomain(range, domain) {
  if (!range || !domain || domain.length !== 2) return null;
  const [rawStart, rawEnd] = range;
  const [domainStart, domainEnd] = domain;
  if (
    !Number.isFinite(rawStart) ||
    !Number.isFinite(rawEnd) ||
    !Number.isFinite(domainStart) ||
    !Number.isFinite(domainEnd)
  ) {
    return null;
  }

  const minDomain = Math.min(domainStart, domainEnd);
  const maxDomain = Math.max(domainStart, domainEnd);
  const start = Math.max(minDomain, Math.min(maxDomain, rawStart));
  const end = Math.max(minDomain, Math.min(maxDomain, rawEnd));
  return start <= end ? [start, end] : [end, start];
}

function formatTimelineRangeLabel(range) {
  if (!range) return '';
  return `${new Date(range[0]).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} — ${new Date(range[1]).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
}

function getClusterSelectionKey(cluster) {
  const clusterId = cluster?.cluster;
  return clusterId === undefined || clusterId === null ? null : String(clusterId);
}

function findClusterIndexByKey(clusters, clusterKey) {
  if (!clusterKey) return -1;
  return clusters.findIndex((cluster) => getClusterSelectionKey(cluster) === clusterKey);
}

// Create a new component that wraps the main content
function ExploreContent() {
  // Get scope-related state from ScopeContext
  const {
    userId,
    datasetId,
    dataset,
    scope,
    scopeLoaded,
    scopeRows,
    deletedIndices,
    clusterMap,
    clusterLabels,
    clusterHierarchy,
    features,
    scopes,
    tags,
    scopeError,
    scopeRowsError,
  } = useScope();

  const navigate = useNavigate();

  // Map ls_index → scopeRow for O(1) lookup (H6 fix: don't assume ls_index === array position)
  const scopeRowByLsIndex = useMemo(() => {
    const map = new Map();
    for (const row of scopeRows) {
      map.set(row.ls_index, row);
    }
    return map;
  }, [scopeRows]);

  // Get filter-related state from FilterContext
  const {
    loading: filterLoading,
    shownIndices,
    filterSlots,
    filterActive,
    applyCluster,
    applyTimeRange,
    clearFilter,
    setThreadMembership,
    threadsOnlyAvailable,
    threadsOnlyActive,
    toggleThreadsOnly,
    threadMembership,
  } = useFilter();

  // ====================================================================================================
  // Sidebar state (collapsed / normal / expanded)
  // ====================================================================================================
  const {
    sidebarMode,
    setSidebarMode,
    toggleExpand,
    toggleCollapse,
    focusedClusterIndex,
    setFocusedClusterIndex,
    savedGraphViewState,
    threadTargetIndex,
    threadTargetTweetId,
    openThread,
    openQuotes,
    closeThread,
  } = useSidebarState();

  // Expanded sidebar data hook
  const expandedSidebarOpen = sidebarMode === SIDEBAR_MODES.EXPANDED;
  // Pass thread membership to carousel hook only when active
  const activeThreadMembership = threadsOnlyActive ? threadMembership : null;
  const carouselData = useCarouselData(focusedClusterIndex, expandedSidebarOpen, activeThreadMembership);

  const prevCarouselClustersRef = useRef(carouselData.topLevelClusters);
  const lastExpandedTopLevelClustersRef = useRef(carouselData.topLevelClusters);

  useEffect(() => {
    if (!expandedSidebarOpen) return;
    const previousClusters = prevCarouselClustersRef.current;
    const nextClusters = carouselData.topLevelClusters;

    if (nextClusters.length > 0) {
      const focusedClusterKey = getClusterSelectionKey(previousClusters[focusedClusterIndex]);
      const nextIndex = findClusterIndexByKey(nextClusters, focusedClusterKey);

      if (nextIndex >= 0) {
        if (nextIndex !== focusedClusterIndex) {
          setFocusedClusterIndex(nextIndex);
        }
      } else if (focusedClusterIndex >= nextClusters.length) {
        setFocusedClusterIndex(nextClusters.length - 1);
      }
    }

    prevCarouselClustersRef.current = nextClusters;
  }, [expandedSidebarOpen, focusedClusterIndex, carouselData.topLevelClusters, setFocusedClusterIndex]);

  useEffect(() => {
    if (!expandedSidebarOpen) return;
    if (carouselData.topLevelClusters.length > 0) {
      lastExpandedTopLevelClustersRef.current = carouselData.topLevelClusters;
    }
  }, [carouselData.topLevelClusters, expandedSidebarOpen]);

  // Keep visualization-specific state
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [hoveredCluster, setHoveredCluster] = useState(null);
  const [hoverAnchor, setHoverAnchor] = useState(null);
  const [pinnedIndex, setPinnedIndex] = useState(null);
  const [hoverAnnotations, setHoverAnnotations] = useState([]);
  const [linksMeta, setLinksMeta] = useState(null);
  const [linksAvailable, setLinksAvailable] = useState(false);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksEdges, setLinksEdges] = useState([]);
  const [threadHighlightIndices, setThreadHighlightIndices] = useState(null);
  const [threadLinksEdges, setThreadLinksEdges] = useState([]);
  const [threadLinksLoading, setThreadLinksLoading] = useState(false);

  // Node link stats (thread/quote metadata per tweet)
  const { statsMap: nodeStats, tweetIdMap } = useNodeStats(dataset?.id, linksAvailable);
  const { colorMap } = useClusterColors(clusterLabels, clusterHierarchy);

  // Push nodeStats into FilterContext to build chain-safe thread membership mask
  useEffect(() => {
    setThreadMembership(nodeStats);
  }, [nodeStats, setThreadMembership]);

  // ====================================================================================================
  // Timeline state
  // ====================================================================================================
  const timelineData = useTimelineData(scopeRows);
  const [timeRange, setTimeRange] = useState(null); // [startMs, endMs] | null
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [timelineStart, timelineEnd] = timelineData.domain;
  const animFrameRef = useRef(null);
  const lastFrameTimeRef = useRef(0);

  // Track whether playback should stop (set inside rAF, read after)
  const shouldStopRef = useRef(false);

  // Playback animation loop
  useEffect(() => {
    if (!isPlaying || !timelineData.hasDates) return;

    const totalDuration = timelineEnd - timelineStart;
    if (totalDuration <= 0) {
      const staticRange = [timelineStart, timelineStart];
      setTimeRange(staticRange);
      applyTimeRange(
        staticRange[0],
        staticRange[1],
        timelineData.timestampsByLsIndex,
        formatTimelineRangeLabel(staticRange),
      );
      setIsPlaying(false);
      return;
    }

    // At 1x: 15 seconds to sweep the entire range
    const msPerSecond = (totalDuration / 15) * playbackSpeed;
    shouldStopRef.current = false;

    const animate = (timestamp) => {
      const dt = timestamp - lastFrameTimeRef.current;
      lastFrameTimeRef.current = timestamp;

      setTimeRange((prev) => {
        const currentRange = clampRangeToDomain(prev, [timelineStart, timelineEnd]) || [timelineStart, timelineStart];
        const newEnd = Math.min(currentRange[1] + msPerSecond * (dt / 1000), timelineEnd);
        if (newEnd >= timelineEnd) {
          shouldStopRef.current = true;
          return [currentRange[0], timelineEnd];
        }
        return [currentRange[0], newEnd];
      });

      if (shouldStopRef.current) {
        setIsPlaying(false);
      } else {
        animFrameRef.current = requestAnimationFrame(animate);
      }
    };

    lastFrameTimeRef.current = performance.now();
    animFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [
    isPlaying,
    playbackSpeed,
    timelineData.hasDates,
    timelineData.timestampsByLsIndex,
    timelineStart,
    timelineEnd,
    applyTimeRange,
  ]);

  const handlePlayToggle = useCallback(() => {
    if (!isPlaying && timelineData.hasDates) {
      const nextRange = clampRangeToDomain(timeRange, [timelineStart, timelineEnd]) || [timelineStart, timelineStart];
      const playbackRange = [nextRange[0], nextRange[0]];
      // Always reset end to start so playback sweeps from the chosen start
      setTimeRange(playbackRange);
      applyTimeRange(
        playbackRange[0],
        playbackRange[1],
        timelineData.timestampsByLsIndex,
        formatTimelineRangeLabel(playbackRange),
      );
    }
    setIsPlaying((p) => !p);
  }, [
    isPlaying,
    timelineData.hasDates,
    timelineData.timestampsByLsIndex,
    timelineStart,
    timelineEnd,
    timeRange,
    applyTimeRange,
  ]);

  // Bridge time range changes to FilterContext
  const handleTimeRangeChange = useCallback(
    (range) => {
      const nextRange = clampRangeToDomain(range, [timelineStart, timelineEnd]);
      setTimeRange(nextRange);
      if (nextRange) {
        applyTimeRange(
          nextRange[0],
          nextRange[1],
          timelineData.timestampsByLsIndex,
          formatTimelineRangeLabel(nextRange),
        );
      } else if (filterSlots.timeRange) {
        clearFilter(filterConstants.TIME_RANGE);
      }
    },
    [
      timelineStart,
      timelineEnd,
      timelineData.timestampsByLsIndex,
      applyTimeRange,
      clearFilter,
      filterSlots.timeRange,
    ]
  );

  // Debounce filter updates during playback to avoid thrashing the data table
  const playbackFilterTimerRef = useRef(null);
  useEffect(() => {
    if (!isPlaying || !timeRange) return;
    if (playbackFilterTimerRef.current) clearTimeout(playbackFilterTimerRef.current);
    const normalizedRange = clampRangeToDomain(timeRange, [timelineStart, timelineEnd]);
    if (!normalizedRange) return;

    playbackFilterTimerRef.current = setTimeout(() => {
      applyTimeRange(
        normalizedRange[0],
        normalizedRange[1],
        timelineData.timestampsByLsIndex,
        formatTimelineRangeLabel(normalizedRange),
      );
    }, 300);
    return () => clearTimeout(playbackFilterTimerRef.current);
  }, [
    isPlaying,
    timeRange,
    timelineStart,
    timelineEnd,
    timelineData.timestampsByLsIndex,
    applyTimeRange,
  ]);

  // Keep timeline filter state valid when scope/domain changes.
  useEffect(() => {
    if (!filterSlots.timeRange) return;

    if (!timelineData.hasDates) {
      setIsPlaying(false);
      setTimeRange(null);
      clearFilter(filterConstants.TIME_RANGE);
      return;
    }

    const trSlot = filterSlots.timeRange;
    const clampedFilterRange = clampRangeToDomain([trSlot.start, trSlot.end], [timelineStart, timelineEnd]);
    if (!clampedFilterRange) {
      setIsPlaying(false);
      setTimeRange(null);
      clearFilter(filterConstants.TIME_RANGE);
      return;
    }

    const nextLabel = formatTimelineRangeLabel(clampedFilterRange);
    const shouldUpdateFilter =
      trSlot.start !== clampedFilterRange[0] ||
      trSlot.end !== clampedFilterRange[1] ||
      trSlot.timestampsByLsIndex !== timelineData.timestampsByLsIndex ||
      trSlot.label !== nextLabel;

    if (shouldUpdateFilter) {
      applyTimeRange(
        clampedFilterRange[0],
        clampedFilterRange[1],
        timelineData.timestampsByLsIndex,
        nextLabel,
      );
    }

    if (!isPlaying && (!timeRange || timeRange[0] !== clampedFilterRange[0] || timeRange[1] !== clampedFilterRange[1])) {
      setTimeRange(clampedFilterRange);
    }
  }, [
    filterSlots.timeRange,
    timelineData.hasDates,
    timelineData.timestampsByLsIndex,
    timelineStart,
    timelineEnd,
    isPlaying,
    timeRange,
    applyTimeRange,
    clearFilter,
  ]);

  // If the time range slot is cleared externally, sync local timeline state.
  useEffect(() => {
    if (filterSlots.timeRange) return;
    if (isPlaying) setIsPlaying(false);
    if (timeRange !== null) setTimeRange(null);
  }, [filterSlots.timeRange, isPlaying, timeRange]);

  // Add a ref to track the latest requested index
  const latestHoverIndexRef = useRef(null);
  const latestHoverAnchorIndexRef = useRef(null);
  const hoverRecordCacheRef = useRef(new Map());
  const latestLinksRequestRef = useRef(0);
  const hoverDismissTimerRef = useRef(null);
  const hoverIntentTimerRef = useRef(null);
  const hoverCardHoveredRef = useRef(false);
  const hoverFocusViewportRef = useRef({
    width: window.innerWidth,
    height: window.innerHeight,
    paddingRight: 0,
  });

  const hoverColumns = useMemo(() => {
    return Array.from(new Set([scope?.dataset?.text_column, ...HOVER_METADATA_COLUMNS].filter(Boolean)));
  }, [scope?.dataset?.text_column]);

  // Hydrate hover records with a small cache to avoid repeated round-trips while scanning.
  const hydrateHoverRecord = useCallback(
    (index, setter) => {
      if (!scope?.id || !scope?.dataset?.id) return;
      latestHoverIndexRef.current = index;
      const cached = hoverRecordCacheRef.current.get(index);
      if (cached) {
        setter(cached);
        return;
      }

      appQueryClient
        .fetchQuery({
          queryKey: queryKeys.hoverRecord(scope.dataset.id, scope.id, index, hoverColumns),
          queryFn: ({ signal }) =>
            apiService.getHoverRecord(scope, index, hoverColumns, { signal }),
          staleTime: 60_000,
        })
        .then((data) => {
          if (latestHoverIndexRef.current === index) {
            if (data) {
              hoverRecordCacheRef.current.set(index, data);
              if (hoverRecordCacheRef.current.size > 400) {
                const firstKey = hoverRecordCacheRef.current.keys().next().value;
                hoverRecordCacheRef.current.delete(firstKey);
              }
            }
            setter(data);
          }
        })
        .catch((error) => {
          console.warn('Failed to hydrate hover record', error);
          setter(null);
        });
    },
    [scope, hoverColumns]
  );

  const debouncedHydrateHoverRecord = useDebounce(hydrateHoverRecord, 120);

  useEffect(() => {
    hoverRecordCacheRef.current.clear();
    latestHoverIndexRef.current = null;
    latestHoverAnchorIndexRef.current = null;
  }, [scope?.id]);

  // Cleanup dismiss timer on unmount
  useEffect(() => {
    return () => {
      if (hoverDismissTimerRef.current) {
        clearTimeout(hoverDismissTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setLinksMeta(null);
    setLinksAvailable(false);
    setLinksEdges([]);
    latestLinksRequestRef.current = 0;

    if (!dataset?.id) return;

    let cancelled = false;
    appQueryClient
      .fetchQuery({
        queryKey: queryKeys.linksMeta(dataset.id),
        queryFn: ({ signal }) => apiService.fetchLinksMeta(dataset.id, { signal }),
        staleTime: 5 * 60 * 1000,
      })
      .then((meta) => {
        if (cancelled) return;
        setLinksMeta(meta || null);
        setLinksAvailable(true);
      })
      .catch((error) => {
        if (cancelled) return;
        // A missing links graph is expected for datasets that haven't built artifacts yet.
        if (error?.status !== 404) {
          console.warn('Failed to load links metadata', error);
        }
        setLinksMeta(null);
        setLinksAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dataset?.id]);

  useEffect(() => {
    if (sidebarMode === SIDEBAR_MODES.EXPANDED) {
      return;
    }

    if (
      hoveredIndex !== null &&
      hoveredIndex !== undefined &&
      !deletedIndices.has(hoveredIndex)
    ) {
      debouncedHydrateHoverRecord(hoveredIndex, (row) => {
        const textColumn = scope?.dataset?.text_column;
        const text = textColumn ? row?.[textColumn] : '';
        setHovered({
          ...(row || {}),
          text: text,
          index: hoveredIndex,
          cluster: clusterMap[hoveredIndex],
        });
      });
    } else {
      debouncedHydrateHoverRecord.cancel?.();
      setHovered(null);
      latestHoverIndexRef.current = null;
      latestHoverAnchorIndexRef.current = null;
    }
  }, [sidebarMode, hoveredIndex, deletedIndices, clusterMap, debouncedHydrateHoverRecord, scope]);

  // Update hover annotations
  useEffect(() => {
    if (sidebarMode === SIDEBAR_MODES.EXPANDED) {
      setHoverAnnotations([]);
      return;
    }

    if (hoveredIndex !== null && hoveredIndex !== undefined) {
      const sr = scopeRowByLsIndex.get(hoveredIndex);
      if (sr) {
        setHoverAnnotations([[sr.x, sr.y]]);
      } else {
        setHoverAnnotations([]);
      }
    } else {
      setHoverAnnotations([]);
    }
  }, [sidebarMode, hoveredIndex, scopeRowByLsIndex]);

  const edgeQueryIndices = useMemo(() => {
    if (threadTargetIndex !== null && threadTargetIndex !== undefined && !deletedIndices.has(threadTargetIndex)) {
      return [threadTargetIndex];
    }
    if (pinnedIndex !== null && pinnedIndex !== undefined && !deletedIndices.has(pinnedIndex)) {
      return [pinnedIndex];
    }
    if (hoveredIndex !== null && hoveredIndex !== undefined && !deletedIndices.has(hoveredIndex)) {
      return [hoveredIndex];
    }
    return [];
  }, [threadTargetIndex, pinnedIndex, hoveredIndex, deletedIndices]);

  const graphHighlightIndices = useMemo(() => {
    const indices = new Set();

    if (pinnedIndex !== null && pinnedIndex !== undefined && !deletedIndices.has(pinnedIndex)) {
      indices.add(pinnedIndex);
    }

    if (sidebarMode === SIDEBAR_MODES.THREAD && threadHighlightIndices instanceof Set) {
      for (const idx of threadHighlightIndices) {
        const normalized = Number(idx);
        if (Number.isInteger(normalized) && !deletedIndices.has(normalized)) {
          indices.add(normalized);
        }
      }
    }

    return indices.size > 0 ? indices : null;
  }, [pinnedIndex, deletedIndices, sidebarMode, threadHighlightIndices]);

  const fetchLinksEdges = useCallback(
    (indices) => {
      if (!dataset?.id || !linksAvailable || !Array.isArray(indices)) {
        return;
      }

      const requestId = latestLinksRequestRef.current + 1;
      latestLinksRequestRef.current = requestId;
      setLinksLoading(true);

      appQueryClient
        .fetchQuery({
          queryKey: queryKeys.linksByIndices(dataset.id, indices),
          queryFn: ({ signal }) =>
            apiService.fetchLinksByIndices(
              dataset.id,
              {
                indices: indices.length > 0 ? indices : null,
                edge_kinds: ['reply', 'quote'],
                include_external: false,
                max_edges: EDGE_FETCH_MAX,
              },
              { signal }
            ),
          staleTime: 30_000,
        })
        .then((payload) => {
          if (latestLinksRequestRef.current !== requestId) return;
          const edges = Array.isArray(payload?.edges) ? payload.edges : [];
          setLinksEdges(edges);
        })
        .catch((error) => {
          if (latestLinksRequestRef.current !== requestId) return;
          console.warn('Failed to load links edges', error);
          setLinksEdges([]);
        })
        .finally(() => {
          if (latestLinksRequestRef.current === requestId) {
            setLinksLoading(false);
          }
        });
    },
    [dataset?.id, linksAvailable]
  );

  const debouncedFetchLinksEdges = useDebounce(fetchLinksEdges, 120);

  useEffect(() => {
    if (
      sidebarMode === SIDEBAR_MODES.EXPANDED ||
      !linksAvailable
    ) {
      debouncedFetchLinksEdges.cancel?.();
      setLinksEdges([]);
      setLinksLoading(false);
      return;
    }

    debouncedFetchLinksEdges(edgeQueryIndices);
    return () => {
      debouncedFetchLinksEdges.cancel?.();
    };
  }, [sidebarMode, linksAvailable, edgeQueryIndices, debouncedFetchLinksEdges]);

  // Handlers for responding to individual data points
  const handleClicked = useCallback((lsIndex) => {
    const idx = Number(lsIndex);
    if (!Number.isInteger(idx) || deletedIndices.has(idx)) return;

    const row = scopeRowByLsIndex.get(idx) || scopeRowByLsIndex.get(String(idx));
    if (!row) return;

    const clusterInfo = clusterMap[idx] || clusterMap[String(idx)] || null;
    const textColumn = dataset?.text_column;

    // Keep hover/pin state in sync so the graph card and edge overlays track the selected tweet.
    const metrics = hoverFocusViewportRef.current || {};
    const viewportWidth =
      Number.isFinite(metrics.width) && metrics.width > 0 ? metrics.width : window.innerWidth;
    const viewportHeight =
      Number.isFinite(metrics.height) && metrics.height > 0 ? metrics.height : window.innerHeight;
    const paddingRight =
      Number.isFinite(metrics.paddingRight) && metrics.paddingRight > 0 ? metrics.paddingRight : 0;
    const visibleWidth = Math.max(320, viewportWidth - paddingRight);

    setPinnedIndex(idx);
    setHoveredIndex(idx);
    setHoveredCluster(clusterInfo);
    setHoverAnchor({
      x: visibleWidth / 2,
      y: viewportHeight / 2,
    });
    latestHoverAnchorIndexRef.current = idx;
    setHovered({
      ...(row || {}),
      text: textColumn ? row?.[textColumn] : '',
      index: idx,
      cluster: clusterInfo,
    });
    latestHoverIndexRef.current = idx;

    const x = Number(row.x);
    const y = Number(row.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const currentZoom = Number(vizRef.current?.getViewState?.()?.zoom);
    const zoom = Number.isFinite(currentZoom)
      ? Math.max(currentZoom, SIDEBAR_CARD_FOCUS_ZOOM)
      : SIDEBAR_CARD_FOCUS_ZOOM;

    vizRef.current?.zoomToPoint?.(x, y, zoom, 420);
  }, [deletedIndices, scopeRowByLsIndex, clusterMap, dataset]);

  // Thread view handlers
  const handleViewThread = useCallback((lsIndex) => {
    const tid = tweetIdMap?.get(lsIndex);
    if (!tid) return;
    const graphViewState = vizRef.current?.getViewState?.();
    openThread(lsIndex, tid, graphViewState);
  }, [tweetIdMap, openThread]);

  const handleViewQuotes = useCallback((lsIndex) => {
    const tid = tweetIdMap?.get(lsIndex);
    if (!tid) return;
    const graphViewState = vizRef.current?.getViewState?.();
    openQuotes(lsIndex, tid, graphViewState);
  }, [tweetIdMap, openQuotes]);

  const handleCloseThread = useCallback(() => {
    const restoreViewState = savedGraphViewState;
    closeThread();
    if (restoreViewState) {
      window.requestAnimationFrame(() => {
        vizRef.current?.setViewState?.(restoreViewState, 260);
      });
    }
  }, [closeThread, savedGraphViewState]);

  const handleThreadDataChange = useCallback(({ internalIndices, edges, loading, error }) => {
    setThreadLinksLoading(!!loading);

    if (loading) {
      setThreadHighlightIndices(null);
      setThreadLinksEdges([]);
      return;
    }

    if (error) {
      setThreadHighlightIndices(null);
      setThreadLinksEdges([]);
      return;
    }

    if (!internalIndices || internalIndices.size === 0) {
      setThreadHighlightIndices(null);
      setThreadLinksEdges([]);
      return;
    }

    const normalizedIndices = new Set(
      Array.from(internalIndices)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value))
    );

    const memberEdges = Array.isArray(edges)
      ? edges.filter((edge) => {
        if (String(edge?.edge_kind || '').toLowerCase() !== 'reply') return false;
        const src = Number(edge?.src_ls_index);
        const dst = Number(edge?.dst_ls_index);
        return normalizedIndices.has(src) && normalizedIndices.has(dst);
      })
      : [];

    setThreadHighlightIndices(normalizedIndices);
    setThreadLinksEdges(memberEdges);
  }, []);

  const clearHoverState = useCallback(() => {
    if (hoverIntentTimerRef.current) {
      clearTimeout(hoverIntentTimerRef.current);
      hoverIntentTimerRef.current = null;
    }
    setHoverAnchor(null);
    setHoveredIndex(null);
    setHoveredCluster(null);
    setHovered(null);
    latestHoverIndexRef.current = null;
    latestHoverAnchorIndexRef.current = null;
  }, []);

  const dismissThreadContext = useCallback(() => {
    // Map interactions (empty-click or cluster navigation) should leave tweet-specific views.
    if (sidebarMode === SIDEBAR_MODES.THREAD || sidebarMode === SIDEBAR_MODES.QUOTES) {
      closeThread();
    }
  }, [sidebarMode, closeThread]);

  const handleHover = useCallback(
    (payload) => {
      if (pinnedIndex !== null) {
        return;
      }
      const rawIndex = payload && typeof payload === 'object' ? payload.index : payload;
      const index = Number.isInteger(rawIndex) ? rawIndex : null;
      const nonDeletedIndex = deletedIndices.has(index) ? null : index;
      const hasPointCoords =
        payload &&
        typeof payload === 'object' &&
        Number.isFinite(payload.x) &&
        Number.isFinite(payload.y);

      // When hovering a new point, use hover-intent delay so fast mouse
      // movement across the canvas doesn't flash hovercards for every point
      // the cursor crosses.  The point highlight in DeckGLScatter is still
      // instant — only the popover waits for the user to dwell (~100ms).
      if (nonDeletedIndex !== null) {
        if (hoverDismissTimerRef.current) {
          clearTimeout(hoverDismissTimerRef.current);
          hoverDismissTimerRef.current = null;
        }

        // Cancel any pending intent for a different point.
        if (hoverIntentTimerRef.current) {
          clearTimeout(hoverIntentTimerRef.current);
          hoverIntentTimerRef.current = null;
        }

        // If the user is already hovering this exact point, skip the delay.
        if (latestHoverAnchorIndexRef.current === nonDeletedIndex) return;

        hoverIntentTimerRef.current = setTimeout(() => {
          hoverIntentTimerRef.current = null;
          if (hasPointCoords) {
            setHoverAnchor({ x: payload.x, y: payload.y });
            latestHoverAnchorIndexRef.current = nonDeletedIndex;
          }
          setHoveredIndex((prev) => (prev === nonDeletedIndex ? prev : nonDeletedIndex));
          const nextCluster = nonDeletedIndex >= 0 ? clusterMap[nonDeletedIndex] : null;
          setHoveredCluster((prev) => {
            if ((prev?.cluster ?? null) === (nextCluster?.cluster ?? null)) {
              return prev;
            }
            return nextCluster;
          });
        }, 100);
      } else {
        // Mouse left a point — cancel any pending intent
        if (hoverIntentTimerRef.current) {
          clearTimeout(hoverIntentTimerRef.current);
          hoverIntentTimerRef.current = null;
        }
        // Delay dismissal so user can reach the hover card
        if (hoverDismissTimerRef.current) {
          clearTimeout(hoverDismissTimerRef.current);
        }
        hoverDismissTimerRef.current = setTimeout(() => {
          hoverDismissTimerRef.current = null;
          if (!hoverCardHoveredRef.current) {
            clearHoverState();
          }
        }, 300);
      }
    },
    [deletedIndices, clusterMap, pinnedIndex, clearHoverState]
  );

  const handleHoverCardMouseEnter = useCallback(() => {
    hoverCardHoveredRef.current = true;
    if (hoverDismissTimerRef.current) {
      clearTimeout(hoverDismissTimerRef.current);
      hoverDismissTimerRef.current = null;
    }
  }, []);

  const handleHoverCardMouseLeave = useCallback(() => {
    hoverCardHoveredRef.current = false;
    if (pinnedIndex !== null) return;
    // Start dismiss timer when leaving the card
    if (hoverDismissTimerRef.current) {
      clearTimeout(hoverDismissTimerRef.current);
    }
    hoverDismissTimerRef.current = setTimeout(() => {
      hoverDismissTimerRef.current = null;
      clearHoverState();
    }, 200);
  }, [pinnedIndex, clearHoverState]);

  const handlePointSelect = useCallback(
    (indices) => {
      const idx = indices?.[0];
      if (idx === null || idx === undefined || deletedIndices.has(idx)) {
        // Clicking empty map space should clear any pinned tweet focus.
        setPinnedIndex(null);
        dismissThreadContext();
        clearHoverState();

        if (filterSlots.cluster) {
          clearFilter(filterConstants.CLUSTER);
        }
        return;
      }
      // Map point click should pin/focus the hover card and open thread mode.
      handleClicked(idx);

      const graphViewState = vizRef.current?.getViewState?.();
      const tid = tweetIdMap?.get(idx);
      if (tid) {
        openThread(idx, tid, graphViewState);
        return;
      }

      // Fallback: fetch row data when tweetIdMap is missing this index.
      if (datasetId && scope?.id) {
        appQueryClient
          .fetchQuery({
            queryKey: queryKeys.rowsByIndices(datasetId, scope.id, [idx]),
            queryFn: ({ signal }) =>
              queryApi.fetchDataFromIndices(datasetId, [idx], scope.id, { signal }),
            staleTime: 5 * 60 * 1000,
          })
          .then((rows) => {
            const row = rows?.[0];
            const rowTid = row?.id ? String(row.id) : row?.tweet_id ? String(row.tweet_id) : null;
            if (rowTid) {
              openThread(idx, rowTid, graphViewState);
            }
          })
          .catch(() => {
            // Silently fail thread open; node remains pinned/focused.
          });
      }
    },
    [
      deletedIndices,
      dismissThreadContext,
      clearHoverState,
      filterSlots.cluster,
      clearFilter,
      handleClicked,
      tweetIdMap,
      openThread,
      datasetId,
      scope?.id,
    ]
  );

  const handleUnpinHover = useCallback(() => {
    setPinnedIndex(null);
    setHoveredIndex(null);
    setHovered(null);
    setHoveredCluster(null);
    setHoverAnchor(null);
    latestHoverIndexRef.current = null;
    latestHoverAnchorIndexRef.current = null;
  }, []);

  const focusCluster = useCallback(
    (cluster) => {
      const clusterId = cluster?.cluster;
      if (clusterId === undefined || clusterId === null) return;

      setPinnedIndex(null);
      clearHoverState();
      dismissThreadContext();
      applyCluster(cluster);

      const clusterObj = clusterLabels?.find(
        (candidate) => String(candidate.cluster) === String(clusterId)
      );
      if (!clusterObj?.hull || clusterObj.hull.length < 3 || !scopeRows?.length) return;

      const hullPoints = clusterObj.hull
        .map((idx) => scopeRows[idx])
        .filter((point) => point && !point.deleted);
      if (hullPoints.length < 3) return;

      const xs = hullPoints.map((point) => point.x);
      const ys = hullPoints.map((point) => point.y);
      const padX = (Math.max(...xs) - Math.min(...xs)) * 0.15;
      const padY = (Math.max(...ys) - Math.min(...ys)) * 0.15;

      vizRef.current?.zoomToBounds([
        Math.min(...xs) - padX,
        Math.min(...ys) - padY,
        Math.max(...xs) + padX,
        Math.max(...ys) + padY,
      ], 500);
    },
    [applyCluster, clearHoverState, dismissThreadContext, clusterLabels, scopeRows]
  );

  const handleFilterToCluster = useCallback(
    (cluster) => {
      focusCluster(cluster);
    },
    [focusCluster]
  );

  const containerRef = useRef(null);
  const vizRef = useRef(null);

  // Handle clicking a cluster label on the map: filter + zoom
  const handleLabelClick = useCallback(
    ({ cluster: clusterIndex, label }) => {
      focusCluster({ cluster: clusterIndex, label });
    },
    [focusCluster]
  );

  const handleScopeChange = useCallback(
    (e) => {
      navigate(`/datasets/${dataset?.id}/explore/${e.target.value}`);
    },
    [dataset, navigate]
  );

  // ====================================================================================================
  // Fullscreen related logic
  // ====================================================================================================
  const [size, setSize] = useState(() => [window.innerWidth, window.innerHeight]);
  const visualizationContainerRef = useRef(null);
  const resizeRafRef = useRef(null);
  const isExpandedRef = useRef(false);

  function updateSize() {
    // Skip getBoundingClientRect while map is hidden (expanded/carousel mode)
    if (isExpandedRef.current) return;
    if (visualizationContainerRef.current) {
      const vizRect = visualizationContainerRef.current.getBoundingClientRect();
      setSize((prev) => {
        if (prev[0] === vizRect.width && prev[1] === vizRect.height) {
          return prev;
        }
        return [vizRect.width, vizRect.height];
      });
    }
  }

  const scheduleUpdateSize = useCallback(() => {
    if (resizeRafRef.current !== null) return;
    resizeRafRef.current = window.requestAnimationFrame(() => {
      resizeRafRef.current = null;
      updateSize();
    });
  }, []);

  // initial size
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      scheduleUpdateSize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, [scheduleUpdateSize]);

  // let's fill the container and update the width and height if window resizes
  useEffect(() => {
    window.addEventListener('resize', scheduleUpdateSize);
    updateSize();
    return () => window.removeEventListener('resize', scheduleUpdateSize);
  }, [visualizationContainerRef, containerRef, scheduleUpdateSize]);

  const [width, height] = size;
  const isCollapsed = sidebarMode === SIDEBAR_MODES.COLLAPSED;
  const isExpanded = sidebarMode === SIDEBAR_MODES.EXPANDED;
  isExpandedRef.current = isExpanded;
  const isNormal = sidebarMode === SIDEBAR_MODES.NORMAL;
  const isThread = sidebarMode === SIDEBAR_MODES.THREAD;
  const isQuotes = sidebarMode === SIDEBAR_MODES.QUOTES;
  const isDesktopViewport = width >= 1024;
  const isDesktopOverlay = (isNormal || isThread || isQuotes) && isDesktopViewport;
  const isDesktopSidebarLayout = !isExpanded && isDesktopViewport;

  useEffect(() => {
    if (isThread) return;
    setThreadHighlightIndices(null);
    setThreadLinksEdges([]);
    setThreadLinksLoading(false);
  }, [isThread]);

  // Merge thread-internal reply edges with per-node edges (deduped)
  const mergedLinksEdges = useMemo(() => {
    if (!isThread) return linksEdges;
    if (threadLinksEdges.length === 0) return linksEdges;
    if (linksEdges.length === 0) return threadLinksEdges;
    const seen = new Set();
    const merged = [];
    for (const edge of threadLinksEdges) {
      const key = `${edge.edge_kind}:${edge.src_ls_index}:${edge.dst_ls_index}`;
      if (!seen.has(key)) { seen.add(key); merged.push(edge); }
    }
    for (const edge of linksEdges) {
      const key = `${edge.edge_kind}:${edge.src_ls_index}:${edge.dst_ls_index}`;
      if (!seen.has(key)) { seen.add(key); merged.push(edge); }
    }
    return merged;
  }, [isThread, threadLinksEdges, linksEdges]);

  // ====================================================================================================
  // Draggable State (only active in normal mode)
  // ====================================================================================================
  const [normalSidebarWidth, setNormalSidebarWidth] = useState(560);

  const clampedSidebarWidth = useMemo(() => {
    if (!isDesktopSidebarLayout) return 0;
    const minWidth = 380;
    const maxWidth = Math.max(minWidth, Math.floor(width * 0.7));
    return Math.min(Math.max(normalSidebarWidth, minWidth), maxWidth);
  }, [isDesktopSidebarLayout, normalSidebarWidth, width]);

  const mapViewportPaddingRight = isDesktopOverlay ? clampedSidebarWidth + 24 : 0;
  const visualizationViewportWidth = Math.max(320, width - mapViewportPaddingRight);
  const mapLoadingPlaceholderStyle = useMemo(
    () => ({ width: `${Math.max(1, width - mapViewportPaddingRight)}px` }),
    [width, mapViewportPaddingRight]
  );

  useEffect(() => {
    hoverFocusViewportRef.current = {
      width,
      height,
      paddingRight: mapViewportPaddingRight,
    };
  }, [width, height, mapViewportPaddingRight]);

  const startDragging = (e) => {
    if (sidebarMode === SIDEBAR_MODES.EXPANDED || sidebarMode === SIDEBAR_MODES.COLLAPSED) return;
    e.preventDefault();
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDragging);
  };

  const onDrag = (e) => {
    if (!containerRef.current || !isDesktopOverlay) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const minWidth = 380;
    const maxWidth = Math.max(minWidth, Math.floor(containerRect.width * 0.7));
    const widthFromRight = containerRect.right - e.clientX;
    const nextWidth = Math.min(Math.max(widthFromRight, minWidth), maxWidth);
    setNormalSidebarWidth(nextWidth);
  };

  const stopDragging = () => {
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDragging);
  };

  // Update viz size after mode transition — skip while expanded, resync on return
  useEffect(() => {
    if (sidebarMode === SIDEBAR_MODES.EXPANDED) return;
    const timer = setTimeout(() => {
      requestAnimationFrame(updateSize);
    }, 350); // After 300ms transition + buffer
    return () => clearTimeout(timer);
  }, [sidebarMode]);

  useEffect(() => {
    if (sidebarMode !== SIDEBAR_MODES.EXPANDED) return;
    setHoveredIndex(null);
    setHovered(null);
    setHoveredCluster(null);
    setHoverAnchor(null);
    setPinnedIndex(null);
    setHoverAnnotations([]);
    latestHoverIndexRef.current = null;
    latestHoverAnchorIndexRef.current = null;
  }, [sidebarMode]);

  // ====================================================================================================
  // Sidebar mode transitions
  // ====================================================================================================
  const handleToggleExpand = useCallback(() => {
    const graphViewState = vizRef.current?.getViewState?.();
    startTransition(() => {
      toggleExpand(graphViewState);
    });
  }, [toggleExpand]);

  const handleToggleCollapse = useCallback(() => {
    toggleCollapse();
  }, [toggleCollapse]);

  // Zoom to focused cluster when returning from expanded mode
  const prevModeRef = useRef(sidebarMode);
  useEffect(() => {
    const prevMode = prevModeRef.current;
    prevModeRef.current = sidebarMode;

    if (prevMode === SIDEBAR_MODES.EXPANDED && sidebarMode === SIDEBAR_MODES.NORMAL) {
      // Returning from expanded — zoom to focused cluster
      const cluster = lastExpandedTopLevelClustersRef.current[focusedClusterIndex];
      if (cluster?.hull && cluster.hull.length >= 3 && scopeRows?.length) {
        const hullPoints = cluster.hull
          .map((idx) => scopeRows[idx])
          .filter((p) => p && !p.deleted);

        if (hullPoints.length >= 3) {
          const xs = hullPoints.map((p) => p.x);
          const ys = hullPoints.map((p) => p.y);
          const padX = (Math.max(...xs) - Math.min(...xs)) * 0.15;
          const padY = (Math.max(...ys) - Math.min(...ys)) * 0.15;

          // Delay slightly to let the grid transition complete
          setTimeout(() => {
            vizRef.current?.zoomToBounds(
              [
                Math.min(...xs) - padX,
                Math.min(...ys) - padY,
                Math.max(...xs) + padX,
                Math.max(...ys) + padY,
              ],
              500
            );
          }, 400);
        }
      }
    }
  }, [sidebarMode, focusedClusterIndex, scopeRows]);

  const sidebarPaneStyle = useMemo(() => {
    if (isExpanded) {
      return {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        padding: 0,
        background: 'var(--neutrals-color-neutral-0, #fff)',
        zIndex: 15,
        transform: 'translateX(0)',
        opacity: 1,
        pointerEvents: 'auto',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
      };
    }

    const sidebarTransition = 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease';

    if (isDesktopSidebarLayout) {
      return {
        position: 'absolute',
        top: 16,
        right: 16,
        bottom: 16,
        width: `${clampedSidebarWidth}px`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'visible',
        borderRadius: 16,
        background: 'var(--viz-panel-background, rgba(242, 240, 229, 0.78))',
        backdropFilter: 'blur(16px) saturate(150%)',
        WebkitBackdropFilter: 'blur(16px) saturate(150%)',
        border: '1px solid var(--viz-panel-border, rgba(111, 110, 105, 0.26))',
        boxShadow: 'var(--glass-shadow-hover, 0 8px 28px rgba(40, 39, 38, 0.16))',
        transform: isCollapsed ? 'translateX(calc(100% + 28px))' : 'translateX(0)',
        opacity: isCollapsed ? 0 : 1,
        pointerEvents: isCollapsed ? 'none' : 'auto',
        willChange: 'transform, opacity',
        transition: sidebarTransition,
      };
    }

    return {
      position: 'absolute',
      left: 8,
      right: 8,
      bottom: 8,
      top: '45%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'visible',
      borderRadius: 14,
      background: 'var(--viz-panel-background, rgba(242, 240, 229, 0.78))',
      backdropFilter: 'blur(14px) saturate(145%)',
      WebkitBackdropFilter: 'blur(14px) saturate(145%)',
      border: '1px solid var(--viz-panel-border, rgba(111, 110, 105, 0.26))',
      boxShadow: 'var(--glass-shadow, 0 2px 10px rgba(40, 39, 38, 0.1))',
      transform: isCollapsed ? 'translateX(calc(100% + 16px))' : 'translateX(0)',
      opacity: isCollapsed ? 0 : 1,
      pointerEvents: isCollapsed ? 'none' : 'auto',
      willChange: 'transform, opacity',
      transition: sidebarTransition,
    };
  }, [isCollapsed, isExpanded, isDesktopSidebarLayout, clampedSidebarWidth]);

  const expandedSubNavProps = useMemo(() => ({
    dataset,
    scope,
    scopes,
    onScopeChange: handleScopeChange,
    onBack: handleToggleExpand,
  }), [dataset, scope, scopes, handleScopeChange, handleToggleExpand]);

  if (scopeError || scopeRowsError) {
    return (
      <>
        <SubNav user={userId} dataset={dataset} scope={scope} scopes={scopes} overlay={isExpanded} />
        <div style={{ padding: 16 }}>
          Failed to load scope data. {scopeError || scopeRowsError}
        </div>
      </>
    );
  }

  if (!dataset)
    return (
      <>
        <SubNav user={userId} dataset={dataset} scope={scope} scopes={scopes} overlay={isExpanded} />
        <div>Loading...</div>
      </>
    );

  return (
    <>
      {!isExpanded && (
        <SubNav
          user={userId}
          dataset={dataset}
          scope={scope}
          scopes={scopes}
          onScopeChange={handleScopeChange}
          overlay={false}
        />
      )}
      <ClusterColorProvider colorMap={colorMap}>
        <HoverProvider hoveredIndex={hoveredIndex}>
          <div className="page-container">
            <div
              ref={containerRef}
              className={`full-screen-explore-container ${isExpanded ? 'sidebar-expanded' : ''} ${isCollapsed ? 'sidebar-collapsed' : ''}`}
            >
          {/* Graph pane — always mounted, fades out in carousel mode */}
          <div
            ref={visualizationContainerRef}
            className={`visualization-pane-container ${isExpanded ? 'viz-hidden' : ''}`}
            onMouseLeave={() => {
              if (pinnedIndex === null) {
                // Use dismiss timer so hover card remains reachable briefly
                if (hoverDismissTimerRef.current) {
                  clearTimeout(hoverDismissTimerRef.current);
                }
                hoverDismissTimerRef.current = setTimeout(() => {
                  hoverDismissTimerRef.current = null;
                  if (!hoverCardHoveredRef.current) {
                    clearHoverState();
                  }
                }, 300);
              }
            }}
          >
            {scopeRows?.length && scopeLoaded ? (
              <VisualizationPane
                ref={vizRef}
                width={width}
                height={height}
                isHidden={isExpanded}
                contentPaddingRight={mapViewportPaddingRight}
                hovered={hovered}
                hoveredIndex={hoveredIndex}
                hoverAnchor={hoverAnchor}
                hoverPinned={pinnedIndex !== null}
                onHover={handleHover}
                onSelect={handlePointSelect}
                onLabelClick={handleLabelClick}
                onUnpinHover={handleUnpinHover}
                onFilterToCluster={handleFilterToCluster}
                hoverAnnotations={hoverAnnotations}
                hoveredCluster={hoveredCluster}
                textColumn={dataset?.text_column}
                linksEdges={mergedLinksEdges}
                linksAvailable={linksAvailable}
                linksMeta={linksMeta}
                linksLoading={isThread ? threadLinksLoading : linksLoading}
                onHoverCardMouseEnter={handleHoverCardMouseEnter}
                onHoverCardMouseLeave={handleHoverCardMouseLeave}
                timeRange={timeRange}
                timestamps={timelineData.timestamps}
                timelineDomain={timelineData.domain}
                timelineHasDates={timelineData.hasDates}
                timelineDatedCount={timelineData.datedCount}
                timelineTotalCount={scopeRows?.length || 0}
                isPlaying={isPlaying}
                onPlayToggle={handlePlayToggle}
                playbackSpeed={playbackSpeed}
                onSpeedChange={setPlaybackSpeed}
                onTimeRangeChange={handleTimeRangeChange}
                nodeStats={nodeStats}
                onViewThread={handleViewThread}
                onViewQuotes={handleViewQuotes}
                highlightIndices={graphHighlightIndices}
                threadsOnlyActive={threadsOnlyActive}
                threadsOnlyAvailable={threadsOnlyAvailable}
                onToggleThreadsOnly={toggleThreadsOnly}
              />
            ) : (
              <div className="viz-loading-placeholder" style={mapLoadingPlaceholderStyle}>
                <div className="viz-loading-spinner" />
              </div>
            )}

            {/* FAB button to reopen sidebar when collapsed */}
            {isCollapsed && (
              <button
                className="fab-expand-button"
                onClick={handleToggleCollapse}
                title="Show sidebar"
              >
                <PanelRightOpen size={20} />
              </button>
            )}
          </div>

          {/* Right pane: sidebar or carousel */}
          <div
            className="filter-table-container"
            style={sidebarPaneStyle}
          >
            {/* Toggle button on the divider edge (normal/thread mode) */}
            {(isNormal || isThread || isQuotes) && (
              <div className="sidebar-toggle-area">
                <div
                  className="drag-handle-zone"
                  onMouseDown={startDragging}
                />
                {clusterHierarchy && (
                  <button
                    className="sidebar-toggle-button sidebar-expand-button"
                    onClick={handleToggleExpand}
                    title="Expand to carousel"
                  >
                    <GalleryHorizontalEnd size={16} />
                  </button>
                )}
                <button
                  className="sidebar-toggle-button"
                  onClick={handleToggleCollapse}
                  title="Collapse sidebar"
                >
                  <PanelRightClose size={16} />
                </button>
              </div>
            )}

            <div className="sidebar-surface">
              {/* Normal mode: search controls + TweetFeed */}
              {isNormal && (
                <div
                  className="feed-scroll-container"
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    position: 'relative',
                  }}
                >
                  {/* Prominent carousel toggle button */}
                  {clusterHierarchy && (
                    <button
                      className="carousel-banner-button"
                      onClick={handleToggleExpand}
                    >
                      <GalleryHorizontalEnd size={18} />
                      <span>Browse All Topics</span>
                      <ChevronsRight size={16} className="carousel-banner-arrow" />
                    </button>
                  )}

                  <FilterActions />

                  <TweetFeed
                    dataset={dataset}
                    clusterMap={clusterMap}
                    onHover={undefined}
                    onClick={handleClicked}
                    nodeStats={nodeStats}
                    onViewThread={handleViewThread}
                    onViewQuotes={handleViewQuotes}
                  />
                </div>
              )}

              {/* Thread mode: ThreadView */}
              {isThread && (
                <ThreadView
                  datasetId={dataset.id}
                  scopeId={scope?.id}
                  tweetId={threadTargetTweetId}
                  currentLsIndex={threadTargetIndex}
                  nodeStats={nodeStats}
                  clusterMap={clusterMap}
                  dataset={dataset}
                  onBack={handleCloseThread}
                  onViewThread={handleViewThread}
                  onViewQuotes={handleViewQuotes}
                  onClickTweet={handleClicked}
                  onThreadDataChange={handleThreadDataChange}
                />
              )}

              {/* Quotes mode: QuoteView */}
              {isQuotes && (
                <QuoteView
                  datasetId={dataset.id}
                  scopeId={scope?.id}
                  tweetId={threadTargetTweetId}
                  nodeStats={nodeStats}
                  clusterMap={clusterMap}
                  dataset={dataset}
                  onBack={handleCloseThread}
                  onViewThread={handleViewThread}
                  onViewQuotes={handleViewQuotes}
                  onClickTweet={handleClicked}
                />
              )}

              {/* Expanded mode: Carousel with integrated topic list */}
              {isExpanded && (
                <div className="carousel-enter" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                  <FeedCarousel
                    topLevelClusters={carouselData.topLevelClusters}
                    columnData={carouselData.columnData}
                    columnRowsMap={carouselData.columnRowsMap}
                    loadMore={carouselData.loadMore}
                    ensureColumnsLoaded={carouselData.ensureColumnsLoaded}
                    activeSubClusters={carouselData.activeSubClusters}
                    setSubClusterFilter={carouselData.setSubClusterFilter}
                    dataset={dataset}
                    clusterMap={clusterMap}
                    focusedClusterIndex={focusedClusterIndex}
                    onFocusedIndexChange={setFocusedClusterIndex}
                    nodeStats={nodeStats}
                    onViewQuotes={handleViewQuotes}
                    subNavProps={expandedSubNavProps}
                  />
                </div>
              )}
            </div>
            </div>
          </div>
          </div>
        </HoverProvider>
      </ClusterColorProvider>
    </>
  );
}

// Make the main Explore component just handle the providers
function Explore() {
  return (
    <ScopeProvider>
      <FilterProvider>
        <ExploreContent />
      </FilterProvider>
    </ScopeProvider>
  );
}

export default Explore;
