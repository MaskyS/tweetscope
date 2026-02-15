import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import { groups } from 'd3-array';
import PropTypes from 'prop-types';
import Scatter, { getClusterColorCSS, getClusterColorRGBA } from './DeckGLScatter';
import AnnotationPlot from '../../AnnotationPlot';
import HullPlot from '../../HullPlot';
import TilePlot from '../../TilePlot';
import { processHulls } from './util';
// import PointLabel from './PointLabel'; // Removed - DeckGLScatter handles this internally
import { filterConstants } from './Search/utils';

import { useColorMode } from '../../../hooks/useColorMode';
import ConnectionBadges from './ConnectionBadges';

import { useScope } from '../../../contexts/ScopeContext';
import { useFilter } from '../../../contexts/FilterContext';

import { Heart, Repeat2 } from 'lucide-react';
import { mapSelectionKey } from '../../../lib/colors';
import { urlResolver } from '../../../lib/urlResolver';
import styles from './VisualizationPane.module.scss';
import hoverStyles from './HoverCard.module.scss';
import ConfigurationPanel from '../ConfigurationPanel';
import TimelineControls from './TimelineControls';
import TwitterEmbed from './TweetFeed/TwitterEmbed';
import { Button } from 'react-element-forge';

const DATE_COLUMN_NAMES = ['created_at', 'date', 'timestamp', 'time', 'posted_at', 'published_at'];

function getFirstValue(obj, keys) {
  if (!obj) return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }
  return null;
}

function toNumber(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const num = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(num) ? num : 0;
}

function formatDate(dateValue) {
  if (!dateValue) return null;
  try {
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (_error) {
    return null;
  }
}

function formatCount(value) {
  const num = toNumber(value);
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return String(num);
}

const TCO_RE = /https?:\/\/t\.co\/[a-zA-Z0-9]+/g;
const STATUS_URL_RE = /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?:[A-Za-z0-9_]+)\/status\/(\d+)/i;

function stripTcoUrls(text) {
  return text.replace(TCO_RE, '').replace(/\s{2,}/g, ' ').trim();
}

