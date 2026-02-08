import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Quote } from 'lucide-react';
import { apiService } from '../../../../lib/apiService';
import ThreadNode from './ThreadNode';
import styles from './ThreadView.module.scss';

/**
 * QuoteView panel — shows incoming/outgoing quotes for a tweet.
 * Reuses ThreadView styling and ThreadNode for rendering.
 */
export default function QuoteView({
  datasetId,
  scopeId,
  tweetId,
  nodeStats,
  clusterMap,
  dataset,
  onBack,
  onViewThread,
  onViewQuotes,
}) {
  const [incoming, setIncoming] = useState([]);
  const [outgoing, setOutgoing] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!datasetId || !tweetId) {
      setIncoming([]);
      setOutgoing([]);
      return;
    }

    const requestId = ++requestIdRef.current;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const data = await apiService.fetchQuotes(datasetId, tweetId);
        if (cancelled || requestId !== requestIdRef.current) return;

        // Collect internal ls_indices for batch row fetch
        const allIndices = new Set();
        for (const edge of [...(data.incoming || []), ...(data.outgoing || [])]) {
          if (edge.src_ls_index != null) allIndices.add(edge.src_ls_index);
          if (edge.dst_ls_index != null) allIndices.add(edge.dst_ls_index);
        }

        let rowMap = new Map();
        if (allIndices.size > 0) {
          const rows = await apiService.fetchDataFromIndices(
            datasetId,
            Array.from(allIndices),
            null,
            scopeId
          );
          if (cancelled || requestId !== requestIdRef.current) return;
          for (const row of rows) {
            rowMap.set(row.index, row);
          }
        }

        // Build incoming quotes (others quoting this tweet)
        const enrichedIncoming = (data.incoming || []).map((edge) => ({
          tweet_id: edge.src_tweet_id,
          ls_index: edge.src_ls_index,
          row: edge.src_ls_index != null ? rowMap.get(edge.src_ls_index) : null,
        }));

        // Build outgoing quotes (this tweet quotes others)
        const enrichedOutgoing = (data.outgoing || []).map((edge) => ({
          tweet_id: edge.dst_tweet_id,
          ls_index: edge.dst_ls_index,
          row: edge.dst_ls_index != null ? rowMap.get(edge.dst_ls_index) : null,
        }));

        setIncoming(enrichedIncoming);
        setOutgoing(enrichedOutgoing);
        setLoading(false);
      } catch (err) {
        if (cancelled || requestId !== requestIdRef.current) return;
        console.error('Failed to load quotes:', err);
        setError(err);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [datasetId, scopeId, tweetId]);

  const totalCount = incoming.length + outgoing.length;

  return (
    <div className={styles.threadView}>
      {/* Header */}
      <div className={styles.header}>
        <button className={styles.backButton} onClick={onBack} type="button">
          <ArrowLeft size={16} />
          <span>Back to feed</span>
        </button>
        <div className={styles.headerInfo}>
          <Quote size={14} />
          <span>
            {loading ? 'Loading quotes...' : `Quotes (${totalCount})`}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className={styles.scrollContainer}>
        {error && (
          <div className={styles.errorState}>
            Failed to load quotes. <button onClick={onBack}>Go back</button>
          </div>
        )}

        {loading && (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <span>Loading quotes...</span>
          </div>
        )}

        {!loading && !error && (
          <div className={styles.threadContent}>
            {/* Incoming quotes — others quoting this tweet */}
            {incoming.length > 0 && (
              <div className={styles.quoteSection}>
                <h4 className={styles.quoteSectionTitle}>
                  <span className={styles.quoteSectionAccent} />
                  Quoted by {incoming.length} {incoming.length === 1 ? 'tweet' : 'tweets'}
                </h4>
                {incoming.map((node) => (
                  <ThreadNode
                    key={node.tweet_id}
                    node={node}
                    depth={0}
                    dataset={dataset}
                    clusterMap={clusterMap}
                    nodeStats={nodeStats}
                    onViewThread={onViewThread}
                    onViewQuotes={onViewQuotes}
                  />
                ))}
              </div>
            )}

            {/* Outgoing quotes — this tweet quotes others */}
            {outgoing.length > 0 && (
              <div className={styles.quoteSection}>
                <h4 className={styles.quoteSectionTitle}>
                  <span className={styles.quoteSectionAccent} />
                  This tweet quotes {outgoing.length} {outgoing.length === 1 ? 'tweet' : 'tweets'}
                </h4>
                {outgoing.map((node) => (
                  <ThreadNode
                    key={node.tweet_id}
                    node={node}
                    depth={0}
                    dataset={dataset}
                    clusterMap={clusterMap}
                    nodeStats={nodeStats}
                    onViewThread={onViewThread}
                    onViewQuotes={onViewQuotes}
                  />
                ))}
              </div>
            )}

            {/* Empty state */}
            {!loading && incoming.length === 0 && outgoing.length === 0 && (
              <div className={styles.emptyState}>
                No quote relationships found for this tweet.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
