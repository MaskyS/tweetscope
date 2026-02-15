import { useState, useEffect, useRef } from 'react';
import { graphClient } from '../api/graphClient';
import type { NodeStatsEntry, NodeStatsResponse } from '../api/types';

interface UseNodeStatsResult {
  statsMap: Map<number | string, NodeStatsEntry> | null;
  tweetIdMap: Map<number | string, string> | null;
  loading: boolean;
}

/**
 * Loads node_link_stats for a dataset once, returning two Maps:
 * - statsMap: Map<ls_index, { threadDepth, threadSize, replyChildCount, replyInCount, replyOutCount, quoteInCount, quoteOutCount, threadRootId, tweetId }>
 * - tweetIdMap: Map<ls_index, tweetId>
 */
export default function useNodeStats(
  datasetId: string | undefined,
  linksAvailable: boolean
): UseNodeStatsResult {
  const [statsMap, setStatsMap] = useState<Map<number | string, NodeStatsEntry> | null>(null);
  const [tweetIdMap, setTweetIdMap] = useState<Map<number | string, string> | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!datasetId || !linksAvailable) {
      fetchedForRef.current = null;
      setStatsMap(null);
      setTweetIdMap(null);
      return;
    }

    if (fetchedForRef.current === datasetId) return;

    let cancelled = false;
    setLoading(true);

    const normalizeLsIndex = (value: unknown): number | null => {
      const n = Number(value);
      return Number.isInteger(n) ? n : null;
    };

    const setDualKey = <T,>(map: Map<number | string, T>, lsIndex: number, value: T) => {
      map.set(lsIndex, value);
      map.set(String(lsIndex), value);
    };

    (async () => {
      try {
        const data: NodeStatsResponse = await graphClient.fetchNodeStats(datasetId);
        if (cancelled) return;

        const indices = Array.isArray(data?.ls_index) ? data.ls_index : [];
        const newStatsMap = new Map<number | string, NodeStatsEntry>();
        const newTweetIdMap = new Map<number | string, string>();

        for (let i = 0; i < indices.length; i++) {
          const lsIndex = normalizeLsIndex(indices[i]);
          if (lsIndex == null) continue;

          const stats: NodeStatsEntry = {
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
            setDualKey(newTweetIdMap, lsIndex, data.tweet_id[i] as string);
          }
        }

        fetchedForRef.current = datasetId;
        setStatsMap(newStatsMap);
        setTweetIdMap(newTweetIdMap);
      } catch (error) {
        if (cancelled) return;
        console.warn('Failed to load node stats endpoint:', error);
        setStatsMap(null);
        setTweetIdMap(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [datasetId, linksAvailable]);

  return { statsMap, tweetIdMap, loading };
}
