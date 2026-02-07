import { useRef, useCallback, useState, useMemo, forwardRef, useImperativeHandle } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, TextLayer, PolygonLayer } from '@deck.gl/layers';
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

function toNumber(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const num = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(num) ? num : 0;
}

function clamp(num, min, max) {
  return Math.min(max, Math.max(min, num));
}

function truncateWithEllipsis(text, maxChars) {
  const value = String(text || '').trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return '…';

  const slice = value.slice(0, maxChars - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cutoff = lastSpace >= Math.floor(maxChars * 0.6) ? lastSpace : slice.length;
  return `${slice.slice(0, cutoff)}…`;
}

function boxesIntersect(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function wrapTextToWidth(text, sizePx, maxWidthPx, measureTextWidth) {
  const value = String(text || '').trim();
  if (!value) return [];
  if (!Number.isFinite(maxWidthPx) || maxWidthPx <= 0) return [value];

  const words = value.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  const breakWord = (word) => {
    let remaining = word;
    while (remaining.length) {
      // Binary search the longest prefix that fits.
      let lo = 1;
      let hi = remaining.length;
      let best = 1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = remaining.slice(0, mid);
        if (measureTextWidth(candidate, sizePx) <= maxWidthPx) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      lines.push(remaining.slice(0, best));
      remaining = remaining.slice(best);
    }
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current) {
      if (measureTextWidth(candidate, sizePx) <= maxWidthPx) {
        current = candidate;
      } else {
        breakWord(word);
        current = '';
      }
      continue;
    }

    if (measureTextWidth(candidate, sizePx) <= maxWidthPx) {
      current = candidate;
      continue;
    }

    lines.push(current);
    if (measureTextWidth(word, sizePx) <= maxWidthPx) {
      current = word;
    } else {
      breakWord(word);
      current = '';
    }
  }

  if (current) lines.push(current);
  return lines;
}

function truncateTextToWidth(text, sizePx, maxWidthPx, measureTextWidth, { forceEllipsis = false } = {}) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (!Number.isFinite(maxWidthPx) || maxWidthPx <= 0) return value;

  const fits = (s) => measureTextWidth(s, sizePx) <= maxWidthPx;
  const withEllipsis = (s) => (s.endsWith('…') ? s : `${s}…`);

  if (fits(value)) {
    if (!forceEllipsis) return value;
    const v = withEllipsis(value);
    if (fits(v)) return v;
  }

  const chars = Array.from(value.replace(/…+$/u, ''));
  if (!chars.length) return '…';

  // Binary search the longest prefix that fits with an ellipsis.
  let lo = 0;
  let hi = chars.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = `${chars.slice(0, mid).join('')}${mid < chars.length || forceEllipsis ? '…' : ''}`;
    if (fits(candidate)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const prefix = chars.slice(0, best).join('').trimEnd();
  const result = withEllipsis(prefix);
  return result === '…' && !fits(result) ? '' : result;
}

function quantileSorted(sortedValues, q) {
  if (!sortedValues.length) return 0;
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedValues[base + 1] !== undefined) {
    return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
  }
  return sortedValues[base];
}

function calculateBaseRadius(pointCount) {
  if (!pointCount) return 1.2;
  const value = 2.3 * Math.pow(5000 / pointCount, 0.25);
  return clamp(value, 0.8, 2.3);
}

function calculateBaseAlpha(pointCount) {
  if (!pointCount) return 120;
  const value = 180 * Math.pow(5000 / pointCount, 0.2);
  return clamp(Math.round(value), 40, 180);
}