function parseJsonArray(str) {
  if (!str) return [];
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function classifyUrls(urlsJson) {
  const urls = parseJsonArray(urlsJson);
  const quotedTweets = [];
  const externalUrls = [];
  for (const href of urls) {
    if (typeof href !== 'string') continue;
    const statusMatch = href.match(STATUS_URL_RE);
    if (statusMatch) {
      quotedTweets.push({ tweetId: statusMatch[1], tweetUrl: href });
    } else {
      try {
        const u = new URL(href);
        const path = u.pathname + u.search;
        const display = u.hostname + (path.length > 1 ? path : '');
        externalUrls.push({ href, display: display.length > 45 ? display.slice(0, 42) + '...' : display });
      } catch {
        externalUrls.push({ href, display: href.slice(0, 45) });
      }
    }
  }
  return { quotedTweets, externalUrls };
}

function rgbaFromRgbArray(rgb, alpha) {
  if (!rgb || rgb.length < 3) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

// VisualizationPane.propTypes = {
//   hoverAnnotations: PropTypes.array.isRequired,
//   hoveredCluster: PropTypes.object,
//   cluster: PropTypes.object,
//   scope: PropTypes.object,
//   selectedAnnotations: PropTypes.array.isRequired,
//   onScatter: PropTypes.func.isRequired,
//   onSelect: PropTypes.func.isRequired,
//   onHover: PropTypes.func.isRequired,
//   hovered: PropTypes.object,
//   dataset: PropTypes.object.isRequired,
//   containerRef: PropTypes.object.isRequired,
// };

const VisualizationPane = forwardRef(function VisualizationPane({
  width,
  height,
  contentPaddingRight = 0,
  onScatter,
  hovered,
  hoveredIndex,
  hoverAnchor,
  hoverPinned = false,
  onHover,
  onSelect,
  onLabelClick,
  onUnpinHover,
  onFilterToCluster,
  hoverAnnotations,
  selectedAnnotations,
  hoveredCluster,
  textColumn,
  dataTableRows,
  linksEdges = [],
  linksAvailable = false,
  linksMeta = null,
  linksLoading = false,
  onHoverCardMouseEnter,
  onHoverCardMouseLeave,
  // Timeline props
  timeRange = null,
  timestamps = null,
  timelineDomain = null,
  timelineHasDates = false,
  timelineDatedCount = 0,
  timelineTotalCount = 0,
  isPlaying = false,
  onPlayToggle,
  playbackSpeed = 1,
  onSpeedChange,
  onTimeRangeChange,
  nodeStats = null,
  onViewThread,
  onViewQuotes,
  threadHighlightIndices = null,
}, ref) {
  const { scopeRows, scope, features } = useScope();
  const { isDark: isDarkMode } = useColorMode();

  const { featureFilter, clusterFilter, shownIndices, filterConfig, filteredIndices } = useFilter();

  // only show the hull if we are filtering by cluster
  const showHull = filterConfig?.type === filterConstants.CLUSTER;

  const maxZoom = 40;

  // Ref for scatter component to enable programmatic zoom
  const scatterRef = useRef(null);

  // Expose zoomToBounds and getViewState methods to parent
  useImperativeHandle(ref, () => ({
    zoomToBounds: (bounds, duration) => {
      scatterRef.current?.zoomToBounds(bounds, duration);
    },
    getViewState: () => scatterRef.current?.getViewState?.(),
    setViewState: (viewState, duration) => {
      scatterRef.current?.setViewState?.(viewState, duration);
    },
  }), []);

  const [xDomain, setXDomain] = useState([-1, 1]);
  const [yDomain, setYDomain] = useState([-1, 1]);
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });
  const handleView = useCallback(
    (xDomain, yDomain, transform) => {
      setXDomain(xDomain);
      setYDomain(yDomain);
      setTransform(transform);
    },
    [setXDomain, setYDomain]
  );

  // const [isFullScreen, setIsFullScreen] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(true);
  const umapRef = useRef(null);
  const [umapOffset, setUmapOffset] = useState(0);

  const size = [width, height];

  const featureIsSelected = featureFilter.feature !== -1;

  // Add new memoized feature activation lookup
  const featureActivationMap = useMemo(() => {
    if (!featureIsSelected || !dataTableRows || !shownIndices) {
      return new Map();
    }

    const lookup = new Map();
    dataTableRows.forEach((data, index) => {
      const activatedIdx = data.sae_indices.indexOf(featureFilter.feature);
      if (activatedIdx !== -1) {
        const activatedFeature = data.sae_acts[activatedIdx];
        // normalize the activation to be between 0 and 1
        const min = 0.0;
        const max = features[featureFilter.feature].dataset_max;
        const normalizedActivation = (activatedFeature - min) / (max - min);
        lookup.set(data.ls_index, normalizedActivation);
      }
    });
    return lookup;
  }, [featureIsSelected, dataTableRows, featureFilter.feature, features]);

  const isFilterActive = !!filterConfig;
  const filteredIndexSet = useMemo(() => new Set(filteredIndices || []), [filteredIndices]);

  // Points format: [x, y, selectionKey, activation, cluster]
  const drawingPoints = useMemo(() => {
    return scopeRows.map((p, i) => {
      const cluster = p.cluster ?? 0;
      const lsIndex = p.ls_index ?? i;
      const isFilterMatch = isFilterActive ? filteredIndexSet.has(lsIndex) : true;

      // Time range check (applied locally so playback updates are reflected immediately)
      let isTimeMatch = true;
      if (timeRange && timestamps) {
        const ts = timestamps[i];
        if (!Number.isNaN(ts)) {
          isTimeMatch = ts >= timeRange[0] && ts <= timeRange[1];
        }
        // NaN (dateless rows) pass through — stay visible
      }

      const isMatch = isFilterMatch && isTimeMatch;

      if (p.deleted) {
        return [-10, -10, mapSelectionKey.hidden, 0.0, cluster];
      }

      if (featureIsSelected) {
        const activation = featureActivationMap.get(lsIndex);
        const selectionKey = isMatch ? mapSelectionKey.selected : mapSelectionKey.notSelected;
        return [
          p.x,
          p.y,
          selectionKey,
          selectionKey === mapSelectionKey.selected && activation !== undefined ? activation : 0.0,
          cluster,
        ];
      }

      if (isFilterActive || timeRange) {
        return [
          p.x,
          p.y,
          isMatch ? mapSelectionKey.selected : mapSelectionKey.notSelected,
          0.0,
          cluster,
        ];
      }

      return [p.x, p.y, mapSelectionKey.normal, 0.0, cluster];
    });
  }, [scopeRows, featureActivationMap, featureIsSelected, isFilterActive, filteredIndexSet, timeRange, timestamps]);

  const points = useMemo(() => {
    return scopeRows
      .filter((p) => !p.deleted)
      .map((p) => {
        return [p.x, p.y];
      });
  }, [scopeRows]);

  // const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  // useEffect(() => {
  //   console.log('==== hovered ==== ', hovered);
  //   if (hovered) {
  //     // console.log("hovered", hovered, scopeRows[hovered.index])
  //     const point = scopeRows[hovered.index];
  //     if (point && xDomain && yDomain) {
  //       let px = point.x;
  //       if (px < xDomain[0]) px = xDomain[0];
  //       if (px > xDomain[1]) px = xDomain[1];
  //       let py = point.y;
  //       if (py < yDomain[0]) py = yDomain[0];
  //       if (py > yDomain[1]) py = yDomain[1];
  //       const xPos = ((px - xDomain[0]) / (xDomain[1] - xDomain[0])) * width + 19;
  //       const yPos = ((py - yDomain[1]) / (yDomain[0] - yDomain[1])) * size[1] + umapOffset - 28;
  //       // console.log("xPos", xPos, "yPos", yPos)
  //       setTooltipPosition({
  //         x: xPos,
  //         y: yPos,
  //       });
  //     }
  //   }
  // }, [hovered, scopeRows, xDomain, yDomain, width, height, umapOffset]);

  // derive the hulls from the cluster, and filter deleted points via an accessor
  const clusterHulls = useMemo(() => {
    if (!clusterFilter.cluster || !scopeRows) return [];
    return processHulls([clusterFilter.cluster], scopeRows, (d) => (d.deleted ? null : [d.x, d.y]));
  }, [clusterFilter.cluster, scopeRows]);

  const hoveredHulls = useMemo(() => {
    if (!hoveredCluster || !scopeRows) return [];
    return processHulls([hoveredCluster], scopeRows, (d) => (d.deleted ? null : [d?.x, d?.y]));
  }, [hoveredCluster, scopeRows]);

  // TODO: these should just be based on which tile we choose, 32, 64 or 128
  const tileMeta = useMemo(() => {
    return {
      size: 2 / 64,
      cols: 64,
    };
  }, []);
  const tiles = useMemo(() => {
    return groups(scopeRows, (d) => d.tile_index_64).map((tile) => {
      return {
        tile_index: tile[0],
        points: tile[1],
      };
    });
  }, [scopeRows]);

  // ====================================================================================================
  // Configuration Panel
  // ====================================================================================================
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [vizConfig, setVizConfig] = useState({
    showHeatMap: false,
    showClusterOutlines: true,
    pointSize: 1,
    pointOpacity: 1,
    showReplyEdges: true,
    showQuoteEdges: true,
    edgeWidthScale: 0.7,
    showTimeline: false,
  });

  const toggleShowHeatMap = useCallback(() => {
    setVizConfig((prev) => ({ ...prev, showHeatMap: !prev.showHeatMap }));
  }, []);

  const toggleShowClusterOutlines = useCallback(() => {
    setVizConfig((prev) => ({ ...prev, showClusterOutlines: !prev.showClusterOutlines }));
  }, []);

  const updatePointSize = useCallback((value) => {
    setVizConfig((prev) => ({ ...prev, pointSize: value }));
  }, []);

  const updatePointOpacity = useCallback((value) => {
    setVizConfig((prev) => ({ ...prev, pointOpacity: value }));
  }, []);

  const toggleShowReplyEdges = useCallback(() => {
    setVizConfig((prev) => ({ ...prev, showReplyEdges: !prev.showReplyEdges }));
  }, []);

  const toggleShowQuoteEdges = useCallback(() => {
    setVizConfig((prev) => ({ ...prev, showQuoteEdges: !prev.showQuoteEdges }));
  }, []);

  const updateEdgeWidthScale = useCallback((value) => {
    setVizConfig((prev) => ({ ...prev, edgeWidthScale: value }));
  }, []);

  const toggleShowTimeline = useCallback(() => {
    setVizConfig((prev) => ({ ...prev, showTimeline: !prev.showTimeline }));
  }, []);

  // ensure the order of selectedPoints
  // exactly matches the ordering of indexes in shownIndices.
  const selectedPoints = useMemo(() => {
    if (!shownIndices || !scopeRows) return [];
    return shownIndices
      .map((ls_index, i) => {
        // Find the point in scopeRows with matching ls_index
        const point = scopeRows.find((p) => p.ls_index === ls_index);
        return point ? { ...point, index: i } : null;
      })
      .filter((point) => point !== null);
  }, [shownIndices, scopeRows]);

  // Async URL resolution fallback state
  const [asyncMedia, setAsyncMedia] = useState([]);
  const [asyncQuotes, setAsyncQuotes] = useState([]);
  const asyncResolvedIdRef = useRef(null);

  const hoverCardData = useMemo(() => {
    if (!hovered) return null;
    const record = hovered || {};
    const dateValue = getFirstValue(record, DATE_COLUMN_NAMES);
    const likesValue = getFirstValue(record, ['favorites', 'favorite_count', 'like_count', 'likes']);
    const retweetValue = getFirstValue(record, ['retweets', 'retweet_count']);

    const username = record.username || null;
    const tweetId = record.id ? String(record.id) : null;
    const tweetUrl = username && tweetId ? `https://x.com/${username}/status/${tweetId}` : null;
    const typeRaw = String(record.tweet_type || '').trim().toLowerCase();
    const isLike = record.is_like === true || typeRaw === 'like';

    const rawText = String(
      record.text ||
      (textColumn ? record[textColumn] : '') ||
      ''
    ).trim();
    const displayText = stripTcoUrls(rawText);
    const tcoLinks = rawText.match(TCO_RE) || [];

    // Parse URL columns from parquet
    const { quotedTweets, externalUrls } = classifyUrls(record.urls_json);
    const mediaUrls = parseJsonArray(record.media_urls_json);
    const hasParquetUrls = quotedTweets.length > 0 || externalUrls.length > 0 || mediaUrls.length > 0;

    // Show type label only for non-default types
    let typeLabel = null;
    if (isLike) typeLabel = 'Like';
    else if (typeRaw === 'retweet' || typeRaw === 'is_retweet') typeLabel = 'Retweet';

    return {
      rawText,
      displayText,
      tcoLinks,
      username,
      displayName: record.display_name || null,
      dateLabel: formatDate(dateValue),
      typeLabel,
      likes: likesValue === null ? null : toNumber(likesValue),
      retweets: retweetValue === null ? null : toNumber(retweetValue),
      tweetUrl,
      quotedTweets,
      mediaUrls,
      externalUrls,
      hasParquetUrls,
      index: hovered.index,
    };
  }, [hovered, textColumn]);

  // Async fallback: resolve t.co links when parquet has no URL data
  useEffect(() => {
    if (!hoverCardData || hoverCardData.hasParquetUrls || hoverCardData.tcoLinks.length === 0) {
      if (asyncResolvedIdRef.current !== null) {
        setAsyncMedia([]);
        setAsyncQuotes([]);
        asyncResolvedIdRef.current = null;
      }
      return;
    }
    const resolveId = hoverCardData.index;
    if (asyncResolvedIdRef.current === resolveId) return;
    asyncResolvedIdRef.current = resolveId;

    urlResolver.resolve(hoverCardData.tcoLinks).then((results) => {
      if (asyncResolvedIdRef.current !== resolveId) return;
      setAsyncMedia(results.filter((r) => r.type === 'image' && r.media_url && !r.error));
      setAsyncQuotes(results.filter((r) => r.type === 'quote' && r.media_url && !r.error).map((r) => ({
        tweetId: String(r.media_url),
        tweetUrl: r.final,
      })));
    }).catch(() => {
      if (asyncResolvedIdRef.current === resolveId) {
        setAsyncMedia([]);
        setAsyncQuotes([]);
      }
    });
  }, [hoverCardData]);

  const hoverCardPosition = useMemo(() => {
    if (!hovered) return null;
    const cardWidth = 360;
    const margin = 12;
    const offset = 14;
    const visibleWidth = Math.max(320, width - contentPaddingRight);

    const anchorX = Number.isFinite(hoverAnchor?.x) ? hoverAnchor.x : visibleWidth - margin - cardWidth;
    const anchorY = Number.isFinite(hoverAnchor?.y) ? hoverAnchor.y : 20;

    let left = anchorX + offset;
    if (left + cardWidth > visibleWidth - margin) {
      left = anchorX - cardWidth - offset;
    }
    left = Math.min(Math.max(left, margin), Math.max(margin, visibleWidth - cardWidth - margin));

    const estimatedHeight = hoverPinned ? 320 : 260;
    let top = anchorY + offset;
    if (top + estimatedHeight > height - margin) {
      top = anchorY - estimatedHeight - offset;
    }
    top = Math.min(Math.max(top, margin), Math.max(margin, height - estimatedHeight - margin));

    return {
      left,
      top,
      width: Math.min(cardWidth, visibleWidth - margin * 2),
    };
  }, [hovered, hoverAnchor, hoverPinned, width, height, contentPaddingRight]);

  const handleCopyText = useCallback(() => {
    if (!hoverCardData?.rawText || !navigator?.clipboard?.writeText) return;
    navigator.clipboard.writeText(hoverCardData.rawText).catch(() => {});
  }, [hoverCardData?.rawText]);

  const hoverClusterRgb = useMemo(() => {
    if (!hoveredCluster) return null;
    return getClusterColorRGBA(hoveredCluster.cluster, isDarkMode);
  }, [hoveredCluster, isDarkMode]);

  const selectedClusterRgb = useMemo(() => {
    if (!clusterFilter.cluster) return null;
    return getClusterColorRGBA(clusterFilter.cluster.cluster, isDarkMode);
  }, [clusterFilter.cluster, isDarkMode]);

  const hoverHullFill = hoverClusterRgb ? rgbaFromRgbArray(hoverClusterRgb, 0.22) : (isDarkMode ? 'rgba(191, 232, 217, 0.2)' : 'rgba(58, 169, 159, 0.18)');
  const hoverHullStroke = hoverClusterRgb ? rgbaFromRgbArray(hoverClusterRgb, 0.92) : (isDarkMode ? 'rgba(221, 241, 228, 0.9)' : 'rgba(36, 131, 123, 0.88)');
  const selectedHullFill = selectedClusterRgb ? rgbaFromRgbArray(selectedClusterRgb, 0.24) : (isDarkMode ? 'rgba(171, 207, 226, 0.22)' : 'rgba(67, 133, 190, 0.2)');
  const selectedHullStroke = selectedClusterRgb ? rgbaFromRgbArray(selectedClusterRgb, 0.96) : (isDarkMode ? 'rgba(198, 221, 232, 0.92)' : 'rgba(32, 94, 166, 0.9)');
  const hoverAnnotationFill = hoverClusterRgb ? rgbaFromRgbArray(hoverClusterRgb, 0.98) : getClusterColorCSS(0, isDarkMode);
  const selectedAnnotationFill = isDarkMode ? 'rgba(171, 207, 226, 0.96)' : 'rgba(32, 94, 166, 0.94)';
  const annotationStroke = isDarkMode ? 'rgba(242, 240, 229, 0.95)' : 'rgba(16, 15, 15, 0.92)';

  const hoverConnectionStats = useMemo(() => {
    if (hoveredIndex === null || hoveredIndex === undefined) return null;
    const directStats = nodeStats?.get(hoveredIndex);
    if (directStats) return directStats;

    if (!Array.isArray(linksEdges) || linksEdges.length === 0) return null;
    const target = Number(hoveredIndex);
    if (!Number.isInteger(target)) return null;

    let replyOutCount = 0;
    let replyInCount = 0;
    let replyChildCount = 0;
    let quoteOutCount = 0;
    let quoteInCount = 0;
    let hasAny = false;

    for (const edge of linksEdges) {
      const src = Number(edge?.src_ls_index);
      const dst = Number(edge?.dst_ls_index);
      if (!Number.isInteger(src) || !Number.isInteger(dst)) continue;
      const type = String(edge?.edge_kind || '').toLowerCase();

      if (type === 'reply') {
        if (src === target) {
          replyOutCount += 1;
          hasAny = true;
        }
        if (dst === target) {
          replyInCount += 1;
          replyChildCount += 1;
          hasAny = true;
        }
      } else if (type === 'quote') {
        if (src === target) {
          quoteOutCount += 1;
          hasAny = true;
        }
        if (dst === target) {
          quoteInCount += 1;
          hasAny = true;
        }
      }
    }

    if (!hasAny) return null;
    return {
      threadDepth: replyOutCount > 0 ? 1 : 0,
      threadSize: 1 + replyChildCount,
      replyChildCount,
      replyInCount,
      replyOutCount,
      quoteInCount,
      quoteOutCount,
      threadRootId: null,
      tweetId: null,
    };
  }, [hoveredIndex, nodeStats, linksEdges]);

  // console.log({
  //   shownIndices,
  //   selectedPoints: selectedPoints.map((p) => {
  //     return {
  //       index: p.index,
  //       ls_index: p.ls_index,
  //     };
  //   }),
  // });

  return (
    // <div style={{ width, height }} ref={umapRef}>
    <div ref={umapRef} style={{ width: '100%', height: '100%' }}>
      <div className={styles.configToggleContainer}>
        <Button
          className={styles['configToggle']}
          onClick={() => setIsPanelOpen(!isPanelOpen)}
          aria-label="Toggle configuration panel"
          icon={'settings'}
          size="small"
          // color="#333"
        />

        <ConfigurationPanel
          isOpen={isPanelOpen}
          onClose={() => setIsPanelOpen(false)}
          title="View Settings"
          vizConfig={vizConfig}
          toggleShowHeatMap={toggleShowHeatMap}
          toggleShowClusterOutlines={toggleShowClusterOutlines}
          updatePointSize={updatePointSize}
          updatePointOpacity={updatePointOpacity}
          linksAvailable={linksAvailable}
          linksMeta={linksMeta}
          linksLoading={linksLoading}
          toggleShowReplyEdges={toggleShowReplyEdges}
          toggleShowQuoteEdges={toggleShowQuoteEdges}
          updateEdgeWidthScale={updateEdgeWidthScale}
          timelineHasDates={timelineHasDates}
          toggleShowTimeline={toggleShowTimeline}
        />
      </div>

      <div className={styles.scatters + ' ' + (isFullScreen ? styles.fullScreen : '')}>
        {scope && (
          <Scatter
            ref={scatterRef}
            points={drawingPoints}
            width={width}
            height={height}
            contentPaddingRight={contentPaddingRight}
            pointScale={vizConfig.pointSize}
            pointOpacity={vizConfig.pointOpacity}
            onView={handleView}
            onSelect={onSelect}
            onHover={onHover}
            onLabelClick={onLabelClick}
            showClusterOutlines={vizConfig.showClusterOutlines}
            activeClusterId={clusterFilter.cluster?.cluster ?? null}
            featureIsSelected={featureIsSelected}
            linkEdges={linksEdges}
            showReplyEdges={linksAvailable && vizConfig.showReplyEdges}
            showQuoteEdges={linksAvailable && vizConfig.showQuoteEdges}
            edgeWidthScale={vizConfig.edgeWidthScale}
            highlightIndices={threadHighlightIndices}
            maxZoom={maxZoom}
          />
        )}
        {hoveredCluster && hoveredHulls && scope.cluster_labels_lookup && (
          <HullPlot
            hulls={hoveredHulls}
            fill={hoverHullFill}
            stroke={hoverHullStroke}
            strokeWidth={2.5}
            // if there are selected indices already, that means other points will be less visible
            // so we can make the hull a bit more transparent
            opacity={0.2}
            duration={0}
            xDomain={xDomain}
            yDomain={yDomain}
            width={width}
            height={height}
            label={scope.cluster_labels_lookup[hoveredCluster.cluster]}
            k={transform.k}
            maxZoom={maxZoom}
          />
        )}
        {/* Cluster is selected via filter */}
        {showHull &&
          clusterFilter.cluster &&
          clusterFilter.cluster.hull &&
          !scope.ignore_hulls &&
          scope.cluster_labels_lookup && (
            <HullPlot
              hulls={clusterHulls}
              fill={selectedHullFill}
              stroke={selectedHullStroke}
              strokeWidth={3}
              opacity={0.25}
              duration={0}
              xDomain={xDomain}
              yDomain={yDomain}
              width={width}
              height={height}
              label={scope.cluster_labels_lookup[clusterFilter.cluster.cluster]}
            />
          )}
        <AnnotationPlot
          points={hoverAnnotations}
          stroke={annotationStroke}
          fill={hoverAnnotationFill}
          size="16"
          xDomain={xDomain}
          yDomain={yDomain}
          width={width}
          height={height}
        />
        <AnnotationPlot
          points={selectedAnnotations}
          stroke={annotationStroke}
          fill={selectedAnnotationFill}
          size="16"
          xDomain={xDomain}
          yDomain={yDomain}
          width={width}
          height={height}
        />
        {vizConfig.showHeatMap && tiles?.length > 1 && (
          <TilePlot
            tiles={tiles}
            tileMeta={tileMeta}
            xDomain={xDomain}
            yDomain={yDomain}
            width={width}
            height={height}
            fill="gray"
            // stroke="black"
          />
        )}
        {/* PointLabel removed - numbered dots were conflicting with DeckGL coordinates */}
        {/* <CrossHair xDomain={xDomain} yDomain={yDomain} width={width} height={height} /> */}

        {vizConfig.showTimeline && timelineHasDates && (
          <TimelineControls
            domain={timelineDomain}
            range={timeRange}
            onRangeChange={onTimeRangeChange}
            isPlaying={isPlaying}
            onPlayToggle={onPlayToggle}
            playbackSpeed={playbackSpeed}
            onSpeedChange={onSpeedChange}
            hasDates={timelineHasDates}
            timestamps={timestamps}
            datedCount={timelineDatedCount}
            totalCount={timelineTotalCount}
            paddingRight={contentPaddingRight}
          />
        )}
      </div>

      {/* Hover information display */}
      {hovered && hoverCardData && hoverCardPosition && (() => {
        const allQuotes = hoverCardData.quotedTweets.length > 0 ? hoverCardData.quotedTweets : asyncQuotes;
        const allMedia = hoverCardData.mediaUrls.length > 0 ? hoverCardData.mediaUrls : asyncMedia.map((m) => m.media_url);
        return (
          <div
            className={`${hoverStyles.hoverCard} ${hoverPinned ? hoverStyles.pinned : ''}`}
            style={{
              position: 'absolute',
              left: hoverCardPosition.left,
              top: hoverCardPosition.top,
              width: hoverCardPosition.width,
              zIndex: 350,
            }}
            onMouseEnter={onHoverCardMouseEnter}
            onMouseLeave={onHoverCardMouseLeave}
          >
            {hoverPinned && <span className={hoverStyles.pinnedTag}>Pinned</span>}

            {/* 1. Text — first and largest */}
            <p className={`${hoverStyles.textPreview} ${hoverPinned ? hoverStyles.expanded : ''}`}>
              {hoverCardData.typeLabel && (
                <span className={hoverStyles.typeTag}>{hoverCardData.typeLabel}</span>
              )}
              {hoverCardData.displayText || 'No text preview'}
            </p>

            {/* 2. Attribution line */}
            <div className={hoverStyles.attributionLine}>
              {hoverCardData.username && <span>@{hoverCardData.username}</span>}
              {hoverCardData.dateLabel && <><span className={hoverStyles.dot}>·</span><span>{hoverCardData.dateLabel}</span></>}
              {hoverCardData.likes !== null && (
                <><span className={hoverStyles.dot}>·</span><Heart size={12} className={hoverStyles.metricIcon} /><span>{formatCount(hoverCardData.likes)}</span></>
              )}
              {hoverCardData.retweets !== null && (
                <><span className={hoverStyles.dot}>·</span><Repeat2 size={12} className={hoverStyles.metricIcon} /><span>{formatCount(hoverCardData.retweets)}</span></>
              )}
            </div>

            {/* 3. Cluster hint */}
            {hoveredCluster && (
              <div className={hoverStyles.clusterHint}>
                <span
                  className={hoverStyles.clusterDotSmall}
                  style={{ backgroundColor: getClusterColorCSS(hoveredCluster.cluster, isDarkMode) }}
                />
                <span>{hoveredCluster.label}</span>
              </div>
            )}

            {/* 3b. Connection badges */}
            {hoverConnectionStats && (
              <div className={hoverStyles.connectionBadges}>
                <ConnectionBadges
                  stats={hoverConnectionStats}
                  compact
                  onViewThread={
                    hoverPinned && onViewThread && hoveredIndex !== null && hoveredIndex !== undefined
                      ? () => onViewThread(hoveredIndex)
                      : undefined
                  }
                  onViewQuotes={
                    hoverPinned && onViewQuotes && hoveredIndex !== null && hoveredIndex !== undefined
                      ? () => onViewQuotes(hoveredIndex)
                      : undefined
                  }
                />
              </div>
            )}

            {/* 4. Media thumbnails */}
            {allMedia.length > 0 && (
              <div className={hoverStyles.mediaRow}>
                {allMedia.slice(0, 4).map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                    <img src={url} alt="" className={hoverStyles.mediaThumb} loading="lazy" />
                  </a>
                ))}
              </div>
            )}

            {/* 5. Quoted tweets */}
            {allQuotes.length > 0 && (
              <div className={hoverStyles.quotesRow}>
                {allQuotes.slice(0, 2).map((qt) => (
                  <div key={qt.tweetId} onClick={(e) => e.stopPropagation()}>
                    <TwitterEmbed
                      tweetId={qt.tweetId}
                      tweetUrl={qt.tweetUrl}
                      theme={isDarkMode ? 'dark' : 'light'}
                      hideConversation={true}
                      compact={true}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* 6. External URL hints */}
            {hoverCardData.externalUrls.length > 0 && (
              <div className={hoverStyles.urlHints}>
                {hoverCardData.externalUrls.slice(0, 3).map((u, i) => (
                  <a
                    key={i}
                    href={u.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={hoverStyles.urlHint}
                    onClick={(e) => e.stopPropagation()}
                  >
                    ↗ {u.display}
                  </a>
                ))}
              </div>
            )}

            {/* 7. Actions — only when pinned */}
            {hoverPinned && (
              <div className={hoverStyles.actionRow}>
                {hoverCardData.tweetUrl && (
                  <button
                    className={hoverStyles.actionButton}
                    onClick={() => window.open(hoverCardData.tweetUrl, '_blank', 'noopener,noreferrer')}
                  >
                    Open
                  </button>
                )}
                <button
                  className={hoverStyles.actionButton}
                  onClick={handleCopyText}
                  disabled={!hoverCardData.rawText}
                >
                  Copy
                </button>
                <button
                  className={hoverStyles.actionButton}
                  onClick={() => onFilterToCluster && onFilterToCluster(hoveredCluster)}
                  disabled={!hoveredCluster}
                >
                  Filter Cluster
                </button>
                <button
                  className={hoverStyles.actionButton}
                  onClick={() => onUnpinHover && onUnpinHover()}
                >
                  Unpin
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {/* {!isMobileDevice() && (
              <div className="hovered-point">
                  {hoveredCluster && (
                      <span>
                          <span className="key">Cluster {hoveredCluster.cluster}:</span>
                          <span className="value">{hoveredCluster.label}</span>
                      </span>
                  )}
                  {hovered &&
                      Object.keys(hovered).map((key, idx) => {
                          let d = hovered[key];
                if (typeof d === "object" && !Array.isArray(d)) {
                    d = JSON.stringify(d);
                }
                let meta =
                    dataset.column_metadata && dataset.column_metadata[key];
                let value;
                if (meta && meta.image) {
                  value = (
                      <span className="value" key={idx}>
                          <img src={d} alt={key} height={64} />
                      </span>
                  );
              } else if (meta && meta.url) {
                  value = (
                      <span className="value" key={idx}>
                          <a href={d}>url</a>
                      </span>
                  );
              } else if (meta && meta.type == "array") {
                  value = (
                      <span className="value" key={idx}>
                          [{d.length}]
                      </span>
                  );
              } else {
                    value = (
                        <span className="value" key={idx}>
                            {d}
                        </span>
                    );
                }
                return (
                    <span key={key}>
                        <span className="key">{key}:</span>
                        {value}
                    </span>
                );
            })}
              </div>
          )} */}
    </div>
  );
});

export default VisualizationPane;
