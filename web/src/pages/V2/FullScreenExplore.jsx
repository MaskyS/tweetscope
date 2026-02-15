import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronsRight, ChevronsLeft, GalleryHorizontalEnd, PanelRightClose, PanelRightOpen } from 'lucide-react';

import './Explore.css';
import { apiService } from '../../lib/apiService';

import SubNav from '../../components/SubNav';
import VisualizationPane from '../../components/Explore/V2/VisualizationPane';
import TweetFeed from '../../components/Explore/V2/TweetFeed';
import TopicTree from '../../components/Explore/V2/TopicTree';
import FeedCarousel from '../../components/Explore/V2/Carousel/FeedCarousel';
import ThreadView from '../../components/Explore/V2/ThreadView/ThreadView';
import QuoteView from '../../components/Explore/V2/ThreadView/QuoteView';

import { ScopeProvider, useScope } from '../../contexts/ScopeContext';
import { FilterProvider, useFilter } from '../../contexts/FilterContext';
import useDebounce from '../../hooks/useDebounce';
import useSidebarState, { SIDEBAR_MODES } from '../../hooks/useSidebarState';
import useCarouselData from '../../hooks/useCarouselData';
import useTimelineData from '../../hooks/useTimelineData';
import useNodeStats from '../../hooks/useNodeStats';

import { filterConstants } from '../../components/Explore/V2/Search/utils';

