import { Hono } from "hono";
import {
  getEdges,
  getLinksMeta,
  getNodeStatsRows,
  isApiDataUrl,
  normalizeIndex,
  passthrough,
  proxyDataApi,
  type JsonRecord,
} from "./dataShared.js";

export const graphRoutes = new Hono();

graphRoutes.get("/datasets/:dataset/links/meta", async (c) => {
  const dataset = c.req.param("dataset");
  try {
    const meta = await getLinksMeta(dataset);
    return c.json(meta);
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/links/meta`);
      return passthrough(res);
    }
    return c.json({ error: "Links graph not found for dataset" }, 404);
  }
});

graphRoutes.get("/datasets/:dataset/links/node-stats", async (c) => {
  const dataset = c.req.param("dataset");
  try {
    const rows = await getNodeStatsRows(dataset);
    const result: JsonRecord = {
      ls_index: [],
      tweet_id: [],
      thread_root_id: [],
      thread_depth: [],
      thread_size: [],
      reply_child_count: [],
      reply_in_count: [],
      reply_out_count: [],
      quote_in_count: [],
      quote_out_count: [],
    };

    for (const row of rows) {
      (result.ls_index as unknown[]).push(row.ls_index);
      (result.tweet_id as unknown[]).push(row.tweet_id);
      (result.thread_root_id as unknown[]).push(row.thread_root_id);
      (result.thread_depth as unknown[]).push(row.thread_depth);
      (result.thread_size as unknown[]).push(row.thread_size);
      (result.reply_child_count as unknown[]).push(row.reply_child_count);
      (result.reply_in_count as unknown[]).push(row.reply_in_count);
      (result.reply_out_count as unknown[]).push(row.reply_out_count);
      (result.quote_in_count as unknown[]).push(row.quote_in_count);
      (result.quote_out_count as unknown[]).push(row.quote_out_count);
    }

    return c.json(result);
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/links/node-stats`);
      return passthrough(res);
    }
    return c.json({ error: "Node link stats not found for dataset" }, 404);
  }
});

graphRoutes.post("/datasets/:dataset/links/by-indices", async (c) => {
  const dataset = c.req.param("dataset");
  const payload = (await c.req.json().catch(() => ({}))) as JsonRecord;
  try {
    const edges = await getEdges(dataset);
    let filtered = edges;

    const edgeKindsRaw = payload.edge_kinds;
    const edgeKinds = Array.isArray(edgeKindsRaw)
      ? edgeKindsRaw.map((v) => String(v).toLowerCase()).filter(Boolean)
      : ["reply", "quote"];
    if (edgeKinds.length > 0) {
      const allowed = new Set(edgeKinds);
      filtered = filtered.filter((edge) => allowed.has(edge.edge_kind.toLowerCase()));
    }

    const includeExternal = payload.include_external === true;
    if (!includeExternal) {
      filtered = filtered.filter((edge) => edge.dst_ls_index !== null);
    }

    const rawIndices = payload.indices;
    if (Array.isArray(rawIndices) && rawIndices.length > 0) {
      const indexSet = new Set(
        rawIndices
          .map((value) => normalizeIndex(value))
          .filter((value): value is number => value !== null)
      );
      filtered = filtered.filter(
        (edge) =>
          (edge.src_ls_index !== null && indexSet.has(edge.src_ls_index)) ||
          (edge.dst_ls_index !== null && indexSet.has(edge.dst_ls_index))
      );
    }

    const maxEdgesRaw = normalizeIndex(payload.max_edges);
    const maxEdges = maxEdgesRaw && maxEdgesRaw > 0 ? maxEdgesRaw : 5000;
    const total = filtered.length;
    const out = filtered.slice(0, maxEdges);

    return c.json({
      edges: out,
      total,
      returned: out.length,
      truncated: total > out.length,
    });
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi(
        "POST",
        `/datasets/${dataset}/links/by-indices`,
        "",
        payload
      );
      return passthrough(res);
    }
    return c.json({ error: "Links graph not found for dataset" }, 404);
  }
});

graphRoutes.get("/datasets/:dataset/links/thread/:tweetId", async (c) => {
  const { dataset, tweetId } = c.req.param();
  try {
    const edges = await getEdges(dataset);
    const replyEdges = edges.filter((edge) => edge.edge_kind === "reply");

    const nodeStats = await getNodeStatsRows(dataset).catch(() => []);
    const lsByTweet = new Map<string, number | null>();
    for (const row of nodeStats) {
      if (row.tweet_id) lsByTweet.set(row.tweet_id, row.ls_index);
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

    const chainLimit = Math.max(
      1,
      normalizeIndex(c.req.query("chain_limit")) ?? 300
    );
    const descLimit = Math.max(
      1,
      normalizeIndex(c.req.query("desc_limit")) ?? 3000
    );

    const parentChain: JsonRecord[] = [];
    const visitedChain = new Set<string>([tweetId]);
    let current = tweetId;

    while (parentBySrc.has(current) && parentChain.length < chainLimit) {
      const parent = parentBySrc.get(current) as string;
      if (visitedChain.has(parent)) break;
      parentChain.push({
        tweet_id: parent,
        ls_index: lsByTweet.get(parent) ?? null,
      });
      visitedChain.add(parent);
      current = parent;
    }

    const descendants: JsonRecord[] = [];
    const seenDesc = new Set<string>();
    const queue = [...(childrenByDst.get(tweetId) ?? [])];
    while (queue.length > 0 && descendants.length < descLimit) {
      const node = queue.shift() as string;
      if (seenDesc.has(node)) continue;
      seenDesc.add(node);
      descendants.push({
        tweet_id: node,
        ls_index: lsByTweet.get(node) ?? null,
      });
      queue.push(...(childrenByDst.get(node) ?? []));
    }

    const componentNodes = new Set<string>([tweetId]);
    for (const node of parentChain) componentNodes.add(String(node.tweet_id));
    for (const node of descendants) componentNodes.add(String(node.tweet_id));

    const componentEdges = replyEdges
      .filter(
        (edge) =>
          componentNodes.has(edge.src_tweet_id) || componentNodes.has(edge.dst_tweet_id)
      )
      .slice(0, 5000);

    return c.json({
      tweet_id: tweetId,
      parent_chain: parentChain,
      descendants,
      edges: componentEdges,
    });
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/links/thread/${tweetId}`);
      return passthrough(res);
    }
    return c.json({ error: "Links graph not found for dataset" }, 404);
  }
});

graphRoutes.get("/datasets/:dataset/links/quotes/:tweetId", async (c) => {
  const { dataset, tweetId } = c.req.param();
  try {
    const edges = await getEdges(dataset);
    const quoteEdges = edges.filter((edge) => edge.edge_kind === "quote");

    const limit = Math.max(1, normalizeIndex(c.req.query("limit")) ?? 2000);
    const outgoingAll = quoteEdges.filter((edge) => edge.src_tweet_id === tweetId);
    const incomingAll = quoteEdges.filter((edge) => edge.dst_tweet_id === tweetId);
    const outgoing = outgoingAll.slice(0, limit);
    const incoming = incomingAll.slice(0, limit);

    return c.json({
      tweet_id: tweetId,
      outgoing,
      incoming,
      outgoing_total: outgoingAll.length,
      incoming_total: incomingAll.length,
      truncated: outgoingAll.length > outgoing.length || incomingAll.length > incoming.length,
    });
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/links/quotes/${tweetId}`);
      return passthrough(res);
    }
    return c.json({ error: "Links graph not found for dataset" }, 404);
  }
});
