import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDatasetTable, getTableColumns, paginatedScan, resolveDatasetTableId } from "../lib/lancedb.js";
import {
  DATA_DIR,
  getScopeMeta,
  jsonSafe,
  listJsonObjects,
  normalizeIndex,
  resolveLanceTableId,
  scopeContract,
  validateRequiredColumns,
  type JsonRecord,
} from "./dataShared.js";
import { getActiveScope } from "../lib/catalogRepo.js";

const contractRequired = Object.keys(scopeContract.required_columns);
const contractOptional = Object.keys(scopeContract.optional_columns ?? {});
const contractSelected = [...new Set([...contractRequired, ...contractOptional])];

const pointsQuerySchema = z.object({
  sample: z.coerce.number().int().min(1).max(10000).optional(),
});

function deterministicSample<T>(arr: T[], k: number): T[] {
  if (arr.length <= k) return arr;
  const step = arr.length / k;
  const result: T[] = [];
  for (let i = 0; i < k; i++) {
    result.push(arr[Math.floor(i * step)]);
  }
  return result;
}

class ContractViolationError extends Error {
  violation: NonNullable<ReturnType<typeof validateRequiredColumns>>;
  constructor(violation: NonNullable<ReturnType<typeof validateRequiredColumns>>) {
    super("Scope contract violation");
    this.violation = violation;
  }
}

async function resolveViewTableId(dataset: string, view: string): Promise<string> {
  const meta = await getScopeMeta(dataset, view);
  const tableId = meta.lancedb_table_id;
  if (typeof tableId !== "string" || !tableId.trim()) {
    throw new Error(`Scope metadata missing lancedb_table_id for ${dataset}/${view}`);
  }
  return resolveDatasetTableId(dataset, tableId);
}

async function queryServingRows({
  dataset,
  viewOrScope,
  tableId,
}: {
  dataset: string;
  viewOrScope: string;
  tableId: string;
}): Promise<JsonRecord[]> {
  const table = await getDatasetTable(dataset, tableId);
  const tableCols = await getTableColumns(tableId);

  // Select only serving columns that exist in the table (exclude vector)
  const queryCols = contractSelected.filter((col) => tableCols.includes(col) && col !== "vector");
  const rawRows = (await paginatedScan(table, queryCols)) as JsonRecord[];
  const normalized = rawRows.map((row, idx) => {
    const safe = jsonSafe(row) as JsonRecord;
    const lsIndex = normalizeIndex(safe.ls_index) ?? idx;
    return { ...safe, ls_index: lsIndex };
  });

  const violation = validateRequiredColumns(normalized, dataset, viewOrScope);
  if (violation) {
    console.error(
      `Schema contract violation for ${dataset}/${viewOrScope}: missing [${violation.missing_columns.join(", ")}]`,
    );
    throw new ContractViolationError(violation);
  }

  return normalized;
}

/**
 * Extract a nested metadata field from the active scope via registry.
 */
async function getActiveScopeField(
  dataset: string,
  field: string,
): Promise<unknown | null> {
  try {
    const active = await getActiveScope(dataset);
    if (!active) return null;
    return (active as Record<string, unknown>)[field] ?? null;
  } catch {
    return null;
  }
}

