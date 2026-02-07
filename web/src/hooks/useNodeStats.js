import { useState, useEffect, useRef } from 'react';
import { apiService } from '../lib/apiService';

/**
 * Loads node_link_stats for a dataset once, returning two Maps:
 * - statsMap: Map<ls_index, { threadDepth, threadSize, replyChildCount, replyInCount, replyOutCount, quoteInCount, quoteOutCount, threadRootId, tweetId }>
 * - tweetIdMap: Map<ls_index, tweetId>
 */
export default function useNodeStats(datasetId, linksAvailable) {
  const [statsMap, setStatsMap] = useState(null);
  const [tweetIdMap, setTweetIdMap] = useState(null);
  const [loading, setLoading] = useState(false);
  const fetchedForRef = useRef(null);

  useEffect(() => {
    if (!datasetId || !linksAvailable) {
      setStatsMap(null);
      setTweetIdMap(null);
      return;
    }

    // Don't re-fetch if already loaded for this dataset
    if (fetchedForRef.current === datasetId) return;

    let cancelled = false;
    setLoading(true);
    const normalizeLsIndex = (value) => {
      const n = Number(value);
      return Number.isInteger(n) ? n : null;
    };

    const setDualKey = (map, lsIndex, value) => {
      map.set(lsIndex, value);
      map.set(String(lsIndex), value);
    };

    const loadFromNodeStats = async () => {
      const data = await apiService.fetchNodeStats(datasetId);
      const indices = data.ls_index || [];
      const newStatsMap = new Map();
      const newTweetIdMap = new Map();

      for (let i = 0; i < indices.length; i++) {
        const lsIndex = normalizeLsIndex(indices[i]);
        if (lsIndex == null) continue;

        const stats = {
          threadDepth: data.thread_depth?.[i] ?? 0,
          threadSize: data.thread_size?.[i] ?? 1,
          replyChildCount: data.reply_child_count?.[i] ?? 0,
          replyInCount: data.reply_in_count?.[i] ?? 0,
          replyOutCount: data.reply_out_count?.[i] ?? 0,
          quoteInCount: data.quote_in_count?.[i] ?? 0,
          quoteOutCount: data.quote_out_count?.[i] ?? 0,
          threadRootId: data.thread_root_id?.[i] ?? null,
          tweetId: data.tweet_id?.[i] ?? null,
        };
        setDualKey(newStatsMap, lsIndex, stats);

        if (data.tweet_id?.[i]) {
          setDualKey(newTweetIdMap, lsIndex, data.tweet_id[i]);
        }
      }

      return { newStatsMap, newTweetIdMap };
    };

    const loadFromEdgesFallback = async () => {
      const payload = await apiService.fetchLinksByIndices(datasetId, {
        indices: null,
        edge_types: ['reply', 'quote'],
        include_external: false,
        max_edges: 50000,
      });

      const edges = Array.isArray(payload?.edges) ? payload.edges : [];
      const statsByIndex = new Map();
      const parentByChild = new Map();

      const ensureStats = (lsIndex) => {
        if (!statsByIndex.has(lsIndex)) {
          statsByIndex.set(lsIndex, {
            threadDepth: 0,
            threadSize: 1,
            replyChildCount: 0,
            replyInCount: 0,
            replyOutCount: 0,
            quoteInCount: 0,
            quoteOutCount: 0,
            threadRootId: null,
            tweetId: null,
          });
        }
        return statsByIndex.get(lsIndex);
      };

      for (const edge of edges) {
        const src = normalizeLsIndex(edge?.src_ls_index);
        const dst = normalizeLsIndex(edge?.dst_ls_index);
        if (src == null || dst == null) continue;

        const srcStats = ensureStats(src);
        const dstStats = ensureStats(dst);
        if (!srcStats.tweetId && edge?.src_tweet_id != null) srcStats.tweetId = String(edge.src_tweet_id);
        if (!dstStats.tweetId && edge?.dst_tweet_id != null) dstStats.tweetId = String(edge.dst_tweet_id);

        const edgeType = String(edge?.edge_type || '').toLowerCase();
        if (edgeType === 'reply') {
          srcStats.replyOutCount += 1;
          dstStats.replyInCount += 1;
          dstStats.replyChildCount += 1;

          if (!parentByChild.has(src)) parentByChild.set(src, dst);
        } else if (edgeType === 'quote') {
          srcStats.quoteOutCount += 1;
          dstStats.quoteInCount += 1;
        }
      }

      const rootCache = new Map();
      const depthCache = new Map();
      const getRootAndDepth = (lsIndex, seen = new Set()) => {
        if (rootCache.has(lsIndex) && depthCache.has(lsIndex)) {
          return { root: rootCache.get(lsIndex), depth: depthCache.get(lsIndex) };
        }
        if (seen.has(lsIndex)) {
          rootCache.set(lsIndex, lsIndex);
          depthCache.set(lsIndex, 0);
          return { root: lsIndex, depth: 0 };
        }

        const parent = parentByChild.get(lsIndex);
        if (parent == null) {
          rootCache.set(lsIndex, lsIndex);
          depthCache.set(lsIndex, 0);
          return { root: lsIndex, depth: 0 };
        }

        const nextSeen = new Set(seen);
        nextSeen.add(lsIndex);
        const parentResult = getRootAndDepth(parent, nextSeen);
        const result = { root: parentResult.root, depth: parentResult.depth + 1 };
        rootCache.set(lsIndex, result.root);
        depthCache.set(lsIndex, result.depth);
        return result;
      };

      const rootCounts = new Map();
      for (const lsIndex of statsByIndex.keys()) {
        const { root } = getRootAndDepth(lsIndex);
        rootCounts.set(root, (rootCounts.get(root) || 0) + 1);
      }

      for (const [lsIndex, stats] of statsByIndex.entries()) {
        const { root, depth } = getRootAndDepth(lsIndex);
        const rootStats = statsByIndex.get(root);
        stats.threadDepth = depth;
        stats.threadSize = rootCounts.get(root) || 1;
        stats.threadRootId = rootStats?.tweetId || null;
      }

      const newStatsMap = new Map();
      const newTweetIdMap = new Map();
      for (const [lsIndex, stats] of statsByIndex.entries()) {
        setDualKey(newStatsMap, lsIndex, stats);
        if (stats.tweetId) setDualKey(newTweetIdMap, lsIndex, stats.tweetId);
      }
      return { newStatsMap, newTweetIdMap };
    };

    (async () => {
      try {
        const { newStatsMap, newTweetIdMap } = await loadFromNodeStats();
        if (cancelled) return;
        fetchedForRef.current = datasetId;
        setStatsMap(newStatsMap);
        setTweetIdMap(newTweetIdMap);
        setLoading(false);
      } catch (primaryErr) {
        if (cancelled) return;
        console.warn('Failed to load node stats endpoint; falling back to edge-derived stats:', primaryErr);
        try {
          const { newStatsMap, newTweetIdMap } = await loadFromEdgesFallback();
          if (cancelled) return;
          fetchedForRef.current = datasetId;
          setStatsMap(newStatsMap);
          setTweetIdMap(newTweetIdMap);
          setLoading(false);
        } catch (fallbackErr) {
          if (cancelled) return;
          console.warn('Failed to load edge-derived node stats fallback:', fallbackErr);
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [datasetId, linksAvailable]);

  return { statsMap, tweetIdMap, loading };
}
