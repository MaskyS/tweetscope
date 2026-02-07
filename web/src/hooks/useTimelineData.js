import { useMemo } from 'react';

const DATE_COLUMNS = ['created_at', 'date', 'timestamp', 'time', 'posted_at', 'published_at'];

function normalizeUnixEpoch(value) {
  if (!Number.isFinite(value)) return NaN;
  // Heuristic: values below ~year 5138 in ms are likely seconds.
  return Math.abs(value) < 1e11 ? value * 1000 : value;
}

function parseTimestamp(raw) {
  if (raw === undefined || raw === null || raw === '') return NaN;

  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }

  if (typeof raw === 'number') {
    return normalizeUnixEpoch(raw);
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return NaN;

    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return normalizeUnixEpoch(Number(trimmed));
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Parses dates from scopeRows into a Float64Array for O(1) per-point lookup
 * during Deck.GL render. Returns domain [min, max] in epoch-ms.
 */
export default function useTimelineData(scopeRows) {
  return useMemo(() => {
    if (!scopeRows || scopeRows.length === 0) {
      return {
        timestamps: new Float64Array(0),
        timestampsByLsIndex: new Map(),
        domain: [0, 0],
        datedCount: 0,
        hasDates: false,
      };
    }

    const len = scopeRows.length;
    const timestamps = new Float64Array(len);
    const timestampsByLsIndex = new Map();
    let min = Infinity;
    let max = -Infinity;
    let datedCount = 0;

    for (let i = 0; i < len; i++) {
      const row = scopeRows[i];
      let raw = null;
      for (const key of DATE_COLUMNS) {
        const value = row[key];
        if (value !== undefined && value !== null && value !== '') {
          raw = value;
          break;
        }
      }

      const ms = parseTimestamp(raw);
      timestamps[i] = ms;

      if (Number.isFinite(ms)) {
        if (ms < min) min = ms;
        if (ms > max) max = ms;
        datedCount++;
      }

      const lsIndex = row.ls_index ?? i;
      timestampsByLsIndex.set(lsIndex, ms);
    }

    const hasDates = datedCount > 0 && Number.isFinite(min) && Number.isFinite(max);
    return {
      timestamps,            // Float64Array indexed by scopeRows array position (for drawingPoints)
      timestampsByLsIndex,   // Map<ls_index, ms> (for FilterContext)
      domain: hasDates ? [min, max] : [0, 0],
      datedCount,
      hasDates,
    };
  }, [scopeRows]);
}
