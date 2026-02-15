/**
 * Graph data repository abstraction.
 *
 * LanceGraphRepo queries {dataset}__edges and {dataset}__node_stats LanceDB
 * tables written by build_links_graph.py.
 */

import { getGraphTable } from "./lancedb.js";
import type { EdgeRow, NodeStatsRow, JsonRecord } from "../routes/dataShared.js";
import { normalizeIndex } from "../routes/dataShared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toEdgeRow(row: Record<string, unknown>): EdgeRow {
  const srcIdx = normalizeIndex(row.src_ls_index);
  const dstIdx = normalizeIndex(row.dst_ls_index);
  return {
    edge_id: row.edge_id == null ? null : String(row.edge_id),
    edge_kind: String(row.edge_kind ?? ""),
    src_tweet_id: String(row.src_tweet_id ?? ""),
    dst_tweet_id: String(row.dst_tweet_id ?? ""),
    // LanceDB stores -1 as sentinel for null ls_index
    src_ls_index: srcIdx !== null && srcIdx >= 0 ? srcIdx : null,
    dst_ls_index: dstIdx !== null && dstIdx >= 0 ? dstIdx : null,
    internal_target: Boolean(row.internal_target),
    provenance: row.provenance == null ? null : String(row.provenance),
    source_url: row.source_url == null ? null : String(row.source_url),
  };
}

function toNodeStatsRow(row: Record<string, unknown>): NodeStatsRow {
  return {
    tweet_id: row.tweet_id == null ? null : String(row.tweet_id),
    ls_index: normalizeIndex(row.ls_index),
    thread_root_id: row.thread_root_id == null ? null : String(row.thread_root_id),
    thread_depth: normalizeIndex(row.thread_depth),
    thread_size: normalizeIndex(row.thread_size),
    reply_child_count: normalizeIndex(row.reply_child_count),
    reply_in_count: normalizeIndex(row.reply_in_count),
    reply_out_count: normalizeIndex(row.reply_out_count),
    quote_in_count: normalizeIndex(row.quote_in_count),
    quote_out_count: normalizeIndex(row.quote_out_count),
  };
}

// ---------------------------------------------------------------------------
// LanceGraphRepo
// ---------------------------------------------------------------------------

export class LanceGraphRepo {
  /**
   * Get all edges for a dataset, optionally filtered by kind.
   */
  async getEdges(dataset: string, edgeKinds?: string[]): Promise<EdgeRow[]> {
    const table = await getGraphTable(dataset, "edges");
    let query = table.query();
    if (edgeKinds && edgeKinds.length > 0) {
      const kindList = edgeKinds.map((k) => `'${k.replace(/'/g, "''")}'`).join(", ");
      query = query.where(`edge_kind IN (${kindList})`);
    }
    const rows = await query.toArray();
    return rows.map((r) => toEdgeRow(r as Record<string, unknown>));
  }

  /**
   * Get edges filtered by ls_index set (src or dst matches).
   */
  async getEdgesByIndices(
    dataset: string,
    indices: number[],
    opts?: { edgeKinds?: string[]; includeExternal?: boolean },
  ): Promise<{ edges: EdgeRow[]; total: number }> {
    const allEdges = await this.getEdges(dataset, opts?.edgeKinds);

    const indexSet = new Set(indices);
    let filtered = allEdges.filter(
      (edge) =>
        (edge.src_ls_index !== null && indexSet.has(edge.src_ls_index)) ||
        (edge.dst_ls_index !== null && indexSet.has(edge.dst_ls_index)),
    );

    if (!opts?.includeExternal) {
      filtered = filtered.filter((edge) => edge.dst_ls_index !== null);
    }

    return { edges: filtered, total: filtered.length };
  }