export const viewsRoutes = new Hono()
  .get("/datasets/:dataset/views/:view/meta", async (c) => {
    const { dataset, view } = c.req.param();
    try {
      const meta = await getScopeMeta(dataset, view);
      return c.json(meta);
    } catch (err) {
      console.error(err);
      return c.json({ error: "View not found" }, 404);
    }
  })
  .get("/datasets/:dataset/views/:view/points",
    zValidator("query", pointsQuerySchema),
    async (c) => {
      const { dataset, view } = c.req.param();
      const sampleSize = c.req.valid("query")?.sample ?? 0;
      try {
        const tableId = await resolveViewTableId(dataset, view);
        const table = await getDatasetTable(dataset, tableId);
        const tableCols = await getTableColumns(tableId);

        const selected = sampleSize > 0
          ? ["x", "y", "cluster", "deleted"]
          : ["id", "ls_index", "x", "y", "cluster", "label", "deleted"];
        const queryCols = selected.filter((col) => tableCols.includes(col));
        let rawRows = (await paginatedScan(table, queryCols)) as JsonRecord[];

        if (sampleSize > 0 && rawRows.length > sampleSize) {
          rawRows = deterministicSample(rawRows, sampleSize);
        }

        const normalized = rawRows.map((row, idx) => {
          const safe = jsonSafe(row) as JsonRecord;
          const lsIndex = normalizeIndex(safe.ls_index) ?? idx;
          return { ...safe, ls_index: lsIndex };
        });

        return c.json(normalized);
      } catch (err) {
        console.error(err);
        return c.json(
          { error: "view_table_not_found", dataset, view },
          404
        );
      }
    })
  .get("/datasets/:dataset/views/:view/rows", async (c) => {
    const { dataset, view } = c.req.param();

    try {
      const tableId = await resolveViewTableId(dataset, view);
      const rows = await queryServingRows({ dataset, viewOrScope: view, tableId });
      return c.json(rows);
    } catch (err) {
      console.error(err);
      if (err instanceof ContractViolationError) {
        return c.json(err.violation, 500);
      }
      return c.json(
        { error: "view_table_not_found", dataset, view },
        404
      );
    }
  })
  .get("/datasets/:dataset/scopes/:scope/parquet", async (c) => {
    const { dataset, scope } = c.req.param();

    // Deprecated — use /views/:view/rows instead
    c.header("Deprecation", "true");
    c.header("Sunset", "2026-06-01");
    c.header("Link", `</api/datasets/${dataset}/views/${scope}/rows>; rel="successor-version"`);

    let tableId: string;
    try {
      tableId = await resolveLanceTableId(dataset, scope);
    } catch (err) {
      console.error(err);
      return c.json({ error: "scope_not_found", dataset, scope }, 404);
    }

    try {
      const rows = await queryServingRows({ dataset, viewOrScope: scope, tableId });
      return c.json(rows);
    } catch (err) {
      console.error(err);
      if (err instanceof ContractViolationError) {
        return c.json(err.violation, 500);
      }
      return c.json(
        {
          error: "scope_table_not_found",
          dataset,
          scope,
          hint: "Run export_lance for this scope to backfill the LanceDB table before serving.",
        },
        404,
      );
    }
  })
  .get("/datasets/:dataset/embeddings", async (c) => {
    const dataset = c.req.param("dataset");
    try {
      const embedding = await getActiveScopeField(dataset, "embedding");
      if (embedding && typeof embedding === "object") {
        return c.json([embedding]);
      }
    } catch {
      // fall through
    }

    // Studio fallback: list from filesystem
    try {
      if (!DATA_DIR) return c.json([]);
      const embeddings = await listJsonObjects(`${dataset}/embeddings`, /.*\.json$/);
      return c.json(embeddings);
    } catch {
      return c.json([]);
    }
  })
  .get("/datasets/:dataset/clusters", async (c) => {
    const dataset = c.req.param("dataset");
    try {
      const cluster = await getActiveScopeField(dataset, "cluster");
      if (cluster && typeof cluster === "object") {
        return c.json([cluster]);
      }
    } catch {
      // fall through
    }

    // Studio fallback: list from filesystem
    try {
      if (!DATA_DIR) return c.json([]);
      const clusters = await listJsonObjects(`${dataset}/clusters`, /^cluster-\d+\.json$/);
      return c.json(clusters);
    } catch {
      return c.json([]);
    }
  })
  .get("/datasets/:dataset/clusters/:cluster/labels_available", async (c) => {
    const { dataset, cluster } = c.req.param();
    try {
      const labels = await getActiveScopeField(dataset, "cluster_labels");
      if (labels && typeof labels === "object") {
        return c.json([labels]);
      }
    } catch {
      // fall through
    }

    // Studio fallback: list from filesystem
    try {
      if (!DATA_DIR) return c.json([]);
      const escapedCluster = cluster.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const labels = await listJsonObjects(
        `${dataset}/clusters`,
        new RegExp(`^${escapedCluster}-labels-.*\\.json$`)
      );
      return c.json(labels);
    } catch {
      return c.json([]);
    }
  })
  .get("/datasets/:dataset/clusters/:cluster/labels/:labelId", async (c) => {
    return c.json({ error: "Cluster labels endpoint removed (no parquet serving)" }, 410);
  });
