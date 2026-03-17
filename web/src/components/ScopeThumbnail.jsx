import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import PropTypes from 'prop-types';

import { viewClient } from '../lib/apiService';
import { queryKeys } from '../query/keys';
import { getClusterToneColor } from '../lib/clusterColors';
import { useColorMode } from '../hooks/useColorMode';

const CANVAS_WIDTH = 440;
const CANVAS_HEIGHT = 280;
const EDGE_PADDING = 10;
const MAX_RENDER_POINTS = 3500;

function isFinitePoint(point) {
  return (
    point &&
    point.deleted !== true &&
    Number.isFinite(Number(point.x)) &&
    Number.isFinite(Number(point.y))
  );
}

function getPreviewRadius(pointCount) {
  if (!pointCount) return 1.25;
  const scaled = 1.9 / Math.sqrt(Math.max(pointCount / 1000, 0.6));
  return Math.max(0.7, Math.min(1.8, scaled));
}

function toCanvasX(x) {
  const usableWidth = CANVAS_WIDTH - EDGE_PADDING * 2;
  return EDGE_PADDING + ((x + 1) / 2) * usableWidth;
}

function toCanvasY(y) {
  const usableHeight = CANVAS_HEIGHT - EDGE_PADDING * 2;
  return EDGE_PADDING + ((1 - y) / 2) * usableHeight;
}

function ScopeThumbnail({ datasetId, scopeId, className, alt, fallbackSrc }) {
  const canvasRef = useRef(null);
  const { isDark } = useColorMode();

  const { data: points = [], status } = useQuery({
    queryKey: queryKeys.scopeThumbnailPoints(datasetId, scopeId),
    queryFn: ({ signal }) =>
      viewClient.fetchScopePoints(datasetId, scopeId, { signal, sample: MAX_RENDER_POINTS })
        .then((rows) => (Array.isArray(rows) ? rows.filter(isFinitePoint) : [])),
    staleTime: 5 * 60 * 1000,
  });

  const loadStatus = status === 'success' ? 'ready' : status === 'error' ? 'error' : 'loading';
  const hasRenderablePoints = points.length > 0;

  const pointStyle = useMemo(() => {
    if (!hasRenderablePoints) return { radius: 1, alpha: 0.7 };
    return {
      radius: getPreviewRadius(points.length),
      alpha: points.length > 2400 ? 0.56 : 0.68,
    };
  }, [hasRenderablePoints, points.length]);

  useEffect(() => {
    if (loadStatus === 'error') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Transparent background — let page bg show through; CSS handles the border
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    if (!hasRenderablePoints) return;

    const colorCache = new Map();
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      const clusterKey = String(point.cluster ?? 'unknown');
      let color = colorCache.get(clusterKey);
      if (!color) {
        const rgb = getClusterToneColor(point.cluster, isDark);
        color = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${pointStyle.alpha})`;
        colorCache.set(clusterKey, color);
      }

      const px = toCanvasX(Number(point.x));
      const py = toCanvasY(Number(point.y));
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, pointStyle.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [hasRenderablePoints, isDark, loadStatus, pointStyle.alpha, pointStyle.radius, points]);

  if (loadStatus === 'error') {
    return (
      <img
        className={className}
        src={fallbackSrc}
        alt={alt}
        loading="lazy"
        decoding="async"
      />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={CANVAS_WIDTH}
      height={CANVAS_HEIGHT}
      role="img"
      aria-label={alt}
    />
  );
}

ScopeThumbnail.propTypes = {
  datasetId: PropTypes.string.isRequired,
  scopeId: PropTypes.string.isRequired,
  className: PropTypes.string,
  alt: PropTypes.string,
  fallbackSrc: PropTypes.string.isRequired,
};

ScopeThumbnail.defaultProps = {
  className: '',
  alt: 'Scope preview',
};

export default ScopeThumbnail;