  /**
   * Get reply edges forming the thread component around a tweet.
   */
  async getThreadEdges(
    dataset: string,
    tweetId: string,
    opts?: { chainLimit?: number; descLimit?: number },
  ): Promise<{
    parentChain: JsonRecord[];
    descendants: JsonRecord[];
    edges: EdgeRow[];
  }> {
    const chainLimit = opts?.chainLimit ?? 300;
    const descLimit = opts?.descLimit ?? 3000;

    const table = await getGraphTable(dataset, "edges");
    const replyRows = await table.query().where("edge_kind = 'reply'").toArray();
    const replyEdges = replyRows.map((r) => toEdgeRow(r as Record<string, unknown>));

    // Build node_stats ls_index lookup
    const lsByTweet = new Map<string, number | null>();
    try {
      const nodeStats = await this.getNodeStats(dataset);
      for (const row of nodeStats) {
        if (row.tweet_id) lsByTweet.set(row.tweet_id, row.ls_index);
      }
    } catch {
      // No node stats available
    }

    const parentBySrc = new Map<string, string>();
    const childrenByDst = new Map<string, string[]>();
    for (const edge of replyEdges) {
      parentBySrc.set(edge.src_tweet_id, edge.dst_tweet_id);
      const children = childrenByDst.get(edge.dst_tweet_id) ?? [];
      children.push(edge.src_tweet_id);
      childrenByDst.set(edge.dst_tweet_id, children);

      if (!lsByTweet.has(edge.src_tweet_id)) lsByTweet.set(edge.src_tweet_id, edge.src_ls_index);
      if (!lsByTweet.has(edge.dst_tweet_id)) lsByTweet.set(edge.dst_tweet_id, edge.dst_ls_index);
    }

    // Walk parent chain
    const parentChain: JsonRecord[] = [];
    const visitedChain = new Set<string>([tweetId]);
    let current = tweetId;
    while (parentBySrc.has(current) && parentChain.length < chainLimit) {
      const parent = parentBySrc.get(current) as string;
      if (visitedChain.has(parent)) break;
      parentChain.push({ tweet_id: parent, ls_index: lsByTweet.get(parent) ?? null });
      visitedChain.add(parent);
      current = parent;
    }

    // BFS descendants
    const descendants: JsonRecord[] = [];
    const seenDesc = new Set<string>();
    const queue = [...(childrenByDst.get(tweetId) ?? [])];
    while (queue.length > 0 && descendants.length < descLimit) {
      const node = queue.shift() as string;
      if (seenDesc.has(node)) continue;
      seenDesc.add(node);
      descendants.push({ tweet_id: node, ls_index: lsByTweet.get(node) ?? null });
      queue.push(...(childrenByDst.get(node) ?? []));
    }

    // Collect component edges
    const componentNodes = new Set<string>([tweetId]);
    for (const node of parentChain) componentNodes.add(String(node.tweet_id));
    for (const node of descendants) componentNodes.add(String(node.tweet_id));

    const componentEdges = replyEdges
      .filter(
        (edge) => componentNodes.has(edge.src_tweet_id) || componentNodes.has(edge.dst_tweet_id),
      )
      .slice(0, 5000);

    return { parentChain, descendants, edges: componentEdges };
  }

  /**
   * Get quote edges for a specific tweet (incoming and outgoing).
   */
  async getQuoteEdges(
    dataset: string,
    tweetId: string,
    limit?: number,
  ): Promise<{
    outgoing: EdgeRow[];
    incoming: EdgeRow[];
    outgoingTotal: number;
    incomingTotal: number;
  }> {
    const maxLimit = limit ?? 2000;
    const table = await getGraphTable(dataset, "edges");
    const quoteRows = await table.query().where("edge_kind = 'quote'").toArray();
    const quoteEdges = quoteRows.map((r) => toEdgeRow(r as Record<string, unknown>));

    const outgoingAll = quoteEdges.filter((edge) => edge.src_tweet_id === tweetId);
    const incomingAll = quoteEdges.filter((edge) => edge.dst_tweet_id === tweetId);

    return {
      outgoing: outgoingAll.slice(0, maxLimit),
      incoming: incomingAll.slice(0, maxLimit),
      outgoingTotal: outgoingAll.length,
      incomingTotal: incomingAll.length,
    };
  }

  /**
   * Get all node stats for a dataset.
   */
  async getNodeStats(dataset: string): Promise<NodeStatsRow[]> {
    const table = await getGraphTable(dataset, "node_stats");
    const rows = await table.query().toArray();
    return rows.map((r) => toNodeStatsRow(r as Record<string, unknown>));
  }

  /**
   * Get links metadata. Reads from the JSON file since it's lightweight
   * and not stored in LanceDB.
   */
  async getLinksMeta(dataset: string): Promise<JsonRecord> {
    // Links meta stays as JSON — it's a tiny metadata blob, not worth a LanceDB table.
    // Import dynamically to avoid circular dependency.
    const { loadJsonFile } = await import("../routes/dataShared.js");
    return loadJsonFile(`${dataset}/links/meta.json`);
  }
}

/** Singleton instance */
export const lanceGraphRepo = new LanceGraphRepo();
