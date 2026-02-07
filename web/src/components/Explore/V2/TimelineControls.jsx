import { useRef, useCallback, useMemo } from 'react';
import { Play, Pause } from 'lucide-react';
import styles from './TimelineControls.module.scss';

const SPEEDS = [1, 2, 4];

function formatDateLabel(ms) {
  const d = new Date(ms);
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(d);
}

function formatDateLabelFull(ms) {
  const d = new Date(ms);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

export default function TimelineControls({
  domain,
  range,
  onRangeChange,
  isPlaying,
  onPlayToggle,
  playbackSpeed,
  onSpeedChange,
  hasDates,
  timestamps = null,
  datedCount = 0,
  totalCount = 0,
  paddingRight = 0,
}) {
  const trackRef = useRef(null);
  const dragRef = useRef(null); // { which: 'start' | 'end' }
  const draggedRef = useRef(false);

  const safeDomain = useMemo(() => {
    const rawStart = Number.isFinite(domain?.[0]) ? domain[0] : 0;
    const rawEnd = Number.isFinite(domain?.[1]) ? domain[1] : rawStart;
    return rawStart <= rawEnd ? [rawStart, rawEnd] : [rawEnd, rawStart];
  }, [domain]);

  const normalizedRange = useMemo(() => {
    if (!range) return null;
    const start = Number.isFinite(range[0]) ? range[0] : safeDomain[0];
    const end = Number.isFinite(range[1]) ? range[1] : safeDomain[1];
    const clampedStart = Math.max(safeDomain[0], Math.min(safeDomain[1], start));
    const clampedEnd = Math.max(safeDomain[0], Math.min(safeDomain[1], end));
    return clampedStart <= clampedEnd ? [clampedStart, clampedEnd] : [clampedEnd, clampedStart];
  }, [range, safeDomain]);

  // Convert time to fraction [0, 1]
  const timeToFrac = useCallback((ms) => {
    const span = safeDomain[1] - safeDomain[0];
    if (span <= 0) return 0;
    return Math.max(0, Math.min(1, (ms - safeDomain[0]) / span));
  }, [safeDomain]);

  // Convert pixel X (relative to track) to time ms
  const pxToTime = useCallback((px) => {
    const track = trackRef.current;
    if (!track) return safeDomain[0];
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return safeDomain[0];
    const frac = Math.max(0, Math.min(1, px / rect.width));
    return safeDomain[0] + frac * (safeDomain[1] - safeDomain[0]);
  }, [safeDomain]);

  const effectiveRange = normalizedRange || safeDomain;
  const startFrac = timeToFrac(effectiveRange[0]);
  const endFrac = timeToFrac(effectiveRange[1]);

  const handlePointerDown = useCallback((e, which) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggedRef.current = false;
    dragRef.current = { which };
  }, []);

  const handlePointerMove = useCallback((e) => {
    if (!dragRef.current || !trackRef.current) return;
    draggedRef.current = true;
    const rect = trackRef.current.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const ms = pxToTime(localX);
    const clamped = Math.max(safeDomain[0], Math.min(safeDomain[1], ms));
    const activeRange = normalizedRange || safeDomain;

    if (dragRef.current.which === 'start') {
      const newStart = Math.min(clamped, activeRange[1]);
      onRangeChange([newStart, activeRange[1]]);
    } else {
      const newEnd = Math.max(clamped, activeRange[0]);
      onRangeChange([activeRange[0], newEnd]);
    }
  }, [safeDomain, normalizedRange, onRangeChange, pxToTime]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
    window.setTimeout(() => {
      draggedRef.current = false;
    }, 0);
  }, []);

  const handleTrackClick = useCallback((e) => {
    if (dragRef.current || draggedRef.current || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const ms = pxToTime(localX);
    const activeRange = normalizedRange || safeDomain;

    // Move whichever handle is closer
    if (!normalizedRange) {
      onRangeChange([safeDomain[0], ms]);
      return;
    }
    const distToStart = Math.abs(ms - activeRange[0]);
    const distToEnd = Math.abs(ms - activeRange[1]);
    if (distToStart < distToEnd) {
      onRangeChange([Math.min(ms, activeRange[1]), activeRange[1]]);
    } else {
      onRangeChange([activeRange[0], Math.max(ms, activeRange[0])]);
    }
  }, [normalizedRange, safeDomain, onRangeChange, pxToTime]);

  const cycleSpeed = useCallback(() => {
    const idx = SPEEDS.indexOf(playbackSpeed);
    onSpeedChange(SPEEDS[(idx + 1) % SPEEDS.length]);
  }, [playbackSpeed, onSpeedChange]);

  const startLabel = normalizedRange ? formatDateLabelFull(normalizedRange[0]) : formatDateLabel(safeDomain[0]);
  const endLabel = normalizedRange ? formatDateLabelFull(normalizedRange[1]) : formatDateLabel(safeDomain[1]);

  // Count tweets within the current range
  const rangeCount = useMemo(() => {
    if (!normalizedRange || !timestamps || !timestamps.length) return null;
    let count = 0;
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      if (Number.isNaN(ts)) continue;
      if (ts >= normalizedRange[0] && ts <= normalizedRange[1]) count++;
    }
    return count;
  }, [normalizedRange, timestamps]);

  const summaryText = useMemo(() => {
    if (!hasDates) return '';
    if (rangeCount !== null) {
      return `${rangeCount.toLocaleString()} of ${datedCount.toLocaleString()} in range`;
    }
    const undated = totalCount - datedCount;
    if (undated > 0) {
      return `${datedCount.toLocaleString()} dated · ${undated.toLocaleString()} undated`;
    }
    return `${datedCount.toLocaleString()} tweets`;
  }, [hasDates, datedCount, totalCount, rangeCount]);

  if (!hasDates) return null;

  return (
    <div
      className={styles.timelineControls}
      style={paddingRight > 0 ? { right: paddingRight + 16 } : undefined}
    >
      {/* Play/Pause */}
      <button
        className={styles.playButton}
        onClick={onPlayToggle}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <Pause size={14} /> : <Play size={14} />}
      </button>

      {/* Track area */}
      <div className={styles.trackContainer}>
        <div className={styles.dateLabels}>
          <span className={styles.dateLabel}>{startLabel}</span>
          <span className={styles.dateSummary}>{summaryText}</span>
          <span className={styles.dateLabel}>{endLabel}</span>
        </div>
        <div
          ref={trackRef}
          className={styles.track}
          onClick={handleTrackClick}
        >
          {/* Filled region between handles */}
          <div
            className={styles.trackFill}
            style={{
              left: `${startFrac * 100}%`,
              width: `${(endFrac - startFrac) * 100}%`,
            }}
          />

          {/* Start handle */}
          <div
            className={styles.handle}
            style={{ left: `${startFrac * 100}%` }}
            onPointerDown={(e) => handlePointerDown(e, 'start')}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onLostPointerCapture={handlePointerUp}
          />

          {/* End handle */}
          <div
            className={styles.handle}
            style={{ left: `${endFrac * 100}%` }}
            onPointerDown={(e) => handlePointerDown(e, 'end')}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onLostPointerCapture={handlePointerUp}
          />
        </div>
      </div>

      {/* Speed control */}
      <button
        className={styles.speedButton}
        onClick={cycleSpeed}
        title={`Playback speed: ${playbackSpeed}x`}
      >
        {playbackSpeed}x
      </button>
    </div>
  );
}
