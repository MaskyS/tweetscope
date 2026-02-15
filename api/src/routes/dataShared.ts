/**
 * Shared data access helpers for read-only Explore serving.
 *
 * Route handlers in catalog/views/graph/query modules import this file to
 * avoid duplicating storage, cache, and contract logic.
 */

import {
  asyncBufferFromUrl,
  parquetReadObjects,
} from "hyparquet";
import { createReadStream, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type JsonRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Scope-input schema contract (shared with Python write side)
// ---------------------------------------------------------------------------
interface ColumnSpec {
  type: string;
  nullable: boolean;
}
interface ScopeInputContract {
  version: string;
  required_columns: Record<string, ColumnSpec>;
  optional_columns?: Record<string, ColumnSpec>;
}

const FALLBACK_CONTRACT: ScopeInputContract = {
  version: "scope-input-v1",
  required_columns: {
    id: { type: "string", nullable: false },
    ls_index: { type: "int", nullable: false },
    x: { type: "float", nullable: false },
    y: { type: "float", nullable: false },
    cluster: { type: "string", nullable: false },
    label: { type: "string", nullable: false },
    deleted: { type: "bool", nullable: false },
    text: { type: "string", nullable: false },
  },
};

export let scopeContract: ScopeInputContract;
try {
  const __filename = fileURLToPath(import.meta.url);
  const contractPath = path.resolve(
    path.dirname(__filename),
    "..", "..", "..", "contracts", "scope_input.schema.json",
  );
  scopeContract = JSON.parse(readFileSync(contractPath, "utf-8"));
} catch {
  scopeContract = FALLBACK_CONTRACT;
}

interface SchemaViolation {
  error: "schema_contract_violation";
  dataset: string;
  scope: string;
  missing_columns: string[];
  expected_contract_version: string;
}

export function validateRequiredColumns(
  rows: JsonRecord[],
  dataset: string,
  scope: string,
): SchemaViolation | null {
  if (rows.length === 0) return null;
  const present = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      present.add(key);
    }
  }
  const missing = Object.keys(scopeContract.required_columns).filter(
    (col) => !present.has(col),
  );
  if (missing.length > 0) {
    return {
      error: "schema_contract_violation",
      dataset,
      scope,
      missing_columns: missing,
      expected_contract_version: scopeContract.version,
    };
  }
  return null;
}

export interface EdgeRow {
  edge_id: string | null;
  edge_kind: string;
  src_tweet_id: string;
  dst_tweet_id: string;
  src_ls_index: number | null;
  dst_ls_index: number | null;
  internal_target: boolean;
  provenance: string | null;
  source_url: string | null;
}

export interface NodeStatsRow {
  tweet_id: string | null;
  ls_index: number | null;
  thread_root_id: string | null;
  thread_depth: number | null;
  thread_size: number | null;
  reply_child_count: number | null;
  reply_in_count: number | null;
  reply_out_count: number | null;
  quote_in_count: number | null;
  quote_out_count: number | null;
}

interface AsyncBuffer {
  byteLength: number;
  slice: (start: number, end?: number) => Promise<ArrayBuffer>;
}

export const RAW_DATA_URL = process.env.DATA_URL?.replace(/\/$/, "");
export const PUBLIC_DATASET =
  process.env.PUBLIC_DATASET ?? process.env.LATENT_SCOPE_PUBLIC_DATASET ?? null;
export const PUBLIC_SCOPE =
  process.env.PUBLIC_SCOPE ?? process.env.LATENT_SCOPE_PUBLIC_SCOPE ?? null;
export const DATA_DIR = process.env.LATENT_SCOPE_DATA
  ? expandHome(process.env.LATENT_SCOPE_DATA)
  : null;

const scopeCache = new Map<string, JsonRecord>();
const linksMetaCache = new Map<string, JsonRecord>();
const linksEdgesCache = new Map<string, EdgeRow[]>();
const nodeStatsCache = new Map<string, NodeStatsRow[]>();

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", p.slice(2));
  }
  return p;
}

export function isApiDataUrl(): boolean {
  return Boolean(RAW_DATA_URL && RAW_DATA_URL.endsWith("/api"));
}

export function buildFileUrl(relativePath: string): string {
  if (!RAW_DATA_URL) {
    throw new Error("DATA_URL is not configured");
  }
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return isApiDataUrl()
    ? `${RAW_DATA_URL}/files/${encodedPath}`
    : `${RAW_DATA_URL}/${encodedPath}`;
}

export async function fileExists(fullPath: string): Promise<boolean> {
  try {
    await stat(fullPath);
    return true;
  } catch {
    return false;
  }
}

export function ensureSafeRelativePath(relativePath: string): string {
  if (relativePath.includes("..")) {
    throw new Error("Invalid path");
  }
  return relativePath.replace(/^\/+/, "");
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "string") {
    if (!value.trim()) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function normalizeIndex(value: unknown): number | null {
  const n = toNumberOrNull(value);
  return n !== null && Number.isInteger(n) ? n : null;
}

export function sqlIdentifier(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return trimmed;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return sqlString(String(value));
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonSafe(item));
  }
  if (value && typeof value === "object") {
    const out: JsonRecord = {};
    for (const [k, v] of Object.entries(value as JsonRecord)) {
      out[k] = jsonSafe(v);
    }
    return out;
  }
  return value;
}

