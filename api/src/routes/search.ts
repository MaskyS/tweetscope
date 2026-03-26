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
import { vectorSearch, ftsSearch } from "../lib/lancedb.js";
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

function getScopeTextColumn(scopeMeta?: Record<string, unknown>): string {
  const direct = scopeMeta?.text_column;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const dataset = scopeMeta?.dataset as Record<string, unknown> | undefined;
  const nested = dataset?.text_column;
  if (typeof nested === "string" && nested.trim()) {
    return nested.trim();
  }

  // Backward-compat fallback for legacy exports.
  return "text";
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

    try {
      // Fetch scope metadata once — drives both model resolution and table lookup
      const scopeMeta = await getScopeMeta(dataset, scope_id);
      const tableIdRaw = scopeMeta.lancedb_table_id;
      if (typeof tableIdRaw !== "string" || !tableIdRaw.trim()) {
        return c.json(
          { error: `scope ${scope_id} is missing lancedb_table_id; re-run scope export` },
          500,
        );
      }
      const tableId = tableIdRaw;
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

      const seen = new Set<number>();
      const indices: number[] = [];
      const distances: number[] = [];
      for (const result of results) {
        if (seen.has(result.index)) continue;
        seen.add(result.index);
        indices.push(result.index);
        distances.push(result._distance);
      }

      // Match the response shape the frontend expects (apiService.js:176-184)
      return c.json({
        indices,
        distances,
        search_embedding: [embedding],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[NN] ${dataset}/${scope_id} query="${query}":`, message);
      // Don't leak internal error details to clients
      const safeMessage = message.includes("VOYAGE_API_KEY")
        ? "Search service configuration error"
        : message.includes("not found") || message.includes("missing")
          ? message
          : "Search failed";
      return c.json({ error: safeMessage }, 500);
    }
  })
  .get(
    "/fts",
    zValidator(
      "query",
      z.object({
        dataset: z.string(),
        query: z.string().min(1),
        scope_id: z.string(),
        limit: z
          .string()
          .optional()
          .transform((v) => (v ? parseInt(v, 10) : 100)),
      }),
    ),
    async (c) => {
      const { dataset, query, scope_id, limit } = c.req.valid("query");
      const safeLimit = Number.isInteger(limit) && limit > 0
        ? Math.min(limit, 1000)
        : 100;

      try {
        const scopeMeta = await getScopeMeta(dataset, scope_id);
        const tableIdRaw = scopeMeta.lancedb_table_id;
        if (typeof tableIdRaw !== "string" || !tableIdRaw.trim()) {
          return c.json(
            { error: `scope ${scope_id} is missing lancedb_table_id; re-run scope export` },
            500,
          );
        }

        const textColumn = getScopeTextColumn(scopeMeta);

        const results = await ftsSearch(tableIdRaw, query, {
          column: textColumn,
          limit: safeLimit,
        });

        const seen = new Set<number>();
        const indices: number[] = [];
        const scores: number[] = [];
        for (const result of results) {
          if (seen.has(result.index)) continue;
          seen.add(result.index);
          indices.push(result.index);
          scores.push(result._score);
        }

        return c.json({ indices, scores });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[FTS] ${dataset}/${scope_id} query="${query}":`, message);
        const isNotReady = message.includes("not ready yet");
        const status = isNotReady ? 503 : 500;
        const safeMessage = isNotReady ? message : "Full-text search failed";
        return c.json({ error: safeMessage }, status);
      }
    },
  );