const EDGE_FETCH_MAX = 2500;

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
    sae,
    scopes,
    tags,
  } = useScope();

  const navigate = useNavigate();

  // Get filter-related state from FilterContext
  const {
    loading: filterLoading,
    shownIndices,
    filterConfig,
    setFilterQuery,
    clusterFilter,
    searchFilter,
    setFilterConfig,
    filterActive,
    setFilterActive,
    setUrlParams,
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

  // Carousel data hook — only enabled in expanded mode
  const carouselEnabled = sidebarMode === SIDEBAR_MODES.EXPANDED;
  const carouselData = useCarouselData(focusedClusterIndex, carouselEnabled);

  // Keep visualization-specific state
  const [scatter, setScatter] = useState({});
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [hoveredCluster, setHoveredCluster] = useState(null);
  const [hoverAnchor, setHoverAnchor] = useState(null);
  const [pinnedIndex, setPinnedIndex] = useState(null);
  const [hoverAnnotations, setHoverAnnotations] = useState([]);
  const [dataTableRows, setDataTableRows] = useState([]);
  const [selectedAnnotations, setSelectedAnnotations] = useState([]);
  const [linksMeta, setLinksMeta] = useState(null);
  const [linksAvailable, setLinksAvailable] = useState(false);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksEdges, setLinksEdges] = useState([]);
  const [threadHighlightIndices, setThreadHighlightIndices] = useState(null);
  const [threadLinksEdges, setThreadLinksEdges] = useState([]);
  const [threadLinksLoading, setThreadLinksLoading] = useState(false);

  // Node link stats (thread/quote metadata per tweet)
  const { statsMap: nodeStats, tweetIdMap } = useNodeStats(dataset?.id, linksAvailable);

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
      setFilterConfig({
        type: filterConstants.TIME_RANGE,
        start: staticRange[0],
        end: staticRange[1],
        timestampsByLsIndex: timelineData.timestampsByLsIndex,
        label: formatTimelineRangeLabel(staticRange),
      });
      setFilterActive(true);
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
    setFilterConfig,
    setFilterActive,
  ]);

  const handlePlayToggle = useCallback(() => {
    if (!isPlaying && timelineData.hasDates) {
      const nextRange = clampRangeToDomain(timeRange, [timelineStart, timelineEnd]) || [timelineStart, timelineStart];
      const playbackRange = [nextRange[0], nextRange[0]];
      // Always reset end to start so playback sweeps from the chosen start
      setTimeRange(playbackRange);
      setFilterConfig({
        type: filterConstants.TIME_RANGE,
        start: playbackRange[0],
        end: playbackRange[1],
        timestampsByLsIndex: timelineData.timestampsByLsIndex,
        label: formatTimelineRangeLabel(playbackRange),
      });
      setFilterActive(true);
    }
    setIsPlaying((p) => !p);
  }, [
    isPlaying,
    timelineData.hasDates,
    timelineData.timestampsByLsIndex,
    timelineStart,
    timelineEnd,
    timeRange,
    setFilterConfig,
    setFilterActive,
  ]);

  // Bridge time range changes to FilterContext
  const handleTimeRangeChange = useCallback(
    (range) => {
      const nextRange = clampRangeToDomain(range, [timelineStart, timelineEnd]);
      setTimeRange(nextRange);
      if (nextRange) {
        setFilterConfig({
          type: filterConstants.TIME_RANGE,
          start: nextRange[0],
          end: nextRange[1],
          timestampsByLsIndex: timelineData.timestampsByLsIndex,
          label: formatTimelineRangeLabel(nextRange),
        });
        setFilterActive(true);
      } else if (filterConfig?.type === filterConstants.TIME_RANGE) {
        setFilterConfig(null);
        setFilterActive(false);
      }
    },
    [
      timelineStart,
      timelineEnd,
      timelineData.timestampsByLsIndex,
      setFilterConfig,
      setFilterActive,
      filterConfig?.type,
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
      setFilterConfig({
        type: filterConstants.TIME_RANGE,
        start: normalizedRange[0],
        end: normalizedRange[1],
        timestampsByLsIndex: timelineData.timestampsByLsIndex,
        label: formatTimelineRangeLabel(normalizedRange),
      });
      setFilterActive(true);
    }, 300);
    return () => clearTimeout(playbackFilterTimerRef.current);
  }, [
    isPlaying,
    timeRange,
    timelineStart,
    timelineEnd,
    timelineData.timestampsByLsIndex,
    setFilterConfig,
    setFilterActive,
  ]);

  // Keep timeline filter state valid when scope/domain changes.
  useEffect(() => {
    if (filterConfig?.type !== filterConstants.TIME_RANGE) return;

    if (!timelineData.hasDates) {
      setIsPlaying(false);
      setTimeRange(null);
      setFilterConfig(null);
      setFilterActive(false);
      return;
    }

    const clampedFilterRange = clampRangeToDomain([filterConfig.start, filterConfig.end], [timelineStart, timelineEnd]);
    if (!clampedFilterRange) {
      setIsPlaying(false);
      setTimeRange(null);
      setFilterConfig(null);
      setFilterActive(false);
      return;
    }

    const nextLabel = formatTimelineRangeLabel(clampedFilterRange);
    const shouldUpdateFilter =
      filterConfig.start !== clampedFilterRange[0] ||
      filterConfig.end !== clampedFilterRange[1] ||
      filterConfig.timestampsByLsIndex !== timelineData.timestampsByLsIndex ||
      filterConfig.label !== nextLabel;

    if (shouldUpdateFilter) {
      setFilterConfig({
        type: filterConstants.TIME_RANGE,
        start: clampedFilterRange[0],
        end: clampedFilterRange[1],
        timestampsByLsIndex: timelineData.timestampsByLsIndex,
        label: nextLabel,
      });
    }

    if (!isPlaying && (!timeRange || timeRange[0] !== clampedFilterRange[0] || timeRange[1] !== clampedFilterRange[1])) {
      setTimeRange(clampedFilterRange);
    }

    if (!filterActive) {
      setFilterActive(true);
    }
  }, [
    filterConfig?.type,
    filterConfig?.start,
    filterConfig?.end,
    filterConfig?.label,
    filterConfig?.timestampsByLsIndex,
    filterActive,
    timelineData.hasDates,
    timelineData.timestampsByLsIndex,
    timelineStart,
    timelineEnd,
    isPlaying,
    timeRange,
    setFilterConfig,
    setFilterActive,
  ]);

  // If another filter becomes active, clear timeline-local range to avoid divergent UI state.
  useEffect(() => {
    if (filterConfig?.type === filterConstants.TIME_RANGE) return;
    if (isPlaying) setIsPlaying(false);
    if (timeRange !== null) setTimeRange(null);
  }, [filterConfig?.type, isPlaying, timeRange]);

  // Add a ref to track the latest requested index
  const latestHoverIndexRef = useRef(null);
  const hoverRecordCacheRef = useRef(new Map());
  const latestLinksRequestRef = useRef(0);
  const hoverDismissTimerRef = useRef(null);
  const hoverCardHoveredRef = useRef(false);

  const hoverColumns = useMemo(() => {
    return Array.from(new Set([scope?.dataset?.text_column, ...HOVER_METADATA_COLUMNS].filter(Boolean)));
  }, [scope?.dataset?.text_column]);

  // Hydrate hover records with a small cache to avoid repeated round-trips while scanning.
  const hydrateHoverRecord = useCallback(
    (index, setter) => {
      latestHoverIndexRef.current = index;
      const cached = hoverRecordCacheRef.current.get(index);
      if (cached) {
        setter(cached);
        return;
      }

      apiService.getHoverRecord(scope, index, hoverColumns).then((data) => {
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
      });
    },
    [scope, hoverColumns]
  );

  const debouncedHydrateHoverRecord = useDebounce(hydrateHoverRecord, 120);

  useEffect(() => {
    hoverRecordCacheRef.current.clear();
    latestHoverIndexRef.current = null;
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
    apiService
      .fetchLinksMeta(dataset.id)
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
      !deletedIndices.includes(hoveredIndex)
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
    }
  }, [sidebarMode, hoveredIndex, deletedIndices, clusterMap, debouncedHydrateHoverRecord, scope]);

  // Update hover annotations
  useEffect(() => {
    if (sidebarMode === SIDEBAR_MODES.EXPANDED) {
      setHoverAnnotations([]);
      return;
    }

    if (hoveredIndex !== null && hoveredIndex !== undefined) {
      let sr = scopeRows[hoveredIndex];
      setHoverAnnotations([[sr.x, sr.y]]);
    } else {
      setHoverAnnotations([]);
    }
  }, [sidebarMode, hoveredIndex, scopeRows]);

  const edgeQueryIndices = useMemo(() => {
    if (pinnedIndex !== null && pinnedIndex !== undefined && !deletedIndices.includes(pinnedIndex)) {
      return [pinnedIndex];
    }
    if (hoveredIndex !== null && hoveredIndex !== undefined && !deletedIndices.includes(hoveredIndex)) {
      return [hoveredIndex];
    }
    return [];
  }, [pinnedIndex, hoveredIndex, deletedIndices]);

  const fetchLinksEdges = useCallback(
    (indices) => {
      if (!dataset?.id || !linksAvailable || !Array.isArray(indices)) {
        return;
      }

      const requestId = latestLinksRequestRef.current + 1;
      latestLinksRequestRef.current = requestId;
      setLinksLoading(true);

      apiService
        .fetchLinksByIndices(dataset.id, {
          indices: indices.length > 0 ? indices : null,
          edge_kinds: ['reply', 'quote'],
          include_external: false,
          max_edges: EDGE_FETCH_MAX,
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
      sidebarMode === SIDEBAR_MODES.THREAD ||
      sidebarMode === SIDEBAR_MODES.QUOTES ||
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
  const handleClicked = useCallback(() => {}, []);

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
    setHoverAnchor(null);
    setHoveredIndex(null);
    setHoveredCluster(null);
    setHovered(null);
    latestHoverIndexRef.current = null;
  }, []);

  const handleHover = useCallback(
    (payload) => {
      if (pinnedIndex !== null) {
        return;
      }
      const rawIndex = payload && typeof payload === 'object' ? payload.index : payload;
      const index = Number.isInteger(rawIndex) ? rawIndex : null;
      const nonDeletedIndex = deletedIndices.includes(index) ? null : index;
      const hasPointCoords =
        payload &&
        typeof payload === 'object' &&
        Number.isFinite(payload.x) &&
        Number.isFinite(payload.y);

      // When hovering a new point, cancel any pending dismiss
      if (nonDeletedIndex !== null) {
        if (hoverDismissTimerRef.current) {
          clearTimeout(hoverDismissTimerRef.current);
          hoverDismissTimerRef.current = null;
        }
        if (hasPointCoords) {
          setHoverAnchor({ x: payload.x, y: payload.y });
        }
        setHoveredIndex((prev) => (prev === nonDeletedIndex ? prev : nonDeletedIndex));
        const nextCluster = nonDeletedIndex >= 0 ? clusterMap[nonDeletedIndex] : null;
        setHoveredCluster((prev) => {
          if ((prev?.cluster ?? null) === (nextCluster?.cluster ?? null)) {
            return prev;
          }
          return nextCluster;
        });
      } else {
        // Mouse left a point — delay dismissal so user can reach the hover card
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
      if (idx === null || idx === undefined || deletedIndices.includes(idx)) {
        setPinnedIndex(null);
        setHoveredIndex(null);
        setHovered(null);
        setHoveredCluster(null);
        setHoverAnchor(null);
        latestHoverIndexRef.current = null;

        if (filterConfig?.type === filterConstants.CLUSTER) {
          clusterFilter.clear();
          setFilterQuery('');
          setFilterConfig(null);
          setFilterActive(false);
          setUrlParams((prev) => {
            prev.delete('cluster');
            prev.delete('feature');
            prev.delete('search');
            prev.delete('column');
            prev.delete('value');
            return new URLSearchParams(prev);
          });
        }
        return;
      }
      setPinnedIndex(idx);
      setHoveredIndex(idx);
      setHoveredCluster(clusterMap[idx] || null);
      latestHoverIndexRef.current = idx;
    },
    [deletedIndices, clusterMap, filterConfig, clusterFilter, setFilterQuery, setFilterConfig, setFilterActive, setUrlParams]
  );

  const handleUnpinHover = useCallback(() => {
    setPinnedIndex(null);
    setHoveredIndex(null);
    setHovered(null);
    setHoveredCluster(null);
    setHoverAnchor(null);
    latestHoverIndexRef.current = null;
  }, []);

  const handleFilterToCluster = useCallback(
    (cluster) => {
      if (!cluster || cluster.cluster === undefined || cluster.cluster === null) return;
      setFilterQuery(cluster.label || String(cluster.cluster));
      setFilterConfig({
        type: filterConstants.CLUSTER,
        value: cluster.cluster,
        label: cluster.label || String(cluster.cluster),
      });
      clusterFilter.setCluster(cluster);
      setFilterActive(true);
      setUrlParams((prev) => {
        prev.set('cluster', cluster.cluster);
        prev.delete('feature');
        prev.delete('search');
        prev.delete('column');
        prev.delete('value');
        return new URLSearchParams(prev);
      });
    },
    [clusterFilter, setFilterQuery, setFilterConfig, setFilterActive, setUrlParams]
  );

  const containerRef = useRef(null);
  const filtersContainerRef = useRef(null);
  const vizRef = useRef(null);

  // Handle zoom to cluster from TopicTree
  const handleZoomToCluster = useCallback((bounds) => {
    vizRef.current?.zoomToBounds(bounds, 500);
  }, []);

  // Handle clicking a cluster label on the map: filter + zoom
  const handleLabelClick = useCallback(
    ({ cluster: clusterIndex, label }) => {
      // Find matching cluster from clusterLabels to get hull
      const clusterObj = clusterLabels?.find(c => c.cluster === clusterIndex);
      if (!clusterObj) return;

      // Filter sidebar to this cluster
      handleFilterToCluster({ cluster: clusterIndex, label });

      // Zoom to cluster bounds using hull
      if (clusterObj.hull && clusterObj.hull.length >= 3 && scopeRows) {
        const hullPoints = clusterObj.hull
          .map(idx => scopeRows[idx])
          .filter(p => p && !p.deleted);
        if (hullPoints.length >= 3) {
          const xs = hullPoints.map(p => p.x);
          const ys = hullPoints.map(p => p.y);
          const padX = (Math.max(...xs) - Math.min(...xs)) * 0.15;
          const padY = (Math.max(...ys) - Math.min(...ys)) * 0.15;
          vizRef.current?.zoomToBounds([
            Math.min(...xs) - padX,
            Math.min(...ys) - padY,
            Math.max(...xs) + padX,
            Math.max(...ys) + padY,
          ], 500);
        }
      }
    },
    [clusterLabels, scopeRows, handleFilterToCluster]
  );

  const [filtersHeight, setFiltersHeight] = useState(250);
  const FILTERS_PADDING = 2;
  const tableHeight = useMemo(
    () => `calc(100% - ${filtersHeight + FILTERS_PADDING}px)`,
    [filtersHeight]
  );

  const handleScopeChange = useCallback(
    (e) => {
      navigate(`/datasets/${dataset?.id}/explore/${e.target.value}`);
    },
    [dataset, navigate]
  );

  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const { height } = entry.contentRect;
        setFiltersHeight(height);
      }
    });

    let node = filtersContainerRef?.current;
    if (node) {
      resizeObserver.observe(node);
    } else {
      setTimeout(() => {
        node = filtersContainerRef?.current;
        if (node) {
          resizeObserver.observe(node);
        } else {
          setFiltersHeight(0);
        }
      }, 100);
    }

    return () => {
      if (node) {
        resizeObserver.unobserve(node);
      }
    };
  }, []);

  // ====================================================================================================
  // Fullscreen related logic
  // ====================================================================================================
  const [size, setSize] = useState(() => [window.innerWidth, window.innerHeight]);
  const visualizationContainerRef = useRef(null);
  const resizeRafRef = useRef(null);

  function updateSize() {
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

  // Update viz size after mode transition
  useEffect(() => {
    const timer = setTimeout(updateSize, 350); // After 300ms transition + buffer
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
  }, [sidebarMode]);

  // ====================================================================================================
  // Sidebar mode transitions
  // ====================================================================================================
  const handleToggleExpand = useCallback(() => {
    const graphViewState = vizRef.current?.getViewState?.();
    toggleExpand(graphViewState);
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
      const cluster = carouselData.topLevelClusters[focusedClusterIndex];
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
  }, [sidebarMode, focusedClusterIndex, carouselData.topLevelClusters, scopeRows]);

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

  if (!dataset)
    return (
      <>
        <SubNav user={userId} dataset={dataset} scope={scope} scopes={scopes} />
        <div>Loading...</div>
      </>
    );

  return (
    <>
      <SubNav
        user={userId}
        dataset={dataset}
        scope={scope}
        scopes={scopes}
        onScopeChange={handleScopeChange}
      />
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
                contentPaddingRight={mapViewportPaddingRight}
                onScatter={setScatter}
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
                selectedAnnotations={selectedAnnotations}
                hoveredCluster={hoveredCluster}
                textColumn={dataset?.text_column}
                dataTableRows={dataTableRows}
                linksEdges={isThread ? threadLinksEdges : linksEdges}
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
                threadHighlightIndices={isThread ? threadHighlightIndices : null}
              />
            ) : null}

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
              {/* Normal mode: TopicTree + TweetFeed */}
              {isNormal && (
                <div
                  ref={filtersContainerRef}
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

                  {clusterLabels && clusterLabels.length > 0 && (
                    <TopicTree
                      onZoomToCluster={handleZoomToCluster}
                      hoveredCluster={hoveredCluster}
                    />
                  )}
                  <TweetFeed
                    dataset={dataset}
                    distances={searchFilter.distances}
                    clusterMap={clusterMap}
                    sae_id={sae?.id}
                    onHover={undefined}
                    onClick={handleClicked}
                    hoveredIndex={null}
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
                />
              )}

              {/* Expanded mode: FeedCarousel */}
              {isExpanded && (
                <div className="carousel-enter" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}>
                <button
                  className="carousel-back-button"
                  onClick={handleToggleExpand}
                >
                  <ChevronsLeft size={14} />
                  <span>Back to Map</span>
                </button>
                <FeedCarousel
                  topLevelClusters={carouselData.topLevelClusters}
                  columnData={carouselData.columnData}
                  columnRowsMap={carouselData.columnRowsMap}
                  loadMore={carouselData.loadMore}
                  activeSubClusters={carouselData.activeSubClusters}
                  setSubClusterFilter={carouselData.setSubClusterFilter}
                  dataset={dataset}
                  clusterMap={clusterMap}
                  focusedClusterIndex={focusedClusterIndex}
                  onFocusedIndexChange={setFocusedClusterIndex}
                  onHover={undefined}
                  onClick={undefined}
                  hoveredIndex={null}
                  nodeStats={nodeStats}
                  onViewThread={handleViewThread}
                  onViewQuotes={handleViewQuotes}
                />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
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
