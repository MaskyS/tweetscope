import { Hono } from "hono";
import { getDatasetTable, getTableColumns, resolveDatasetTableId } from "../lib/lancedb.js";
import {
  DATA_DIR,
  PUBLIC_SCOPE,
  getScopeMeta,
  jsonSafe,
  listJsonObjects,
  normalizeIndex,
  resolveLanceTableId,
  scopeContract,
  validateRequiredColumns,
  type JsonRecord,
} from "./dataShared.js";

export const viewsRoutes = new Hono();

const contractRequired = Object.keys(scopeContract.required_columns);
const contractOptional = Object.keys(scopeContract.optional_columns ?? {});
const contractSelected = [...new Set([...contractRequired, ...contractOptional])];

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
  const tableIdOrSuffix = typeof tableId === "string" && tableId ? tableId : view;
  return resolveDatasetTableId(dataset, tableIdOrSuffix);
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

  const rawRows = (await table.query().select(queryCols).toArray()) as JsonRecord[];
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

viewsRoutes.get("/datasets/:dataset/views/:view/meta", async (c) => {
  const { dataset, view } = c.req.param();
  try {
    const meta = await getScopeMeta(dataset, view);
    return c.json(meta);
  } catch (err) {
    console.error(err);
    return c.json({ error: "View not found" }, 404);
  }
});

viewsRoutes.get("/datasets/:dataset/views/:view/cluster-tree", async (c) => {
  const { dataset, view } = c.req.param();
  try {
    const meta = await getScopeMeta(dataset, view);
    return c.json({
      hierarchical_labels: meta.hierarchical_labels ?? false,
      unknown_count: meta.unknown_count ?? 0,
      cluster_labels_lookup: meta.cluster_labels_lookup ?? [],
    });
  } catch (err) {
    console.error(err);
    return c.json({ error: "View cluster tree not found" }, 404);
  }
});

viewsRoutes.get("/datasets/:dataset/views/:view/points", async (c) => {
  const { dataset, view } = c.req.param();
  try {
    const tableId = await resolveViewTableId(dataset, view);
    const table = await getDatasetTable(dataset, tableId);
    const tableCols = await getTableColumns(tableId);

    const selected = ["id", "ls_index", "x", "y", "cluster", "label", "deleted"];
    const queryCols = selected.filter((col) => tableCols.includes(col));

    const rawRows = (await table.query().select(queryCols).toArray()) as JsonRecord[];

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
});

viewsRoutes.get("/datasets/:dataset/views/:view/rows", async (c) => {
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
});

viewsRoutes.get("/datasets/:dataset/scopes/:scope/parquet", async (c) => {
  const { dataset, scope } = c.req.param();
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
});

viewsRoutes.get("/datasets/:dataset/embeddings", async (c) => {
  const dataset = c.req.param("dataset");
  try {
    if (PUBLIC_SCOPE) {
      const scopeMeta = await getScopeMeta(dataset, PUBLIC_SCOPE);
      const embedding = scopeMeta.embedding;
      if (embedding && typeof embedding === "object") return c.json([embedding]);
    }
    if (!DATA_DIR) throw new Error("No local embedding listing available");
    const embeddings = await listJsonObjects(`${dataset}/embeddings`, /.*\.json$/);
    return c.json(embeddings);
  } catch {
    return c.json([]);
  }
});

viewsRoutes.get("/datasets/:dataset/clusters", async (c) => {
  const dataset = c.req.param("dataset");
  try {
    if (PUBLIC_SCOPE) {
      const scopeMeta = await getScopeMeta(dataset, PUBLIC_SCOPE);
      const cluster = scopeMeta.cluster;
      if (cluster && typeof cluster === "object") return c.json([cluster]);
    }
    if (!DATA_DIR) throw new Error("No local cluster listing available");
    const clusters = await listJsonObjects(`${dataset}/clusters`, /^cluster-\d+\.json$/);
    return c.json(clusters);
  } catch {
    return c.json([]);
  }
});

viewsRoutes.get("/datasets/:dataset/clusters/:cluster/labels_available", async (c) => {
  const { dataset, cluster } = c.req.param();
  try {
    if (PUBLIC_SCOPE) {
      const scopeMeta = await getScopeMeta(dataset, PUBLIC_SCOPE);
      const labels = scopeMeta.cluster_labels;
      if (labels && typeof labels === "object") return c.json([labels]);
    }
    if (!DATA_DIR) throw new Error("No local labels listing available");
    const escapedCluster = cluster.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const labels = await listJsonObjects(
      `${dataset}/clusters`,
      new RegExp(`^${escapedCluster}-labels-.*\\.json$`)
    );
    return c.json(labels);
  } catch {
    return c.json([]);
  }
});

viewsRoutes.get("/datasets/:dataset/clusters/:cluster/labels/:labelId", async (c) => {
  return c.json({ error: "Cluster labels endpoint removed (no parquet serving)" }, 410);
});