export async function loadJsonFile(relativePath: string): Promise<JsonRecord> {
  const safePath = ensureSafeRelativePath(relativePath);

  if (DATA_DIR) {
    const fullPath = path.join(DATA_DIR, safePath);
    if (await fileExists(fullPath)) {
      const text = await readFile(fullPath, "utf-8");
      return JSON.parse(text) as JsonRecord;
    }
  }

  if (RAW_DATA_URL) {
    const res = await fetch(buildFileUrl(safePath));
    if (!res.ok) {
      throw new Error(`Failed to fetch ${safePath}: ${res.status}`);
    }
    return (await res.json()) as JsonRecord;
  }

  throw new Error("No data source configured (LATENT_SCOPE_DATA or DATA_URL)");
}

export async function loadParquetRows(
  relativePath: string,
  columns?: string[]
): Promise<JsonRecord[]> {
  const safePath = ensureSafeRelativePath(relativePath);
  let file;

  if (DATA_DIR) {
    const fullPath = path.join(DATA_DIR, safePath);
    if (await fileExists(fullPath)) {
      file = await asyncBufferFromLocalFile(fullPath);
    }
  }

  if (!file && RAW_DATA_URL) {
    file = await asyncBufferFromUrl({ url: buildFileUrl(safePath) });
  }

  if (!file) {
    throw new Error(`Unable to locate parquet file: ${safePath}`);
  }

  const rows = (await parquetReadObjects({
    file,
    ...(columns?.length ? { columns } : {}),
  })) as JsonRecord[];

  return rows.map((row) => jsonSafe(row) as JsonRecord);
}

async function asyncBufferFromLocalFile(filename: string): Promise<AsyncBuffer> {
  const { size } = await stat(filename);
  return {
    byteLength: size,
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const readEnd = end === undefined ? undefined : Math.max(start, end - 1);
      const stream = createReadStream(filename, { start, end: readEnd });
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on("error", reject);
        stream.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
        });
      });
    },
  };
}

export async function proxyDataApi(
  method: string,
  endpointPath: string,
  query = "",
  body?: unknown
): Promise<Response> {
  if (!RAW_DATA_URL || !isApiDataUrl()) {
    throw new Error("DATA_URL is not configured as API proxy");
  }

  const url = `${RAW_DATA_URL}${endpointPath}${query ? `?${query}` : ""}`;
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };

  if (body !== undefined && method !== "GET") {
    init.body = JSON.stringify(body);
  }

  return fetch(url, init);
}

export function passthrough(res: Response): Response {
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/json",
    },
  });
}

export function resolveScopeId(payload: JsonRecord): string | null {
  const candidate = payload.scope_id;
  if (typeof candidate === "string" && candidate.trim()) return candidate;
  return PUBLIC_SCOPE;
}

export function resolveDataset(payload: JsonRecord): string | null {
  const candidate = payload.dataset;
  if (typeof candidate === "string" && candidate.trim()) return candidate;
  return PUBLIC_DATASET;
}

export async function resolveLanceTableId(dataset: string, scopeId: string): Promise<string> {
  const meta = await getScopeMeta(dataset, scopeId);
  const tableId = meta.lancedb_table_id;
  return typeof tableId === "string" && tableId ? tableId : scopeId;
}

export async function getScopeMeta(dataset: string, scopeId: string): Promise<JsonRecord> {
  const cacheKey = `${dataset}/${scopeId}`;
  const cached = scopeCache.get(cacheKey);
  if (cached) return cached;

  const scope = await loadJsonFile(`${dataset}/scopes/${scopeId}.json`);
  scopeCache.set(cacheKey, scope);
  return scope;
}

