import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { lanceGraphRepo } from "../lib/graphRepo.js";
import {
  normalizeIndex,
  type JsonRecord,
} from "./dataShared.js";

// Loose schema — accepts any JSON object so the RPC client knows this route takes a JSON body.
// Actual field validation is done in the handler (existing manual parsing).
const looseJsonSchema = z.record(z.unknown());

export const graphRoutes = new Hono()
  .get("/datasets/:dataset/links/meta", async (c) => {
    const dataset = c.req.param("dataset");
    try {
      const meta = await lanceGraphRepo.getLinksMeta(dataset);
      return c.json(meta);
    } catch {
      return c.json({ error: "Links graph not found for dataset" }, 404);
    }
  })
  .get("/datasets/:dataset/links/node-stats", async (c) => {
    const dataset = c.req.param("dataset");
    try {
      const rows = await lanceGraphRepo.getNodeStats(dataset);
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
      return c.json({ error: "Node link stats not found for dataset" }, 404);
    }
  })
  .post("/datasets/:dataset/links/by-indices", zValidator("json", looseJsonSchema), async (c) => {
    const dataset = c.req.param("dataset");
    const payload = c.req.valid("json") as JsonRecord;
    try {
      const edgeKindsRaw = payload.edge_kinds;
      const edgeKinds = Array.isArray(edgeKindsRaw)
        ? edgeKindsRaw.map((v) => String(v).toLowerCase()).filter(Boolean)
        : ["reply", "quote"];

      const includeExternal = payload.include_external === true;

      const rawIndices = payload.indices;
      const indices = Array.isArray(rawIndices)
        ? rawIndices
            .map((value) => normalizeIndex(value))
            .filter((value): value is number => value !== null)
        : [];

      let filtered;
      if (indices.length > 0) {
        const result = await lanceGraphRepo.getEdgesByIndices(dataset, indices, {
          edgeKinds,
          includeExternal,
        });
        filtered = result.edges;
      } else {
        let edges = await lanceGraphRepo.getEdges(dataset, edgeKinds);
        if (!includeExternal) {
          edges = edges.filter((edge) => edge.dst_ls_index !== null);
        }
        filtered = edges;
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
      return c.json({ error: "Links graph not found for dataset" }, 404);
    }
  })
  .get("/datasets/:dataset/links/thread/:tweetId", async (c) => {
    const { dataset, tweetId } = c.req.param();
    try {
      const chainLimit = Math.max(1, normalizeIndex(c.req.query("chain_limit")) ?? 300);
      const descLimit = Math.max(1, normalizeIndex(c.req.query("desc_limit")) ?? 3000);

      const result = await lanceGraphRepo.getThreadEdges(dataset, tweetId, {
        chainLimit,
        descLimit,
      });

      return c.json({
        tweet_id: tweetId,
        parent_chain: result.parentChain,
        descendants: result.descendants,
        edges: result.edges,
      });
    } catch {
      return c.json({ error: "Links graph not found for dataset" }, 404);
    }
  })
  .get("/datasets/:dataset/links/quotes/:tweetId", async (c) => {
    const { dataset, tweetId } = c.req.param();
    try {
      const limit = Math.max(1, normalizeIndex(c.req.query("limit")) ?? 2000);
      const result = await lanceGraphRepo.getQuoteEdges(dataset, tweetId, limit);

      return c.json({
        tweet_id: tweetId,
        outgoing: result.outgoing,
        incoming: result.incoming,
        outgoing_total: result.outgoingTotal,
        incoming_total: result.incomingTotal,
        truncated:
          result.outgoingTotal > result.outgoing.length ||
          result.incomingTotal > result.incoming.length,
      });
    } catch {
      return c.json({ error: "Links graph not found for dataset" }, 404);
    }
  });
