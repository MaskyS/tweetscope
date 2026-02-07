import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronsRight, ChevronsLeft, Columns3, PanelRightClose, PanelRightOpen } from 'lucide-react';

import './Explore.css';
import { apiService } from '../../lib/apiService';

import SubNav from '../../components/SubNav';
import VisualizationPane from '../../components/Explore/V2/VisualizationPane';
import TweetFeed from '../../components/Explore/V2/TweetFeed';
import TopicTree from '../../components/Explore/V2/TopicTree';
import FeedCarousel from '../../components/Explore/V2/Carousel/FeedCarousel';

import { ScopeProvider, useScope } from '../../contexts/ScopeContext';
import { FilterProvider, useFilter } from '../../contexts/FilterContext';
import useDebounce from '../../hooks/useDebounce';
import useSidebarState, { SIDEBAR_MODES } from '../../hooks/useSidebarState';
import useCarouselData from '../../hooks/useCarouselData';

import { filterConstants } from '../../components/Explore/V2/Search/utils';

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
];

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
    featureFilter,
    clusterFilter,
    searchFilter,
    setFilterConfig,
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

  // Add a ref to track the latest requested index
  const latestHoverIndexRef = useRef(null);
  const hoverRecordCacheRef = useRef(new Map());

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

  // Handlers for responding to individual data points
  const handleClicked = useCallback(() => {}, []);

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

      if (hasPointCoords) {
        setHoverAnchor({ x: payload.x, y: payload.y });
      } else if (nonDeletedIndex === null) {
        setHoverAnchor(null);
      }

      setHoveredIndex((prev) => (prev === nonDeletedIndex ? prev : nonDeletedIndex));
      const nextCluster = nonDeletedIndex >= 0 ? clusterMap[nonDeletedIndex] : null;
      setHoveredCluster((prev) => {
        if ((prev?.cluster ?? null) === (nextCluster?.cluster ?? null)) {
          return prev;
        }
        return nextCluster;
      });
    },
    [deletedIndices, clusterMap, pinnedIndex]
  );

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
  const isDesktopViewport = width >= 1024;
  const isDesktopOverlay = isNormal && isDesktopViewport;
  const isDesktopSidebarLayout = !isExpanded && isDesktopViewport;

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
    if (sidebarMode !== SIDEBAR_MODES.NORMAL) return;
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

  const handleFeatureClick = useCallback(
    (featIdx, activation, label) => {
      setFilterQuery(label);
      setFilterConfig({ type: filterConstants.FEATURE, value: featIdx, label });
      featureFilter.setFeature(featIdx);
      setFilterActive(true);
      setUrlParams((prev) => {
        prev.set('feature', featIdx);
        return new URLSearchParams(prev);
      });
    },
    [featureFilter.setFeature, setFilterQuery, setFilterConfig, setFilterActive, setUrlParams]
  );

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
                setHoveredIndex(null);
                setHovered(null);
                setHoverAnchor(null);
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
            {/* Toggle button on the divider edge (normal mode only) */}
            {isNormal && (
              <div className="sidebar-toggle-area">
                <div
                  className="drag-handle-zone"
                  onMouseDown={startDragging}
                />
                <button
                  className="sidebar-toggle-button"
                  onClick={handleToggleCollapse}
                  title="Collapse sidebar"
                >
                  <PanelRightClose size={16} />
                </button>
                {clusterHierarchy && (
                  <button
                    className="sidebar-toggle-button sidebar-expand-button"
                    onClick={handleToggleExpand}
                    title="Expand to carousel"
                  >
                    <Columns3 size={16} />
                  </button>
                )}
              </div>
            )}

            <div className="sidebar-surface">
              {/* Normal mode: TopicTree + TweetFeed */}
              {!isExpanded && (
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
                      <Columns3 size={18} />
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
                    onHover={handleHover}
                    onClick={handleClicked}
                    hoveredIndex={hoveredIndex}
                  />
                </div>
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
