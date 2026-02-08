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
