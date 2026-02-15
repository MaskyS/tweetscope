import { useState, useEffect, useRef } from 'react';
import { graphClient } from '../api/graphClient';
import { queryClient } from '../api/queryClient';

/**
 * Fetches a thread (parent chain + descendants) and enriches internal tweets with full row data.
 *
 * Returns:
 * - parentChain: Array of {tweet_id, ls_index, row?, depth} (oldest ancestor first)
 * - currentTweet: {tweet_id, ls_index, row}
 * - descendants: Array of {tweet_id, ls_index, row?, depth}
 * - edges: Array of edge objects
 * - internalIndices: Set of ls_index values for all internal thread members
 * - loading, error, tweetCount
 */
export default function useThreadData(datasetId, scopeId, tweetId, currentLsIndex, enabled = false) {
  const [parentChain, setParentChain] = useState([]);
  const [currentTweet, setCurrentTweet] = useState(null);
  const [descendants, setDescendants] = useState([]);
  const [edges, setEdges] = useState([]);
  const [internalIndices, setInternalIndices] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tweetCount, setTweetCount] = useState(0);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!enabled || !datasetId || !tweetId) {
      setParentChain([]);
      setCurrentTweet(null);
      setDescendants([]);
      setEdges([]);
      setInternalIndices(new Set());
      setTweetCount(0);
      setError(null);
      return;
    }

    const requestId = ++requestIdRef.current;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // 1. Fetch thread structure from backend
        const threadData = await graphClient.fetchThread(datasetId, tweetId);
        if (cancelled || requestId !== requestIdRef.current) return;

        const { parent_chain = [], descendants: rawDescendants = [], edges: rawEdges = [] } = threadData;

        // 2. Collect all internal ls_indices for batch row fetch
        const allInternalIndices = new Set();
        if (currentLsIndex != null) allInternalIndices.add(currentLsIndex);

        for (const node of parent_chain) {
          if (node.ls_index != null) allInternalIndices.add(node.ls_index);
        }
        for (const node of rawDescendants) {
          if (node.ls_index != null) allInternalIndices.add(node.ls_index);
        }

        // 3. Batch fetch full row data for internal tweets
        let rowMap = new Map();
        if (allInternalIndices.size > 0) {
          const indices = Array.from(allInternalIndices);
          const rows = await queryClient.fetchDataFromIndices(datasetId, indices, scopeId);
          if (cancelled || requestId !== requestIdRef.current) return;
          for (const row of rows) {
            rowMap.set(row.index, row);
          }
        }

        // 4. Build enriched parent chain (oldest ancestor first — reverse from API which returns newest first)
        const enrichedParentChain = parent_chain.reverse().map((node, i) => ({
          tweet_id: node.tweet_id,
          ls_index: node.ls_index ?? null,
          row: node.ls_index != null ? rowMap.get(node.ls_index) : null,
          depth: i,
        }));

        // 5. Build enriched current tweet
        const enrichedCurrent = {
          tweet_id: tweetId,
          ls_index: currentLsIndex,
          row: currentLsIndex != null ? rowMap.get(currentLsIndex) : null,
        };

        // 6. Build enriched descendants with depth tracking
        // Descendants come from a BFS, so they're in breadth-first order
        // We can compute depth from edges
        const parentOf = new Map();
        for (const edge of rawEdges) {
          if (edge.edge_kind === 'reply') {
            // src replies to dst → src's parent is dst
            parentOf.set(edge.src_tweet_id, edge.dst_tweet_id);
          }
        }

        // Compute depth relative to current tweet
        const depthMap = new Map();
        depthMap.set(tweetId, 0);
        const computeDepth = (tid) => {
          if (depthMap.has(tid)) return depthMap.get(tid);
          const parent = parentOf.get(tid);
          if (!parent) return 1; // Unknown parent — assume depth 1
          const parentDepth = computeDepth(parent);
          const depth = parentDepth + 1;
          depthMap.set(tid, depth);
          return depth;
        };

        const enrichedDescendants = rawDescendants.map((node) => ({
          tweet_id: node.tweet_id,
          ls_index: node.ls_index ?? null,
          row: node.ls_index != null ? rowMap.get(node.ls_index) : null,
          depth: computeDepth(node.tweet_id),
        }));

        if (cancelled || requestId !== requestIdRef.current) return;

        setParentChain(enrichedParentChain);
        setCurrentTweet(enrichedCurrent);
        setDescendants(enrichedDescendants);
        setEdges(rawEdges);
        setInternalIndices(allInternalIndices);
        setTweetCount(1 + enrichedParentChain.length + enrichedDescendants.length);
        setLoading(false);
      } catch (err) {
        if (cancelled || requestId !== requestIdRef.current) return;
        console.error('Failed to load thread:', err);
        setError(err);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [datasetId, scopeId, tweetId, currentLsIndex, enabled]);

  return { parentChain, currentTweet, descendants, edges, internalIndices, loading, error, tweetCount };
}
