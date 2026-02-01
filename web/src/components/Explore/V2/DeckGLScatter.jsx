import { useRef, useCallback, useState, useMemo, forwardRef, useImperativeHandle } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, TextLayer, PolygonLayer } from '@deck.gl/layers';
import { CollisionFilterExtension } from '@deck.gl/extensions';
import { OrthographicView, LinearInterpolator } from '@deck.gl/core';
import { rgb } from 'd3-color';
import PropTypes from 'prop-types';

import {
  mapSelectionColorsLight,
  mapSelectionColorsDark,
  mapSelectionOpacity,
  mapPointSizeRange,
  mapSelectionKey,
} from '@/lib/colors';
import { useColorMode } from '@/hooks/useColorMode';
import { useScope } from '@/contexts/ScopeContext';
import styles from './Scatter.module.css';

// Color palette for clusters (similar to datamapplot)
export const CLUSTER_PALETTE = [
  [102, 194, 165],  // teal
  [252, 141, 98],   // coral
  [141, 160, 203],  // periwinkle
  [231, 138, 195],  // pink
  [166, 216, 84],   // lime
  [255, 217, 47],   // yellow
  [229, 196, 148],  // tan
  [179, 179, 179],  // gray
  [188, 128, 189],  // purple
  [204, 235, 197],  // mint
  [255, 170, 170],  // light red
  [170, 212, 255],  // light blue
  [255, 212, 170],  // peach
  [212, 255, 170],  // light lime
  [212, 170, 255],  // lavender
  [255, 255, 170],  // cream
];

// Convert cluster ID (string or number) to a numeric index for color lookup
const clusterIdToIndex = (clusterId) => {
  if (clusterId === null || clusterId === undefined) return 0;

  // If it's already a number, use it directly
  if (typeof clusterId === 'number') return clusterId;

  // If it's a string like "0_5" (layer_index format), extract the index part
  if (typeof clusterId === 'string') {
    // Handle "unknown" or other special values
    if (clusterId === 'unknown') return CLUSTER_PALETTE.length - 1; // Use gray (index 7)

    // Try to extract number from "layer_index" format (e.g., "0_5" -> 5)
    const match = clusterId.match(/_(\d+)$/);
    if (match) return parseInt(match[1], 10);

    // Try to parse as a plain number string
    const parsed = parseInt(clusterId, 10);
    if (!isNaN(parsed)) return parsed;
  }

  return 0; // Default fallback
};

// Get color for a cluster (supports both integer indices and string IDs like "0_5")
export const getClusterColor = (clusterId, alpha = 180) => {
  const idx = clusterIdToIndex(clusterId);
  const color = CLUSTER_PALETTE[idx % CLUSTER_PALETTE.length];
  return [...color, alpha];
};

// Get CSS-friendly rgb string for cluster color
export const getClusterColorCSS = (clusterId) => {
  const idx = clusterIdToIndex(clusterId);
  const color = CLUSTER_PALETTE[idx % CLUSTER_PALETTE.length];
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
};

// PropTypes defined after component (see end of file)

// Convert selection key to color based on theme
const getPointColor = (selectionKey, isDarkMode, opacity = 1) => {
  const colors = isDarkMode ? mapSelectionColorsDark : mapSelectionColorsLight;
  const colorHex = colors[selectionKey] || colors[0];
  const rgbColor = rgb(colorHex);
  const baseOpacity = mapSelectionOpacity[selectionKey] || 0.75;
  return [rgbColor.r, rgbColor.g, rgbColor.b, Math.round(baseOpacity * opacity * 255)];
};

// Get point radius based on selection state
const getPointRadius = (selectionKey) => {
  return mapPointSizeRange[selectionKey] || mapPointSizeRange[0];
};

// Calculate dynamic point scale based on dataset size
const calculateDynamicPointScale = (pointCount, width, height) => {
  const totalArea = width * height;
  const areaPerPoint = totalArea / pointCount;
  const baseSize = Math.sqrt(areaPerPoint);
  const scalingPower = 0.9;
  const scaledSize = Math.pow(baseSize, scalingPower);
  return Math.min(Math.max(scaledSize * 0.08, 0.3), 3);
};