const DeckGLScatter = forwardRef(function DeckGLScatter({
  points,
  width,
  height,
  pointScale = 1,
  pointOpacity = 1,
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
    return clamp(Math.log2(fitSize), minZoom, maxZoom);
  }, [width, height, minZoom, maxZoom]);

  // Initial view state - use initialViewState pattern
  const initialViewState = useMemo(() => ({
    target: [0, 0, 0],
    zoom: initialZoom,
    minZoom: minZoom,
    maxZoom: maxZoom,
  }), [initialZoom, minZoom, maxZoom]);

  // Track current view state for label filtering
  const [currentViewState, setCurrentViewState] = useState(initialViewState);
  const textMeasureContext = useMemo(() => {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    return canvas.getContext('2d');
  }, []);
  const textWidthCacheRef = useRef(new Map());

  // Expose zoomToBounds and getViewState methods via ref
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
    },
    getViewState: () => controlledViewState,
  }), [width, height, minZoom, maxZoom, controlledViewState]);

  const pointCount = points.length;

  // Compute normalized "importance" from likes (heavy-tailed, so log-scale + winsorize).
  // We sample when very large to avoid sorting huge arrays.
  const pointRadii = useMemo(() => {
    const baseRadius = calculateBaseRadius(pointCount) * pointScale;
    const minRadius = 0.6;
    const maxRadius = 6;

    const radii = new Float32Array(pointCount);
    if (!scopeRows || scopeRows.length === 0) {
      radii.fill(clamp(baseRadius, minRadius, maxRadius));
      return radii;
    }

    const rawImportance = new Float32Array(pointCount);
    let hasAnyLikes = false;
    for (let i = 0; i < pointCount; i++) {
      const row = scopeRows[i] || {};
      const likes = toNumber(
        row.favorites ?? row.favorite_count ?? row.like_count ?? row.likes ?? row.retweets ?? 0
      );
      if (likes > 0) hasAnyLikes = true;
      rawImportance[i] = Math.log1p(Math.max(0, likes));
    }

    if (!hasAnyLikes) {
      radii.fill(clamp(baseRadius, minRadius, maxRadius));
      return radii;
    }

    const sampleSize = Math.min(pointCount, 50000);
    const step = Math.max(1, Math.ceil(pointCount / sampleSize));
    const sample = [];
    for (let i = 0; i < pointCount; i += step) {
      sample.push(rawImportance[i]);
    }
    sample.sort((a, b) => a - b);

    const pLow = quantileSorted(sample, 0.05);
    const pHigh = quantileSorted(sample, 0.95);
    const denom = pHigh > pLow ? pHigh - pLow : 1;

    for (let i = 0; i < pointCount; i++) {
      const clampedImp = clamp(rawImportance[i], pLow, pHigh);
      const imp01 = pHigh > pLow ? (clampedImp - pLow) / denom : 0;
      const importanceFactor = 0.8 + imp01 * 1.2; // 0.8x .. 2.0x
      radii[i] = clamp(baseRadius * importanceFactor, minRadius, maxRadius);
    }

    return radii;
  }, [scopeRows, pointCount, pointScale]);

  const alphaScale = useMemo(() => {
    const base = calculateBaseAlpha(pointCount) * pointOpacity;
    const baseAlpha = clamp(Math.round(base), 10, 255);
    return {
      baseAlpha,
      selectedAlpha: clamp(baseAlpha + 80, 20, 255),
      dimAlpha: clamp(Math.round(baseAlpha * 0.12), 0, 80),
    };
  }, [pointCount, pointOpacity]);

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
      ls_index: scopeRows?.[index]?.ls_index ?? index,
    }));
  }, [points, scopeRows]);

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

  // Prepare labels sorted by importance (used by deterministic placement/truncation).
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

  const placedLabels = useMemo(() => {
    if (!visibleLabels.length) return [];

    const viewState = controlledViewState || currentViewState || initialViewState;
    const zoom = viewState?.zoom ?? initialZoom;
    const target = viewState?.target ?? [0, 0, 0];
    const [targetX, targetY] = target;
    const scale = Math.pow(2, zoom);
    const zoomSpan = Math.max(1e-6, maxZoom - minZoom);
    const zoom01 = clamp((zoom - minZoom) / zoomSpan, 0, 1);
    const widthCapFraction = clamp(0.55 + zoom01 * 0.35, 0.55, 0.9);
    const widthCapPx = Math.min(1200, width * widthCapFraction);
    const maxLinesAtZoom = clamp(Math.round(3 + zoom01 * 7), 3, 12);

    let maxLayer = 0;
    for (let i = 0; i < visibleLabels.length; i++) {
      const layer = visibleLabels[i]?.layer || 0;
      if (layer > maxLayer) maxLayer = layer;
    }
    const measureCtx = textMeasureContext;
    const widthCache = textWidthCacheRef.current;

    const fontFamily = 'Golos Text, Inter, system-ui, -apple-system, sans-serif';
    const fontWeight = '700';
    const backgroundPadding = [12, 8, 12, 8]; // left, top, right, bottom (px)
    const collisionMargin = 2; // extra spacing between labels (px)
    const widthInflate = 1.12;
    const lineHeight = 1.1;

    const acceptedBoxes = [];
    const placed = [];

    const projectToScreen = (position) => {
      const x = (position[0] - targetX) * scale + width / 2;
      const y = (targetY - position[1]) * scale + height / 2;
      return [x, y];
    };

    const measureTextWidth = (text, sizePx) => {
      const clean = String(text || '');
      const fontSize = Math.max(1, Math.round(sizePx));
      const font = `${fontWeight} ${fontSize}px ${fontFamily}`;
      const key = `${font}|${clean}`;
      const cached = widthCache.get(key);
      if (cached !== undefined) return cached;
      if (!measureCtx) return clean.length * fontSize * 0.6;
      measureCtx.font = font;
      const measured = measureCtx.measureText(clean).width;
      widthCache.set(key, measured);
      return measured;
    };

    const computeLabelSizePx = (d) => {
      const layer = d.layer || 0;
      const count = d.count || 0;
      const layerNorm = maxLayer > 0 ? layer / maxLayer : 1;
      const base = 12 + layerNorm * 6; // 12..18
      const countBonus = Math.log10(Math.max(count, 1)) * 1.2;
      return clamp(base + countBonus, 10, 20);
    };

    const layoutWrappedLabel = (text, sizePx, { maxWidthPx, maxLines }) => {
      const lines = wrapTextToWidth(text, sizePx, maxWidthPx, measureTextWidth);
      if (!lines.length) return null;

      if (Number.isFinite(maxLines) && maxLines > 0 && lines.length > maxLines) {
        const trimmed = lines.slice(0, maxLines);
        trimmed[maxLines - 1] = truncateTextToWidth(
          trimmed[maxLines - 1],
          sizePx,
          maxWidthPx,
          measureTextWidth,
          { forceEllipsis: true }
        );
        // If truncation made the last line empty, drop this layout.
        if (!trimmed[maxLines - 1]) return null;
        return { text: trimmed.join('\n'), lines: trimmed };
      }

      return { text: lines.join('\n'), lines };
    };

    const computeBox = (centerX, centerY, lines, sizePx) => {
      let maxLineWidth = 0;
      for (const line of lines) {
        maxLineWidth = Math.max(maxLineWidth, measureTextWidth(line, sizePx));
      }

      const textWidth = maxLineWidth * widthInflate;
      const textHeight = lines.length * sizePx * lineHeight;

      const x0 = centerX - textWidth / 2 - backgroundPadding[0] - collisionMargin;
      const x1 = centerX + textWidth / 2 + backgroundPadding[2] + collisionMargin;
      const y0 = centerY - textHeight / 2 - backgroundPadding[1] - collisionMargin;
      const y1 = centerY + textHeight / 2 + backgroundPadding[3] + collisionMargin;

      return { x0, y0, x1, y1 };
    };

    const boxIntersectsAny = (box) => {
      for (let i = 0; i < acceptedBoxes.length; i++) {
        if (boxesIntersect(box, acceptedBoxes[i])) return true;
      }
      return false;
    };

    const countIntersections = (box) => {
      let count = 0;
      for (let i = 0; i < acceptedBoxes.length; i++) {
        if (boxesIntersect(box, acceptedBoxes[i])) count++;
      }
      return count;
    };

    const maxToProcess = 1500;
    const maxSoftLabels = 400;
    let softPlaced = 0;
    for (let i = 0; i < visibleLabels.length && i < maxToProcess; i++) {
      const d = visibleLabels[i];
      if (!d?.position) continue;

      const [sx, sy] = projectToScreen(d.position);
      // Skip labels whose anchor is far outside the viewport.
      if (sx < -200 || sx > width + 200 || sy < -200 || sy > height + 200) continue;

      const fullText = String(d.label || '').trim();
      if (!fullText) continue;

      const dx = sx - width / 2;
      const dy = sy - height / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxDist = Math.sqrt((width / 2) * (width / 2) + (height / 2) * (height / 2));
      const dist01 = maxDist > 0 ? clamp(dist / maxDist, 0, 1) : 0;

      // Fade labels as they get further from the current view center (less visually noisy on the periphery).
      const distanceFade = clamp(1 - Math.pow(dist01, 1.5) * 0.75, 0.35, 1);
      const baseTextAlpha = Math.round(230 * distanceFade);
      const baseBgAlpha = Math.round(128 * distanceFade);

      // Slightly shrink labels on the periphery to reduce overlap pressure (still mostly driven by cluster size).
      const distanceSizeScale = 1 - dist01 * 0.12; // down to ~0.88 at edges
      const sizePx = clamp(computeLabelSizePx(d) * distanceSizeScale, 9, 20);
      const baseMaxWidthPx = clamp(sizePx * (12 + zoom01 * 10), 120, Math.min(widthCapPx, width * 0.92));
      const widthPxOptions = [1, 0.9, 0.8, 0.7].map(f => baseMaxWidthPx * f);
      const maxLinesOptions = [];
      const pushMaxLines = (value) => {
        if (!maxLinesOptions.some(v => v === value)) maxLinesOptions.push(value);
      };

      // When we're focused (high zoom or first label), allow the full label with no line limit.
      if (
        acceptedBoxes.length === 0 ||
        (zoom01 >= 0.75 && dist01 <= 0.35)
      ) {
        pushMaxLines(null); // unlimited
      }
      pushMaxLines(maxLinesAtZoom);
      pushMaxLines(Math.max(4, maxLinesAtZoom - 2));
      pushMaxLines(Math.max(3, maxLinesAtZoom - 4));
      pushMaxLines(3);
      pushMaxLines(2);
      pushMaxLines(1);

      const candidates = [];
      for (const maxLines of maxLinesOptions) {
        for (const maxWidthPx of widthPxOptions) {
          const layout = layoutWrappedLabel(fullText, sizePx, { maxWidthPx, maxLines });
          if (!layout) continue;
          const key = layout.text;
          if (!candidates.some(c => c.text === key)) {
            candidates.push({ ...layout, maxLines, maxWidthPx });
          }
        }
      }

      let placedPrimary = false;
      for (const c of candidates) {
        const box = computeBox(sx, sy, c.lines, sizePx);
        if (boxIntersectsAny(box)) continue;

        acceptedBoxes.push(box);
        placed.push({
          ...d,
          label: c.text,
          fullLabel: fullText,
          sizePx,
          alpha: baseTextAlpha,
          backgroundAlpha: baseBgAlpha,
        });
        placedPrimary = true;
        break;
      }

      if (placedPrimary) continue;

      // If we couldn't place without collision, optionally place a "soft" label:
      // very low opacity, does not reserve collision space, and only away from center.
      if (softPlaced < maxSoftLabels && dist01 >= 0.55) {
        // Choose the most compact candidate (prefer 1 line, narrow width).
        const compact = candidates[candidates.length - 1] || null;
        if (compact?.lines?.length) {
          const box = computeBox(sx, sy, compact.lines, sizePx);
          const intersections = countIntersections(box);

          // Only allow mild overlap. This is intentionally conservative.
          if (intersections <= 2) {
            const softAlpha = clamp(
              Math.round((baseTextAlpha * 0.55) / (1 + intersections * 0.35)),
              20,
              baseTextAlpha
            );
            const softBgAlpha = clamp(
              Math.round((baseBgAlpha * 0.25) / (1 + intersections * 0.5)),
              0,
              baseBgAlpha
            );

            placed.push({
              ...d,
              label: compact.text,
              fullLabel: fullText,
              sizePx: clamp(sizePx * 0.92, 8, 18),
              alpha: softAlpha,
              backgroundAlpha: softBgAlpha,
              soft: true,
            });
            softPlaced++;
          }
        }
      }
    }

    return placed;
  }, [
    visibleLabels,
    width,
    height,
    minZoom,
    maxZoom,
    controlledViewState,
    currentViewState,
    initialViewState,
    initialZoom,
    textMeasureContext,
  ]);

  const labelCharacterSet = useMemo(() => {
    const set = new Set();
    // Keep the default ASCII set and add characters from labels + the ellipsis glyph we use.
    for (let i = 32; i < 127; i++) set.add(String.fromCharCode(i));
    set.add('…');
    for (const l of labelData) {
      const text = l?.label || '';
      for (const ch of Array.from(String(text))) {
        if (ch === '\n' || ch === '\r' || ch === '\t') continue;
        set.add(ch);
      }
    }
    return Array.from(set);
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
    setCurrentViewState(newViewState);

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
      setHoveredPointIndex(info.object.index);
      if (onHover) {
        onHover(info.object.ls_index);
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
      onSelect([info.object.ls_index]);
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
        stroked: true,
        filled: true,
        // Use pixel units so point size is stable on screen and not tied to zoom.
        radiusUnits: 'pixels',
        radiusScale: 1,
        radiusMinPixels: 0,
        radiusMaxPixels: 10,
        lineWidthUnits: 'pixels',
        lineWidthScale: 1,
        lineWidthMinPixels: 0,
        lineWidthMaxPixels: 4,
        getPosition: d => d.position,
        getRadius: d => {
          const isHovered = d.index === hoveredPointIndex;
          const r = pointRadii[d.index] || 1.2;
          return isHovered ? clamp(r + 2, 0.6, 10) : r;
        },
        getFillColor: d => {
          const isHovered = d.index === hoveredPointIndex;
          const clusterColor = getClusterColor(d.cluster, 255);

          let alpha = alphaScale.baseAlpha;
          if (d.selectionKey === mapSelectionKey.hidden) {
            alpha = 0;
          } else if (d.selectionKey === mapSelectionKey.notSelected) {
            alpha = alphaScale.dimAlpha;
          } else if (d.selectionKey === mapSelectionKey.selected) {
            alpha = alphaScale.selectedAlpha;
          }

          if (featureIsSelected && d.selectionKey === mapSelectionKey.selected && d.activation > 0) {
            // When feature view is active, let activation boost the alpha.
            alpha = clamp(Math.round(120 + d.activation * 135), alpha, 255);
          }

          if (isHovered) alpha = 255;

          return [clusterColor[0], clusterColor[1], clusterColor[2], alpha];
        },
        getLineColor: d => {
          const isHovered = d.index === hoveredPointIndex;
          if (!isHovered) return [0, 0, 0, 0];
          // Hover halo color
          return [139, 207, 102, 255]; // #8bcf66
        },
        getLineWidth: d => (d.index === hoveredPointIndex ? 2 : 0),
        updateTriggers: {
          getRadius: [hoveredPointIndex, pointRadii],
          getFillColor: [hoveredPointIndex, featureIsSelected, alphaScale],
          getLineColor: [hoveredPointIndex],
          getLineWidth: [hoveredPointIndex],
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

    // 3. Text Layer for cluster labels with deterministic truncation on overlap
    if (placedLabels.length > 0) {
      layerList.push(
        new TextLayer({
          id: 'label-layer',
          data: placedLabels,
          pickable: true,
          getPosition: d => d.position,
          getText: d => d.label,
          characterSet: labelCharacterSet,
          // Use pixels for stable label sizing. We handle overlap in JS and truncate as needed.
          sizeUnits: 'pixels',
          getSize: d => d.sizePx || 14,
          getColor: d => {
            const alpha = Number.isFinite(d?.alpha) ? d.alpha : 230;
            return isDarkMode ? [255, 255, 255, alpha] : [40, 40, 40, alpha];
          },
          getAngle: 0,
          fontFamily: 'Golos Text, Inter, system-ui, -apple-system, sans-serif',
          fontWeight: 'bold',
          // Enable SDF rendering for text outlines
          fontSettings: { sdf: true },
          // Disable auto-wrapping: we insert '\n' ourselves so we can measure and avoid overlaps.
          maxWidth: -1,
          lineHeight: 1.1,
          // Background for better readability (like datamapplot)
          background: true,
          getBackgroundColor: d => {
            const alpha = Number.isFinite(d?.backgroundAlpha) ? d.backgroundAlpha : 128;
            return isDarkMode ? [17, 17, 17, alpha] : [255, 255, 255, alpha];
          },
          backgroundPadding: [12, 8, 12, 8],
          outlineWidth: 2,
          outlineColor: isDarkMode ? [17, 17, 17, 220] : [255, 255, 255, 220],
          sizeMinPixels: 8,
          sizeMaxPixels: 24,
          billboard: true,
          updateTriggers: {
            getColor: [isDarkMode],
            getBackgroundColor: [isDarkMode],
          },
        })
      );
    }

    return layerList;
  }, [
    scatterData,
    hullData,
    placedLabels,
    labelCharacterSet,
    hoveredPointIndex,
    isDarkMode,
    featureIsSelected,
    pointRadii,
    alphaScale,
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
  pointOpacity: PropTypes.number,
  onView: PropTypes.func,
  onSelect: PropTypes.func,
  onHover: PropTypes.func,
  featureIsSelected: PropTypes.bool,
};

export default DeckGLScatter;
