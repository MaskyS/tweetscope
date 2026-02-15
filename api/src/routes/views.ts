import { Hono } from "hono";
import {
  DATA_DIR,
  PUBLIC_SCOPE,
  getScopeMeta,
  isApiDataUrl,
  listJsonObjects,
  loadParquetRows,
  normalizeIndex,
  passthrough,
  proxyDataApi,
  scopeContract,
  validateRequiredColumns,
} from "./dataShared.js";

export const viewsRoutes = new Hono();

viewsRoutes.get("/datasets/:dataset/scopes/:scope/parquet", async (c) => {
  const { dataset, scope } = c.req.param();

  // Derive columns from contract. Don't request "index" — it's not a SERVING_COLUMN
  // and isn't in -input.parquet (ls_index is the canonical index column).
  const contractRequired = Object.keys(scopeContract.required_columns);
  const optionalColumns = Object.keys(scopeContract.optional_columns ?? {});
  const selected = [...new Set([...contractRequired, ...optionalColumns])];

  try {
    const rows = await loadParquetRows(`${dataset}/scopes/${scope}-input.parquet`, selected);

    const normalized = rows.map((row, idx) => {
      const lsIndex = normalizeIndex(row.ls_index) ?? idx;
      return { ...row, ls_index: lsIndex };
    });

    // Schema drift check: ensure all required columns are present
    const violation = validateRequiredColumns(normalized, dataset, scope);
    if (violation) {
      console.error(
        `Schema contract violation for ${dataset}/${scope}: missing [${violation.missing_columns.join(", ")}]`,
      );
      return c.json(violation, 500);
    }

    return c.json(normalized);
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/scopes/${scope}/parquet`);
      return passthrough(res);
    }
    return c.json({ error: "Scope parquet not found" }, 404);
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
    // Fallback below.
  }

  if (isApiDataUrl()) {
    const res = await proxyDataApi("GET", `/datasets/${dataset}/embeddings`);
    return passthrough(res);
  }

  return c.json([]);
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
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/clusters`);
      return passthrough(res);
    }
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
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/clusters/${cluster}/labels_available`);
      return passthrough(res);
    }
    return c.json([]);
  }
});

viewsRoutes.get("/datasets/:dataset/clusters/:cluster/labels/:labelId", async (c) => {
  const { dataset, cluster, labelId } = c.req.param();
  try {
    const rows = await loadParquetRows(
      `${dataset}/clusters/${cluster}-labels-${labelId}.parquet`
    );
    const withIndex = rows.map((row, index) => ({ index, ...row }));
    return c.json(withIndex);
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi(
        "GET",
        `/datasets/${dataset}/clusters/${cluster}/labels/${labelId}`
      );
      return passthrough(res);
    }
    return c.json({ error: "Cluster labels not found" }, 404);
  }
});
