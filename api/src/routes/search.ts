/**
 * Search routes — replaces latentscope/server/search.py nn() + nn_lance()
 *
 * GET /api/search/nn?dataset=...&query=...&embedding_id=...&scope_id=...&dimensions=...
 *
 * Returns: { indices: number[], distances: number[], search_embedding: number[][] }
 */

import { Hono } from "hono";
import { z } from "zod";
import { embedQuery } from "../lib/voyageai.js";
import { vectorSearch } from "../lib/lancedb.js";

export const searchRoutes = new Hono();

/**
 * Embedding model config per scope.
 *
 * In the Python server, the model is loaded dynamically from
 * {dataset}/embeddings/{embedding_id}.json at request time.
 *
 * For the TS serving API:
 * - Demo: single scope, model config from env (VOYAGE_MODEL).
 * - Multi-user: store per-scope model metadata in Postgres or
 *   alongside the scope JSON on R2 and fetch/cache on first request.
 *
 * The embedding_id param is accepted for frontend compatibility but
 * currently resolves to the single configured model. When multi-scope
 * is needed, look up model_id + dimensions from scope metadata here.
 */
function getModelConfig(_embeddingId?: string) {
  return {
    model: process.env.VOYAGE_MODEL ?? "voyage-3",
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

searchRoutes.get("/nn", async (c) => {
  const parsed = nnQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { query, scope_id, dimensions, embedding_id } = parsed.data;
  const { model, apiKey } = getModelConfig(embedding_id);

  if (!apiKey) {
    return c.json({ error: "VOYAGE_API_KEY not configured" }, 500);
  }

  // 1. Embed the query via VoyageAI REST
  const embedding = await embedQuery(query, {
    apiKey,
    model,
    dimensions,
  });

  // 2. Search LanceDB Cloud
  if (!scope_id) {
    return c.json({ error: "scope_id is required for LanceDB Cloud search" }, 400);
  }

  const results = await vectorSearch(scope_id, embedding, {
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
