/**
 * Search routes — replaces latentscope/server/search.py nn() + nn_lance()
 *
 * GET /api/search/nn?dataset=...&query=...&embedding_id=...&scope_id=...&dimensions=...
 *
 * Returns: { indices: number[], distances: number[], search_embedding: number[][] }
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { embedQuery } from "../lib/voyageai.js";
import { vectorSearch } from "../lib/lancedb.js";
import { getScopeMeta } from "./data.js";

/**
 * Derive embedding model from scope metadata.
 *
 * Priority: scope JSON embedding.model_id → VOYAGE_MODEL env → voyage-4-lite.
 * model_id format in scope JSON: "voyageai-voyage-4-lite" → strip provider prefix.
 */
function getModelConfig(scopeMeta?: Record<string, unknown>) {
  let model = process.env.VOYAGE_MODEL ?? "voyage-4-lite";
  if (scopeMeta?.embedding) {
    const emb = scopeMeta.embedding as Record<string, unknown>;
    const modelId = emb.model_id as string | undefined;
    if (modelId) {
      model = modelId.replace(/^voyageai-/, "");
    }
  }
  return {
    model,
    apiKey: process.env.VOYAGE_API_KEY ?? "",
  };
}

const nnQuerySchema = z.object({
  dataset: z.string(),
  query: z.string(),
  embedding_id: z.string(),
  scope_id: z.string().optional(),
  dimensions: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : undefined)),
});

export const searchRoutes = new Hono()
  .get("/nn", zValidator("query", nnQuerySchema), async (c) => {
    const { query, dataset, scope_id, dimensions } = c.req.valid("query");

    if (!scope_id) {
      return c.json({ error: "scope_id is required for LanceDB Cloud search" }, 400);
    }

    // Fetch scope metadata once — drives both model resolution and table lookup
    const scopeMeta = await getScopeMeta(dataset, scope_id);
    const tableId = (scopeMeta.lancedb_table_id as string) || scope_id;
    const { model, apiKey } = getModelConfig(scopeMeta);

    if (!apiKey) {
      return c.json({ error: "VOYAGE_API_KEY not configured" }, 500);
    }

    // 1. Embed the query via VoyageAI REST
    const embedding = await embedQuery(query, {
      apiKey,
      model,
      dimensions,
    });
    const results = await vectorSearch(tableId, embedding, {
      limit: 100,
      where: "deleted = false",
    });

    const indices = results.map((r) => r.index);
    const distances = results.map((r) => r._distance);

    // Match the response shape the frontend expects (apiService.js:176-184)
    return c.json({
      indices,
      distances,
      search_embedding: [embedding],
    });
  });