export async function listJsonObjects(
  relativeDirectory: string,
  filenamePattern: RegExp
): Promise<JsonRecord[]> {
  if (!DATA_DIR) return [];
  const absoluteDirectory = path.join(DATA_DIR, ensureSafeRelativePath(relativeDirectory));
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const jsonEntries = entries
    .filter((entry) => entry.isFile() && filenamePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const out: JsonRecord[] = [];
  for (const fileName of jsonEntries) {
    const json = await loadJsonFile(`${relativeDirectory}/${fileName}`);
    out.push(json);
  }
  return out;
}

export async function listDatasetsFromDataDir(): Promise<JsonRecord[]> {
  if (!DATA_DIR) return [];
  let entries;
  try {
    entries = await readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const datasets: JsonRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(DATA_DIR, entry.name, "meta.json");
    if (!(await fileExists(metaPath))) continue;
    try {
      const text = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(text) as JsonRecord;
      meta.id = entry.name;
      datasets.push(meta);
    } catch {
      // Ignore malformed metadata files.
    }
  }

  datasets.sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  return datasets;
}

export function ensureIndexInSelection(columns: string[], indexColumn: string): string[] {
  const out = new Set<string>(columns);
  out.add(indexColumn);
  return Array.from(out);
}

export function attachIndexFields(row: JsonRecord, indexColumn: string): JsonRecord {
  const index = normalizeIndex(row[indexColumn]);
  const out = { ...row };
  if (index !== null) {
    out.index = index;
    if (out.ls_index === undefined) out.ls_index = index;
  }
  return out;
}

export function sortRows(rows: JsonRecord[], sort: JsonRecord | undefined): JsonRecord[] {
  if (!sort) return rows;
  const column = typeof sort.column === "string" ? sort.column : "";
  if (!column) return rows;
  const ascending = sort.ascending !== false;

  return [...rows].sort((a, b) => {
    const av = a[column];
    const bv = b[column];

    if (av == null && bv == null) return 0;
    if (av == null) return ascending ? 1 : -1;
    if (bv == null) return ascending ? -1 : 1;

    const an = toNumberOrNull(av);
    const bn = toNumberOrNull(bv);
    if (an !== null && bn !== null) {
      return ascending ? an - bn : bn - an;
    }

    const as = String(av);
    const bs = String(bv);
    return ascending ? as.localeCompare(bs) : bs.localeCompare(as);
  });
}

export function buildFilterWhere(filters: unknown): string | null {
  if (!Array.isArray(filters) || filters.length === 0) return null;

  const clauses: string[] = [];
  for (const filter of filters) {
    if (!filter || typeof filter !== "object") continue;
    const f = filter as JsonRecord;
    const type = String(f.type ?? "");
    const column = String(f.column ?? "");
    if (!column) continue;

    const col = sqlIdentifier(column);
    switch (type) {
      case "eq":
        clauses.push(`${col} = ${sqlValue(f.value)}`);
        break;
      case "gt":
        clauses.push(`${col} > ${sqlValue(f.value)}`);
        break;
      case "lt":
        clauses.push(`${col} < ${sqlValue(f.value)}`);
        break;
      case "gte":
        clauses.push(`${col} >= ${sqlValue(f.value)}`);
        break;
      case "lte":
        clauses.push(`${col} <= ${sqlValue(f.value)}`);
        break;
      case "in": {
        const values = Array.isArray(f.value) ? f.value : [];
        if (values.length === 0) {
          clauses.push("FALSE");
          break;
        }
        clauses.push(`${col} IN (${values.map((v) => sqlValue(v)).join(", ")})`);
        break;
      }
      case "contains": {
        const value = String(f.value ?? "");
        clauses.push(`${col} LIKE ${sqlString(`%${value}%`)}`);
        break;
      }
      default:
        break;
    }
  }

  if (clauses.length === 0) return null;
  return clauses.join(" AND ");
}

function toEdgeRow(row: JsonRecord): EdgeRow {
  return {
    edge_id: row.edge_id == null ? null : String(row.edge_id),
    edge_kind: String(row.edge_kind ?? ""),
    src_tweet_id: String(row.src_tweet_id ?? ""),
    dst_tweet_id: String(row.dst_tweet_id ?? ""),
    src_ls_index: normalizeIndex(row.src_ls_index),
    dst_ls_index: normalizeIndex(row.dst_ls_index),
    internal_target: Boolean(row.internal_target),
    provenance: row.provenance == null ? null : String(row.provenance),
    source_url: row.source_url == null ? null : String(row.source_url),
  };
}

export async function getEdges(dataset: string): Promise<EdgeRow[]> {
  const cached = linksEdgesCache.get(dataset);
  if (cached) return cached;
  const rows = await loadParquetRows(`${dataset}/links/edges.parquet`);
  const edges = rows.map((row) => toEdgeRow(row));
  linksEdgesCache.set(dataset, edges);
  return edges;
}

function toNodeStatsRow(row: JsonRecord): NodeStatsRow {
  return {
    tweet_id: row.tweet_id == null ? null : String(row.tweet_id),
    ls_index: normalizeIndex(row.ls_index),
    thread_root_id: row.thread_root_id == null ? null : String(row.thread_root_id),
    thread_depth: normalizeIndex(row.thread_depth),
    thread_size: normalizeIndex(row.thread_size),
    reply_child_count: normalizeIndex(row.reply_child_count),
    reply_in_count: normalizeIndex(row.reply_in_count),
    reply_out_count: normalizeIndex(row.reply_out_count),
    quote_in_count: normalizeIndex(row.quote_in_count),
    quote_out_count: normalizeIndex(row.quote_out_count),
  };
}

export async function getNodeStatsRows(dataset: string): Promise<NodeStatsRow[]> {
  const cached = nodeStatsCache.get(dataset);
  if (cached) return cached;
  const rows = await loadParquetRows(`${dataset}/links/node_link_stats.parquet`);
  const normalized = rows.map((row) => toNodeStatsRow(row));
  nodeStatsCache.set(dataset, normalized);
  return normalized;
}

export async function getLinksMeta(dataset: string): Promise<JsonRecord> {
  const cached = linksMetaCache.get(dataset);
  if (cached) return cached;
  const meta = await loadJsonFile(`${dataset}/links/meta.json`);
  linksMetaCache.set(dataset, meta);
  return meta;
}
