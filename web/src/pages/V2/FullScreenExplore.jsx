import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronsRight, ChevronsLeft, Columns3, PanelRightClose } from 'lucide-react';

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
    setFilterQuery,
    featureFilter,
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

  // Carousel data hook
  const carouselData = useCarouselData(focusedClusterIndex);

  // Keep visualization-specific state
  const [scatter, setScatter] = useState({});
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [hoveredCluster, setHoveredCluster] = useState(null);
  const [hoverAnnotations, setHoverAnnotations] = useState([]);
  const [dataTableRows, setDataTableRows] = useState([]);
  const [selectedAnnotations, setSelectedAnnotations] = useState([]);

  // Add a ref to track the latest requested index
  const latestHoverIndexRef = useRef(null);

  // Modify the hover text hydration with debouncing
  const hydrateHoverText = useCallback(
    (index, setter) => {
      latestHoverIndexRef.current = index;
      apiService.getHoverText(scope, index).then((data) => {
        // Only update if this is still the latest requested index
        if (latestHoverIndexRef.current === index) {
          setter(data);
        }
      });
    },
    [userId, datasetId, scope]
  );

  const debouncedHydrateHoverText = useDebounce(hydrateHoverText, 5);

  useEffect(() => {
    if (
      hoveredIndex !== null &&
      hoveredIndex !== undefined &&
      !deletedIndices.includes(hoveredIndex)
    ) {
      debouncedHydrateHoverText(hoveredIndex, (text) => {
        setHovered({
          text: text,
          index: hoveredIndex,
          cluster: clusterMap[hoveredIndex],
        });
      });
    } else {
      setHovered(null);
      latestHoverIndexRef.current = null;
    }
  }, [hoveredIndex, deletedIndices, clusterMap, debouncedHydrateHoverText]);

  // Update hover annotations
  useEffect(() => {
    if (hoveredIndex !== null && hoveredIndex !== undefined) {
      let sr = scopeRows[hoveredIndex];
      setHoverAnnotations([[sr.x, sr.y]]);
    } else {
      setHoverAnnotations([]);
    }
  }, [hoveredIndex, scopeRows]);

  // Handlers for responding to individual data points
  const handleClicked = useCallback((index) => {
    console.log('====clicked====', index);
  }, []);

  const handleHover = useCallback(
    (index) => {
      const nonDeletedIndex = deletedIndices.includes(index) ? null : index;
      setHoveredIndex(nonDeletedIndex);
      if (nonDeletedIndex >= 0) {
        setHoveredCluster(clusterMap[nonDeletedIndex]);
      } else {
        setHoveredCluster(null);
      }
    },
    [deletedIndices]
  );

  const containerRef = useRef(null);
  const filtersContainerRef = useRef(null);
  const vizRef = useRef(null);

  // Handle zoom to cluster from TopicTree
  const handleZoomToCluster = useCallback((bounds) => {
    vizRef.current?.zoomToBounds(bounds, 500);
  }, []);

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
  const [size, setSize] = useState([500, 500]);
  const visualizationContainerRef = useRef(null);

  function updateSize() {
    if (visualizationContainerRef.current) {
      const vizRect = visualizationContainerRef.current.getBoundingClientRect();
      setSize([vizRect.width, vizRect.height]);
    }
  }

  // initial size
  useEffect(() => {
    const observer = new MutationObserver((mutations, obs) => {
      updateSize();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, []);

  // let's fill the container and update the width and height if window resizes
  useEffect(() => {
    window.addEventListener('resize', updateSize);
    updateSize();
    return () => window.removeEventListener('resize', updateSize);
  }, [visualizationContainerRef, containerRef]);

  const [width, height] = size;

  // ====================================================================================================
  // Draggable State (only active in normal mode)
  // ====================================================================================================
  const [normalGridTemplate, setNormalGridTemplate] = useState('50% 50%');

  const startDragging = (e) => {
    if (sidebarMode !== SIDEBAR_MODES.NORMAL) return;
    e.preventDefault();
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDragging);
  };

  const onDrag = (e) => {
    if (containerRef.current) {
      const containerRect = containerRef.current.getBoundingClientRect();
      const percentage = ((e.clientX - containerRect.left) / containerRect.width) * 100;
      const newTemplate = `${Math.min(Math.max(percentage, 20), 80)}% 1fr`;
      setNormalGridTemplate(newTemplate);
      updateSize();
    }
  };

  const stopDragging = () => {
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDragging);
  };

  // ====================================================================================================
  // Grid template based on sidebar mode
  // ====================================================================================================
  const gridTemplate = useMemo(() => {
    switch (sidebarMode) {
      case SIDEBAR_MODES.COLLAPSED:
        return '1fr 0px';
      case SIDEBAR_MODES.EXPANDED:
        return '0px 1fr';
      default:
        return normalGridTemplate;
    }
  }, [sidebarMode, normalGridTemplate]);

  // Update viz size after mode transition
  useEffect(() => {
    const timer = setTimeout(updateSize, 350); // After 300ms transition + buffer
    return () => clearTimeout(timer);
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

  if (!dataset)
    return (
      <>
        <SubNav user={userId} dataset={dataset} scope={scope} scopes={scopes} />
        <div>Loading...</div>
      </>
    );

  const isCollapsed = sidebarMode === SIDEBAR_MODES.COLLAPSED;
  const isExpanded = sidebarMode === SIDEBAR_MODES.EXPANDED;
  const isNormal = sidebarMode === SIDEBAR_MODES.NORMAL;

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
          style={{ gridTemplateColumns: gridTemplate }}
        >
          {/* Graph pane */}
          <div
            ref={visualizationContainerRef}
            className="visualization-pane-container"
            onMouseLeave={() => {
              setHoveredIndex(null);
              setHovered(null);
            }}
          >
            {scopeRows?.length && scopeLoaded ? (
              <VisualizationPane
                ref={vizRef}
                width={width}
                height={height}
                onScatter={setScatter}
                hovered={hovered}
                hoveredIndex={hoveredIndex}
                onHover={handleHover}
                onSelect={() => {}}
                hoverAnnotations={hoverAnnotations}
                selectedAnnotations={selectedAnnotations}
                hoveredCluster={hoveredCluster}
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
                <ChevronsLeft size={20} />
              </button>
            )}
          </div>

          {/* Right pane: sidebar or carousel */}
          <div
            className="filter-table-container"
            style={{
              position: 'relative',
              overflowX: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              overflow: isCollapsed ? 'hidden' : undefined,
            }}
          >
            {/* Toggle button on the divider edge */}
            {!isCollapsed && (
              <div className="sidebar-toggle-area">
                {isNormal && (
                  <>
                    <div
                      className="drag-handle-zone"
                      onMouseDown={startDragging}
                    />
                    <button
                      className="sidebar-toggle-button"
                      onClick={handleToggleCollapse}
                      title="Collapse sidebar"
                    >
                      <ChevronsRight size={16} />
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
                  </>
                )}
                {isExpanded && (
                  <button
                    className="sidebar-toggle-button"
                    onClick={handleToggleExpand}
                    title="Back to normal view"
                  >
                    <PanelRightClose size={16} />
                  </button>
                )}
              </div>
            )}

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
              <>
              <button
                className="carousel-back-button"
                onClick={handleToggleExpand}
              >
                <ChevronsLeft size={16} />
                <span>Back to Map</span>
              </button>
              <FeedCarousel
                topLevelClusters={carouselData.topLevelClusters}
                columnData={carouselData.columnData}
                getColumnRows={carouselData.getColumnRows}
                loadMore={carouselData.loadMore}
                activeSubClusters={carouselData.activeSubClusters}
                setSubClusterFilter={carouselData.setSubClusterFilter}
                dataset={dataset}
                clusterMap={clusterMap}
                focusedClusterIndex={focusedClusterIndex}
                onFocusedIndexChange={setFocusedClusterIndex}
                onHover={handleHover}
                onClick={handleClicked}
                hoveredIndex={hoveredIndex}
              />
              </>
            )}
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