const DeckGLScatter = forwardRef(function DeckGLScatter({
  points,
  width,
  height,
  pointScale = 1,
  minZoom = -2,
  maxZoom = 8,
  onView,
  onSelect,
  onHover,
  featureIsSelected = false,
}, ref) {
  const { isDark: isDarkMode } = useColorMode();
  const { clusterLabels, scope, scopeRows } = useScope();

  const deckRef = useRef(null);
  const [hoveredPointIndex, setHoveredPointIndex] = useState(null);

  // Controlled view state for programmatic zoom
  const [controlledViewState, setControlledViewState] = useState(null);

  // Calculate the initial zoom level to fit the data range [-1, 1] in the viewport
  // OrthographicView: zoom=0 means 1 unit = 1 pixel
  // We want 2 units to fit in min(width, height) * 0.9 (with some padding)
  const initialZoom = useMemo(() => {
    const fitSize = Math.min(width, height) * 0.45; // 90% of smaller dimension, divided by 2 for half
    // 2^zoom * dataRange = screenSize
    // zoom = log2(screenSize / dataRange)
    // dataRange is 2 (from -1 to 1)
    return Math.log2(fitSize);
  }, [width, height]);

  // Initial view state - use initialViewState pattern
  const initialViewState = useMemo(() => ({
    target: [0, 0, 0],
    zoom: initialZoom,
    minZoom: minZoom,
    maxZoom: maxZoom,
  }), [initialZoom, minZoom, maxZoom]);

  // Track current view state for label filtering
  const [currentZoom, setCurrentZoom] = useState(initialZoom);

  // Expose zoomToBounds method via ref
  useImperativeHandle(ref, () => ({
    zoomToBounds: (bounds, transitionDuration = 500) => {
      const [minX, minY, maxX, maxY] = bounds;
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const rangeX = maxX - minX;
      const rangeY = maxY - minY;
      // Calculate zoom to fit bounds in viewport with padding
      const fitZoom = Math.log2(Math.min(width, height) * 0.8 / Math.max(rangeX, rangeY));

      setControlledViewState({
        target: [centerX, centerY, 0],
        zoom: Math.min(Math.max(fitZoom, minZoom), maxZoom),
        minZoom,
        maxZoom,
        transitionDuration,
        transitionInterpolator: new LinearInterpolator(['target', 'zoom']),
      });
    }
  }), [width, height, minZoom, maxZoom]);

  // Calculate dynamic size based on point count
  const dynamicSize = useMemo(() => {
    return calculateDynamicPointScale(points.length, width, height);
  }, [points.length, width, height]);

  // Prepare point data for ScatterplotLayer
  // Data coordinates are already in [-1, 1] range
  // points format: [x, y, selectionKey, activation, cluster]
  const scatterData = useMemo(() => {
    return points.map((p, index) => ({
      position: [p[0], p[1]],
      selectionKey: p[2],
      activation: p[3] || 0,
      cluster: p[4] !== undefined ? p[4] : 0,
      index,
    }));
  }, [points]);

  // Prepare label data for TextLayer with hierarchical support
  const labelData = useMemo(() => {
    if (!clusterLabels || !scopeRows) return [];

    const isHierarchical = scope?.hierarchical_labels;

    if (isHierarchical) {
      // For hierarchical labels, we have layer info and centroid coordinates
      return clusterLabels.map(label => ({
        cluster: label.cluster,
        label: label.label,
        layer: label.layer || 0,
        count: label.count || 0,
        position: label.centroid_x !== undefined && label.centroid_y !== undefined
          ? [label.centroid_x, label.centroid_y]
          : computeCentroidFromHull(label.hull, scopeRows),
        hull: label.hull,
        parentCluster: label.parent_cluster,
        children: label.children || [],
      }));
    } else {
      // Standard flat labels - compute centroid from hull points
      return clusterLabels.map(label => {
        const centroid = computeCentroidFromHull(label.hull, scopeRows);
        return {
          cluster: label.cluster,
          label: label.label,
          layer: 0,
          count: label.count || 0,
          position: centroid,
          hull: label.hull,
        };
      });
    }
  }, [clusterLabels, scopeRows, scope]);

  // Compute centroid from hull indices
  function computeCentroidFromHull(hull, rows) {
    if (!hull || !hull.length || !rows) return [0, 0];

    let sumX = 0, sumY = 0, count = 0;
    hull.forEach(idx => {
      const row = rows[idx];
      if (row) {
        sumX += row.x;
        sumY += row.y;
        count++;
      }
    });

    return count > 0 ? [sumX / count, sumY / count] : [0, 0];
  }

  // Prepare labels with priority-based visibility (let CollisionFilterExtension handle display)
  const visibleLabels = useMemo(() => {
    if (!labelData.length) return [];

    // Sort by priority: layer weight * count
    // Higher layers (coarser clusters) and higher counts get priority
    // This lets CollisionFilterExtension naturally show important labels first
    return [...labelData]
      .map(l => ({
        ...l,
        priority: (l.count || 1) * Math.pow(2, (l.layer || 0))
      }))
      .sort((a, b) => b.priority - a.priority);
  }, [labelData]);

  // Prepare hull data for PolygonLayer
  const hullData = useMemo(() => {
    if (!clusterLabels || !scopeRows) return [];

    return clusterLabels
      .filter(label => label.hull && label.hull.length >= 3)
      .map(label => {
        const hullCoords = label.hull
          .map(idx => {
            const row = scopeRows[idx];
            return row ? [row.x, row.y] : null;
          })
          .filter(coord => coord !== null);

        // Close the polygon
        if (hullCoords.length >= 3) {
          hullCoords.push(hullCoords[0]);
        }

        return {
          cluster: label.cluster,
          polygon: hullCoords,
          label: label.label,
          layer: label.layer || 0,
        };
      })
      .filter(h => h.polygon.length >= 4);
  }, [clusterLabels, scopeRows]);

  // Handle view state changes
  const handleViewStateChange = useCallback(({ viewState: newViewState }) => {
    setCurrentZoom(newViewState.zoom);

    if (onView) {
      // Convert Deck.GL view state to domain format expected by existing code
      const scale = Math.pow(2, newViewState.zoom);
      const [centerX, centerY] = newViewState.target;

      // Calculate visible domain based on zoom and viewport size
      const halfWidthInUnits = (width / 2) / scale;
      const halfHeightInUnits = (height / 2) / scale;

      const xDomain = [centerX - halfWidthInUnits, centerX + halfWidthInUnits];
      const yDomain = [centerY - halfHeightInUnits, centerY + halfHeightInUnits];

      // Create a transform-like object for compatibility with existing code
      const transform = {
        k: scale / Math.pow(2, initialZoom), // Relative zoom from initial
        x: width / 2 - centerX * scale,
        y: height / 2 + centerY * scale, // Y is flipped
      };

      onView(xDomain, yDomain, transform);
    }
  }, [onView, width, height, initialZoom]);

  // Handle hover events
  const handleHover = useCallback((info) => {
    if (info.object && info.layer?.id === 'scatter-layer') {
      const pointIndex = info.object.index;
      setHoveredPointIndex(pointIndex);
      if (onHover) {
        onHover(pointIndex);
      }
    } else {
      setHoveredPointIndex(null);
      if (onHover) {
        onHover(null);
      }
    }
  }, [onHover]);

  // Handle click/select events
  const handleClick = useCallback((info) => {
    if (info.object && info.layer?.id === 'scatter-layer' && onSelect) {
      onSelect([info.object.index]);
    }
  }, [onSelect]);

  // Create layers
  const layers = useMemo(() => {
    const layerList = [];

    // 1. Scatterplot Layer for points
    layerList.push(
      new ScatterplotLayer({
        id: 'scatter-layer',
        data: scatterData,
        pickable: true,
        opacity: 1,
        stroked: false,
        filled: true,
        // Use 'common' units which scale with zoom properly for non-geo data
        radiusUnits: 'common',
        radiusScale: dynamicSize * pointScale * 0.01, // Scale down since common units are larger
        radiusMinPixels: 1,
        radiusMaxPixels: 20,
        getPosition: d => d.position,
        getRadius: d => {
          const isHovered = d.index === hoveredPointIndex;
          if (isHovered) return getPointRadius(mapSelectionKey.hovered);
          return getPointRadius(d.selectionKey);
        },
        getFillColor: d => {
          const isHovered = d.index === hoveredPointIndex;
          if (isHovered) {
            // Bright highlight for hovered point
            return [139, 207, 102, 255]; // #8bcf66
          }

          // Base color from cluster
          const clusterColor = getClusterColor(d.cluster);

          // Adjust alpha based on selection state
          if (d.selectionKey === mapSelectionKey.hidden) {
            return [clusterColor[0], clusterColor[1], clusterColor[2], 0];
          }

          if (featureIsSelected && d.selectionKey === mapSelectionKey.selected && d.activation > 0) {
            // Brighten based on activation
            const alpha = Math.round(120 + d.activation * 135);
            return [clusterColor[0], clusterColor[1], clusterColor[2], alpha];
          }

          if (d.selectionKey === mapSelectionKey.notSelected) {
            // Dim non-selected points
            return [clusterColor[0], clusterColor[1], clusterColor[2], 60];
          }

          if (d.selectionKey === mapSelectionKey.selected) {
            // Full opacity for selected
            return [clusterColor[0], clusterColor[1], clusterColor[2], 220];
          }

          // Normal state
          return clusterColor;
        },
        updateTriggers: {
          getRadius: [hoveredPointIndex],
          getFillColor: [hoveredPointIndex, isDarkMode, featureIsSelected, scatterData],
        },
      })
    );

    // 2. Polygon Layer for cluster hulls
    if (hullData.length > 0) {
      layerList.push(
        new PolygonLayer({
          id: 'hull-layer',
          data: hullData,
          pickable: false,
          stroked: true,
          filled: false,
          getPolygon: d => d.polygon,
          getLineColor: isDarkMode ? [224, 239, 255, 80] : [212, 178, 151, 120],
          lineWidthMinPixels: 1,
          lineWidthMaxPixels: 3,
        })
      );
    }

    // 3. Text Layer for cluster labels with collision detection
    // Find max layer for scaling calculations
    const maxLayer = visibleLabels.length > 0
      ? Math.max(...visibleLabels.map(l => l.layer || 0), 0)
      : 0;

    if (visibleLabels.length > 0) {
      layerList.push(
        new TextLayer({
          id: 'label-layer',
          data: visibleLabels,
          pickable: true,
          getPosition: d => d.position,
          getText: d => d.label,
          // Use common units so labels scale with zoom
          sizeUnits: 'common',
          getSize: d => {
            // Size in world units - labels scale with zoom
            // Higher layers (parent clusters) = larger, lower layers = smaller
            // This makes child clusters appear as you zoom in
            const layer = d.layer || 0;
            const countBonus = Math.log10(Math.max(d.count, 10)) * 0.014;
            // Exponential scaling: top layer is largest, each lower layer is half the size
            const layerScale = Math.pow(0.6, maxLayer - layer);
            return (0.0455 + countBonus) * layerScale;
          },
          getColor: isDarkMode ? [255, 255, 255, 230] : [40, 40, 40, 230],
          getAngle: 0,
          fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
          fontWeight: 'bold',
          // Text wrapping - maxWidth is in "em" units (multiples of text size)
          wordBreak: 'break-word',
          maxWidth: 10,
          // Background for better readability (like datamapplot)
          background: true,
          getBackgroundColor: isDarkMode ? [17, 17, 17, 128] : [255, 255, 255, 128],
          getBackgroundPadding: [12, 8, 12, 8],
          outlineWidth: 2,
          outlineColor: isDarkMode ? [17, 17, 17, 220] : [255, 255, 255, 220],
          // Min/max pixels control when labels appear/disappear
          sizeMinPixels: 8,   // Labels below this won't render
          sizeMaxPixels: 28,   // Cap max size
          billboard: false,
          // Collision detection extension with improved settings
          extensions: [new CollisionFilterExtension()],
          collisionEnabled: true,
          // Use priority (combines count and layer) for collision priority
          getCollisionPriority: d => d.priority || d.count,
          collisionTestProps: {
            sizeScale: 3,
            sizeMaxPixels: 96,
            sizeMinPixels: 28,
          },
          updateTriggers: {
            getColor: [isDarkMode],
            getBackgroundColor: [isDarkMode],
            getSize: [maxLayer],
          },
        })
      );
    }

    return layerList;
  }, [
    scatterData,
    hullData,
    visibleLabels,
    dynamicSize,
    pointScale,
    hoveredPointIndex,
    isDarkMode,
    featureIsSelected,
  ]);

  // OrthographicView for 2D scatter plot
  // flipY: false means y increases upward (standard Cartesian coordinates)
  const views = useMemo(() => [
    new OrthographicView({
      id: 'main',
      flipY: false,
      controller: true,
    }),
  ], []);

  // Handle view state change - update controlled state and call onView
  const handleViewStateChangeWithControl = useCallback(({ viewState: newViewState }) => {
    // Update controlled view state if we had a programmatic change
    if (controlledViewState) {
      setControlledViewState(null);
    }
    // Call the original handler
    handleViewStateChange({ viewState: newViewState });
  }, [controlledViewState, handleViewStateChange]);

  return (
    <div className={styles.scatter} style={{ width, height, position: 'relative' }}>
      <DeckGL
        ref={deckRef}
        views={views}
        initialViewState={initialViewState}
        viewState={controlledViewState || undefined}
        onViewStateChange={handleViewStateChangeWithControl}
        layers={layers}
        onHover={handleHover}
        onClick={handleClick}
        width={width}
        height={height}
        style={{
          background: isDarkMode ? '#111111' : '#fafafa',
        }}
        getCursor={({ isHovering }) => isHovering ? 'pointer' : 'grab'}
      />
    </div>
  );
});

DeckGLScatter.propTypes = {
  points: PropTypes.array.isRequired, // an array of [x, y, selectionKey, activation, cluster]
  width: PropTypes.number.isRequired,
  height: PropTypes.number.isRequired,
  maxZoom: PropTypes.number,
  pointScale: PropTypes.number,
  onView: PropTypes.func,
  onSelect: PropTypes.func,
  onHover: PropTypes.func,
  featureIsSelected: PropTypes.bool,
};

export default DeckGLScatter;
