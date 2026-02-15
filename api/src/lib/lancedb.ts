/**
 * LanceDB Cloud client.
 * https://docs.lancedb.com/cloud/get-started
 */

import * as lancedb from "@lancedb/lancedb";

let db: lancedb.Connection | null = null;
const tables = new Map<string, lancedb.Table>();
const tableColumns = new Map<string, string[]>();
const tableIndexColumn = new Map<string, string>();

export async function getDb(): Promise<lancedb.Connection> {
  if (db) return db;

  const uri = process.env.LANCEDB_URI;
  if (!uri) {
    throw new Error("LANCEDB_URI must be set");
  }

  const apiKey = process.env.LANCEDB_API_KEY;
  db = apiKey ? await lancedb.connect({ uri, apiKey }) : await lancedb.connect(uri);
  return db;
}

export async function getTable(tableId: string): Promise<lancedb.Table> {
  const cached = tables.get(tableId);
  if (cached) return cached;

  const conn = await getDb();
  const table = await conn.openTable(tableId);
  tables.set(tableId, table);
  return table;
}

export interface SearchResult {
  index: number;
  _distance: number;
}

export async function getTableColumns(tableId: string): Promise<string[]> {
  const cached = tableColumns.get(tableId);
  if (cached) return cached;

  const table = await getTable(tableId);
  const schema = (await table.schema()) as { fields?: Array<{ name?: string }> };
  const cols = (schema.fields ?? [])
    .map((field) => String(field.name ?? ""))
    .filter((name) => name.length > 0);

  tableColumns.set(tableId, cols);
  return cols;
}

export async function getIndexColumn(tableId: string): Promise<string> {
  const cached = tableIndexColumn.get(tableId);
  if (cached) return cached;

  const columns = await getTableColumns(tableId);
  const candidates = ["index", "ls_index", "id"];
  const resolved = candidates.find((name) => columns.includes(name)) ?? "index";
  tableIndexColumn.set(tableId, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Local LanceDB access (for graph tables written by build_links_graph.py)
// ---------------------------------------------------------------------------

const localDbs = new Map<string, lancedb.Connection>();

/**
 * Open the local LanceDB for a dataset. Graph tables ({dataset}__edges,
 * {dataset}__node_stats) live in {DATA_DIR}/{dataset}/lancedb/.
 */
export async function getLocalDb(datasetDir: string): Promise<lancedb.Connection> {
  const cached = localDbs.get(datasetDir);
  if (cached) return cached;
  const conn = await lancedb.connect(datasetDir);
  localDbs.set(datasetDir, conn);
  return conn;
}

/**
 * Open a graph-related table. Tries local DB first (if DATA_DIR is set),
 * then falls back to the cloud connection.
 */
export async function getGraphTable(
  dataset: string,
  tableSuffix: string,
): Promise<lancedb.Table> {
  return getDatasetTable(dataset, tableSuffix);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveDatasetTableId(dataset: string, tableIdOrSuffix: string): string {
  if (tableIdOrSuffix.includes("__")) return tableIdOrSuffix;
  if (UUID_RE.test(tableIdOrSuffix)) {
    return `${dataset}__${tableIdOrSuffix}`;
  }
  // Treat simple identifiers like "edges" / "node_stats" as dataset-scoped suffixes.
  // Legacy table ids like "scopes-001" include "-" and are used as-is.
  if (/^[a-z][a-z0-9_]*$/i.test(tableIdOrSuffix)) {
    return `${dataset}__${tableIdOrSuffix}`;
  }
  // Treat as a legacy full table id (e.g. "scopes-001") and open as-is.
  return tableIdOrSuffix;
}

/**
 * Open a dataset-scoped table local-first (if LATENT_SCOPE_DATA is set),
 * else fall back to the cloud connection.
 *
 * Accepts either:
 * - suffix form: "edges" → "{dataset}__edges"
 * - full table id: "{dataset}__{uuid}" → used as-is
 * - legacy table id: "scopes-001" → used as-is
 */
export async function getDatasetTable(
  dataset: string,
  tableIdOrSuffix: string,
): Promise<lancedb.Table> {
  const tableId = resolveDatasetTableId(dataset, tableIdOrSuffix);

  const cached = tables.get(tableId);
  if (cached) return cached;

  const dataDir = process.env.LATENT_SCOPE_DATA;
  let localError: unknown = null;
  if (dataDir) {
    const expandedDir = dataDir.startsWith("~/")
      ? `${process.env.HOME ?? ""}/${dataDir.slice(2)}`
      : dataDir;
    const localDbPath = `${expandedDir}/${dataset}/lancedb`;
    try {
      const localConn = await getLocalDb(localDbPath);
      const table = await localConn.openTable(tableId);
      tables.set(tableId, table);
      return table;
    } catch (err) {
      // Table doesn't exist locally, try cloud (if configured).
      localError = err;
    }
  }

  // Fallback: cloud connection
  if (!process.env.LANCEDB_URI) {
    throw localError ?? new Error("LANCEDB_URI must be set");
  }
  if (localError) {
    console.warn(`Local LanceDB open failed for ${dataset}/${tableId}; falling back to cloud`, localError);
  }
  const conn = await getDb();
  const table = await conn.openTable(tableId);
  tables.set(tableId, table);
  return table;
}

export async function vectorSearch(
  tableId: string,
  embedding: number[],
  opts: { limit?: number; where?: string } = {}
): Promise<SearchResult[]> {
  const table = await getTable(tableId);
  // table.search() with a vector returns VectorQuery | Query union.
  // Casting to VectorQuery to access distanceType().
  let query = (table.search(embedding) as lancedb.VectorQuery)
    .distanceType("cosine")
    .select(["index"])
    .limit(opts.limit ?? 100);

  if (opts.where) {
    query = query.where(opts.where) as lancedb.VectorQuery;
  }

  const results = await query.toArray();
  return results.map((r: Record<string, unknown>) => ({
    index: r.index as number,
    _distance: r._distance as number,
  }));
}
