/**
 * Data routes for read-only Explore serving.
 *
 * This replaces Flask read endpoints in deployment mode:
 * - dataset/scope metadata
 * - row lookup/query/filter
 * - links graph endpoints
 * - static file serving
 *
 * Write workflows (import/jobs/admin) remain in Python.
 */

import { Hono } from "hono";
import {
  asyncBufferFromUrl,
  parquetReadObjects,
} from "hyparquet";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getIndexColumn, getTable, getTableColumns } from "../lib/lancedb.js";

export const dataRoutes = new Hono();

type JsonRecord = Record<string, unknown>;

interface EdgeRow {
  edge_type: string;
  src_tweet_id: string;
  dst_tweet_id: string;
  src_ls_index: number | null;
  dst_ls_index: number | null;
  internal_target: boolean;
  source_url: string | null;
}

interface NodeStatsRow {
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

const RAW_DATA_URL = process.env.DATA_URL?.replace(/\/$/, "");
const PUBLIC_DATASET =
  process.env.PUBLIC_DATASET ?? process.env.LATENT_SCOPE_PUBLIC_DATASET ?? null;
const PUBLIC_SCOPE =
  process.env.PUBLIC_SCOPE ?? process.env.LATENT_SCOPE_PUBLIC_SCOPE ?? "scopes-001";
const DATA_DIR = process.env.LATENT_SCOPE_DATA
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

function isApiDataUrl(): boolean {
  return Boolean(RAW_DATA_URL && RAW_DATA_URL.endsWith("/api"));
}

function buildFileUrl(relativePath: string): string {
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

async function fileExists(fullPath: string): Promise<boolean> {
  try {
    await stat(fullPath);
    return true;
  } catch {
    return false;
  }
}

function ensureSafeRelativePath(relativePath: string): string {
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

function normalizeIndex(value: unknown): number | null {
  const n = toNumberOrNull(value);
  return n !== null && Number.isInteger(n) ? n : null;
}

function sqlIdentifier(name: string): string {
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

function jsonSafe(value: unknown): unknown {
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

async function loadJsonFile(relativePath: string): Promise<JsonRecord> {
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

async function loadParquetRows(
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

async function proxyDataApi(
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

function passthrough(res: Response): Response {
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/json",
    },
  });
}

function resolveScopeId(payload: JsonRecord): string {
  const candidate = payload.scope_id;
  if (typeof candidate === "string" && candidate.trim()) return candidate;
  return PUBLIC_SCOPE;
}

async function getScopeMeta(dataset: string, scopeId: string): Promise<JsonRecord> {
  const cacheKey = `${dataset}/${scopeId}`;
  const cached = scopeCache.get(cacheKey);
  if (cached) return cached;

  const scope = await loadJsonFile(`${dataset}/scopes/${scopeId}.json`);
  scopeCache.set(cacheKey, scope);
  return scope;
}

function ensureIndexInSelection(columns: string[], indexColumn: string): string[] {
  const out = new Set<string>(columns);
  out.add(indexColumn);
  return Array.from(out);
}

function attachIndexFields(row: JsonRecord, indexColumn: string): JsonRecord {
  const index = normalizeIndex(row[indexColumn]);
  const out = { ...row };
  if (index !== null) {
    out.index = index;
    if (out.ls_index === undefined) out.ls_index = index;
  }
  return out;
}

function sortRows(rows: JsonRecord[], sort: JsonRecord | undefined): JsonRecord[] {
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

function buildFilterWhere(filters: unknown): string | null {
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
    edge_type: String(row.edge_type ?? ""),
    src_tweet_id: String(row.src_tweet_id ?? ""),
    dst_tweet_id: String(row.dst_tweet_id ?? ""),
    src_ls_index: normalizeIndex(row.src_ls_index),
    dst_ls_index: normalizeIndex(row.dst_ls_index),
    internal_target: Boolean(row.internal_target),
    source_url: row.source_url == null ? null : String(row.source_url),
  };
}

async function getEdges(dataset: string): Promise<EdgeRow[]> {
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

async function getNodeStatsRows(dataset: string): Promise<NodeStatsRow[]> {
  const cached = nodeStatsCache.get(dataset);
  if (cached) return cached;
  const rows = await loadParquetRows(`${dataset}/links/node_link_stats.parquet`);
  const normalized = rows.map((row) => toNodeStatsRow(row));
  nodeStatsCache.set(dataset, normalized);
  return normalized;
}

async function getLinksMeta(dataset: string): Promise<JsonRecord> {
  const cached = linksMetaCache.get(dataset);
  if (cached) return cached;
  const meta = await loadJsonFile(`${dataset}/links/meta.json`);
  linksMetaCache.set(dataset, meta);
  return meta;
}

// --- Dataset metadata ---

dataRoutes.get("/datasets/:dataset/meta", async (c) => {
  const dataset = c.req.param("dataset");
  try {
    const meta = await loadJsonFile(`${dataset}/meta.json`);
    return c.json(meta);
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/meta`);
      return passthrough(res);
    }
    return c.json({ error: "Dataset metadata not found" }, 404);
  }
});

dataRoutes.get("/datasets/:dataset/scopes", async (c) => {
  const dataset = c.req.param("dataset");
  try {
    const scope = await getScopeMeta(dataset, PUBLIC_SCOPE);
    return c.json([scope]);
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/scopes`);
      return passthrough(res);
    }
    return c.json({ error: "Scopes not found" }, 404);
  }
});

dataRoutes.get("/datasets/:dataset/scopes/:scope", async (c) => {
  const { dataset, scope } = c.req.param();
  try {
    const scopeMeta = await getScopeMeta(dataset, scope);
    return c.json(scopeMeta);
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/scopes/${scope}`);
      return passthrough(res);
    }
    return c.json({ error: "Scope not found" }, 404);
  }
});

dataRoutes.get("/datasets/:dataset/scopes/:scope/parquet", async (c) => {
  const { dataset, scope } = c.req.param();
  const requiredColumns = [
    "x",
    "y",
    "cluster",
    "label",
    "deleted",
    "ls_index",
    "index",
    "tile_index_64",
    "tile_index_128",
  ];
  const engagementColumns = [
    "favorites",
    "favorite_count",
    "likes",
    "like_count",
    "retweets",
    "retweet_count",
    "replies",
    "reply_count",
    "created_at",
    "tweet_type",
    "is_like",
    "is_retweet",
    "is_reply",
  ];
  const selected = [...requiredColumns, ...engagementColumns];

  try {
    let rows: JsonRecord[] = [];

    try {
      rows = await loadParquetRows(`${dataset}/scopes/${scope}-input.parquet`, selected);
    } catch {
      rows = await loadParquetRows(`${dataset}/scopes/${scope}.parquet`, selected);
    }

    const normalized = rows.map((row, idx) => {
      const lsIndex = normalizeIndex(row.ls_index ?? row.index) ?? idx;
      return { ...row, ls_index: lsIndex };
    });

    return c.json(normalized);
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/scopes/${scope}/parquet`);
      return passthrough(res);
    }
    return c.json({ error: "Scope parquet not found" }, 404);
  }
});

dataRoutes.get("/datasets/:dataset/embeddings", async (c) => {
  const dataset = c.req.param("dataset");
  try {
    const scopeMeta = await getScopeMeta(dataset, PUBLIC_SCOPE);
    const embedding = scopeMeta.embedding as JsonRecord | undefined;
    if (embedding) return c.json([embedding]);
  } catch {
    // Fallback below.
  }

  if (isApiDataUrl()) {
    const res = await proxyDataApi("GET", `/datasets/${dataset}/embeddings`);
    return passthrough(res);
  }

  return c.json([]);
});

// --- Clusters ---

dataRoutes.get("/datasets/:dataset/clusters", async (c) => {
  const dataset = c.req.param("dataset");
  try {
    const scopeMeta = await getScopeMeta(dataset, PUBLIC_SCOPE);
    const cluster = scopeMeta.cluster as JsonRecord | undefined;
    return c.json(cluster ? [cluster] : []);
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/clusters`);
      return passthrough(res);
    }
    return c.json([]);
  }
});

dataRoutes.get("/datasets/:dataset/clusters/:cluster/labels_available", async (c) => {
  const dataset = c.req.param("dataset");
  try {
    const scopeMeta = await getScopeMeta(dataset, PUBLIC_SCOPE);
    const labels = scopeMeta.cluster_labels as JsonRecord | undefined;
    return c.json(labels ? [labels] : []);
  } catch {
    if (isApiDataUrl()) {
      const { dataset: ds, cluster } = c.req.param();
      const res = await proxyDataApi("GET", `/datasets/${ds}/clusters/${cluster}/labels_available`);
      return passthrough(res);
    }
    return c.json([]);
  }
});

dataRoutes.get("/datasets/:dataset/clusters/:cluster/labels/:labelId", async (c) => {
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

// --- Links/graph ---

dataRoutes.get("/datasets/:dataset/links/meta", async (c) => {
  const dataset = c.req.param("dataset");
  try {
    const meta = await getLinksMeta(dataset);
    return c.json(meta);
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/links/meta`);
      return passthrough(res);
    }
    return c.json({ error: "Links graph not found for dataset" }, 404);
  }
});

dataRoutes.get("/datasets/:dataset/links/node-stats", async (c) => {
  const dataset = c.req.param("dataset");
  try {
    const rows = await getNodeStatsRows(dataset);
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
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/links/node-stats`);
      return passthrough(res);
    }
    return c.json({ error: "Node link stats not found for dataset" }, 404);
  }
});

dataRoutes.post("/datasets/:dataset/links/by-indices", async (c) => {
  const dataset = c.req.param("dataset");
  const payload = (await c.req.json().catch(() => ({}))) as JsonRecord;
  try {
    const edges = await getEdges(dataset);
    let filtered = edges;

    const edgeTypesRaw = payload.edge_types;
    const edgeTypes = Array.isArray(edgeTypesRaw)
      ? edgeTypesRaw.map((v) => String(v).toLowerCase()).filter(Boolean)
      : ["reply", "quote"];
    if (edgeTypes.length > 0) {
      const allowed = new Set(edgeTypes);
      filtered = filtered.filter((edge) => allowed.has(edge.edge_type.toLowerCase()));
    }

    const includeExternal = payload.include_external === true;
    if (!includeExternal) {
      filtered = filtered.filter((edge) => edge.dst_ls_index !== null);
    }

    const rawIndices = payload.indices;
    if (Array.isArray(rawIndices) && rawIndices.length > 0) {
      const indexSet = new Set(
        rawIndices
          .map((value) => normalizeIndex(value))
          .filter((value): value is number => value !== null)
      );
      filtered = filtered.filter(
        (edge) =>
          (edge.src_ls_index !== null && indexSet.has(edge.src_ls_index)) ||
          (edge.dst_ls_index !== null && indexSet.has(edge.dst_ls_index))
      );
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
    if (isApiDataUrl()) {
      const res = await proxyDataApi(
        "POST",
        `/datasets/${dataset}/links/by-indices`,
        "",
        payload
      );
      return passthrough(res);
    }
    return c.json({ error: "Links graph not found for dataset" }, 404);
  }
});

dataRoutes.get("/datasets/:dataset/links/thread/:tweetId", async (c) => {
  const { dataset, tweetId } = c.req.param();
  try {
    const edges = await getEdges(dataset);
    const replyEdges = edges.filter((edge) => edge.edge_type === "reply");

    const nodeStats = await getNodeStatsRows(dataset).catch(() => []);
    const lsByTweet = new Map<string, number | null>();
    for (const row of nodeStats) {
      if (row.tweet_id) lsByTweet.set(row.tweet_id, row.ls_index);
    }

    const parentBySrc = new Map<string, string>();
    const childrenByDst = new Map<string, string[]>();
    for (const edge of replyEdges) {
      parentBySrc.set(edge.src_tweet_id, edge.dst_tweet_id);

      const children = childrenByDst.get(edge.dst_tweet_id) ?? [];
      children.push(edge.src_tweet_id);
      childrenByDst.set(edge.dst_tweet_id, children);

      if (!lsByTweet.has(edge.src_tweet_id)) lsByTweet.set(edge.src_tweet_id, edge.src_ls_index);
      if (!lsByTweet.has(edge.dst_tweet_id)) lsByTweet.set(edge.dst_tweet_id, edge.dst_ls_index);
    }

    const chainLimit = Math.max(
      1,
      normalizeIndex(c.req.query("chain_limit")) ?? 300
    );
    const descLimit = Math.max(
      1,
      normalizeIndex(c.req.query("desc_limit")) ?? 3000
    );

    const parentChain: JsonRecord[] = [];
    const visitedChain = new Set<string>([tweetId]);
    let current = tweetId;

    while (parentBySrc.has(current) && parentChain.length < chainLimit) {
      const parent = parentBySrc.get(current) as string;
      if (visitedChain.has(parent)) break;
      parentChain.push({
        tweet_id: parent,
        ls_index: lsByTweet.get(parent) ?? null,
      });
      visitedChain.add(parent);
      current = parent;
    }

    const descendants: JsonRecord[] = [];
    const seenDesc = new Set<string>();
    const queue = [...(childrenByDst.get(tweetId) ?? [])];
    while (queue.length > 0 && descendants.length < descLimit) {
      const node = queue.shift() as string;
      if (seenDesc.has(node)) continue;
      seenDesc.add(node);
      descendants.push({
        tweet_id: node,
        ls_index: lsByTweet.get(node) ?? null,
      });
      queue.push(...(childrenByDst.get(node) ?? []));
    }

    const componentNodes = new Set<string>([tweetId]);
    for (const node of parentChain) componentNodes.add(String(node.tweet_id));
    for (const node of descendants) componentNodes.add(String(node.tweet_id));

    const componentEdges = replyEdges
      .filter(
        (edge) =>
          componentNodes.has(edge.src_tweet_id) || componentNodes.has(edge.dst_tweet_id)
      )
      .slice(0, 5000);

    return c.json({
      tweet_id: tweetId,
      parent_chain: parentChain,
      descendants,
      edges: componentEdges,
    });
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/links/thread/${tweetId}`);
      return passthrough(res);
    }
    return c.json({ error: "Links graph not found for dataset" }, 404);
  }
});

dataRoutes.get("/datasets/:dataset/links/quotes/:tweetId", async (c) => {
  const { dataset, tweetId } = c.req.param();
  try {
    const edges = await getEdges(dataset);
    const quoteEdges = edges.filter((edge) => edge.edge_type === "quote");

    const limit = Math.max(1, normalizeIndex(c.req.query("limit")) ?? 2000);
    const outgoingAll = quoteEdges.filter((edge) => edge.src_tweet_id === tweetId);
    const incomingAll = quoteEdges.filter((edge) => edge.dst_tweet_id === tweetId);
    const outgoing = outgoingAll.slice(0, limit);
    const incoming = incomingAll.slice(0, limit);

    return c.json({
      tweet_id: tweetId,
      outgoing,
      incoming,
      outgoing_total: outgoingAll.length,
      incoming_total: incomingAll.length,
      truncated: outgoingAll.length > outgoing.length || incomingAll.length > incoming.length,
    });
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/links/quotes/${tweetId}`);
      return passthrough(res);
    }
    return c.json({ error: "Links graph not found for dataset" }, 404);
  }
});

// --- Tags (read-only) ---

dataRoutes.get("/tags", async (c) => {
  if (isApiDataUrl()) {
    const query = c.req.url.split("?")[1] ?? "";
    const res = await proxyDataApi("GET", "/tags", query);
    return passthrough(res);
  }
  return c.json({});
});

// --- Models ---

dataRoutes.get("/models/embedding_models", async () => {
  // Explore-only deployment path does not depend on this endpoint.
  return new Response("[]", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

// --- Data queries (indexed, query, column-filter) ---

dataRoutes.post("/indexed", async (c) => {
  const payload = (await c.req.json().catch(() => ({}))) as JsonRecord;
  const rawIndices = Array.isArray(payload.indices) ? payload.indices : [];
  const requested = rawIndices
    .map((v) => normalizeIndex(v))
    .filter((v): v is number => v !== null);
  if (requested.length === 0) return c.json([]);

  const scopeId = resolveScopeId(payload);
  const table = await getTable(scopeId);
  const indexColumn = await getIndexColumn(scopeId);
  const tableColumns = await getTableColumns(scopeId);

  const requestedColumns = Array.isArray(payload.columns)
    ? payload.columns.filter((col): col is string => typeof col === "string")
    : [];
  const selectedColumns =
    requestedColumns.length > 0
      ? ensureIndexInSelection(
          requestedColumns.filter((col) => tableColumns.includes(col)),
          indexColumn
        )
      : ensureIndexInSelection(
          tableColumns.filter((col) => col !== "vector"),
          indexColumn
        );

  const where = `${sqlIdentifier(indexColumn)} IN (${requested.join(", ")})`;
  const rowsRaw = (await table
    .query()
    .where(where)
    .select(selectedColumns)
    .limit(Math.max(requested.length, 1))
    .toArray()) as JsonRecord[];

  const rowByIndex = new Map<number, JsonRecord>();
  for (const row of rowsRaw) {
    const idx = normalizeIndex(row[indexColumn]);
    if (idx === null) continue;
    rowByIndex.set(idx, attachIndexFields(jsonSafe(row) as JsonRecord, indexColumn));
  }

  const ordered = requested
    .map((idx) => rowByIndex.get(idx))
    .filter((row): row is JsonRecord => Boolean(row));

  return c.json(ordered);
});

dataRoutes.post("/query", async (c) => {
  const payload = (await c.req.json().catch(() => ({}))) as JsonRecord;
  const scopeId = resolveScopeId(payload);
  const table = await getTable(scopeId);
  const indexColumn = await getIndexColumn(scopeId);
  const tableColumns = await getTableColumns(scopeId);

  const perPage = 100;
  const page = Math.max(0, normalizeIndex(payload.page) ?? 0);
  const offset = page * perPage;
  const sort = payload.sort as JsonRecord | undefined;

  const requestedColumns = Array.isArray(payload.columns)
    ? payload.columns.filter((col): col is string => typeof col === "string")
    : [];
  const selectedColumns =
    requestedColumns.length > 0
      ? ensureIndexInSelection(
          requestedColumns.filter((col) => tableColumns.includes(col)),
          indexColumn
        )
      : ensureIndexInSelection(
          tableColumns.filter((col) => col !== "vector"),
          indexColumn
        );

  const indices = Array.isArray(payload.indices)
    ? payload.indices
        .map((value) => normalizeIndex(value))
        .filter((value): value is number => value !== null)
    : [];

  let rows: JsonRecord[] = [];
  let total = 0;

  if (indices.length > 0) {
    const where = `${sqlIdentifier(indexColumn)} IN (${indices.join(", ")})`;
    const indexedRows = (await table
      .query()
      .where(where)
      .select(selectedColumns)
      .limit(Math.max(indices.length, 1))
      .toArray()) as JsonRecord[];

    const rowByIndex = new Map<number, JsonRecord>();
    for (const row of indexedRows) {
      const idx = normalizeIndex(row[indexColumn]);
      if (idx === null) continue;
      rowByIndex.set(idx, attachIndexFields(jsonSafe(row) as JsonRecord, indexColumn));
    }

    rows = indices
      .map((idx) => rowByIndex.get(idx))
      .filter((row): row is JsonRecord => Boolean(row));
    rows = sortRows(rows, sort);
    total = rows.length;
    rows = rows.slice(offset, offset + perPage);
  } else if (sort) {
    const allRows = (await table.query().select(selectedColumns).toArray()) as JsonRecord[];
    rows = sortRows(
      allRows.map((row) => attachIndexFields(jsonSafe(row) as JsonRecord, indexColumn)),
      sort
    );
    total = rows.length;
    rows = rows.slice(offset, offset + perPage);
  } else {
    total = await table.countRows();
    const pageRows = (await table
      .query()
      .select(selectedColumns)
      .offset(offset)
      .limit(perPage)
      .toArray()) as JsonRecord[];
    rows = pageRows.map((row) => attachIndexFields(jsonSafe(row) as JsonRecord, indexColumn));
  }

  return c.json({
    rows,
    page,
    per_page: perPage,
    total,
    totalPages: Math.ceil(total / perPage),
  });
});

dataRoutes.post("/column-filter", async (c) => {
  const payload = (await c.req.json().catch(() => ({}))) as JsonRecord;
  const scopeId = resolveScopeId(payload);
  const table = await getTable(scopeId);
  const indexColumn = await getIndexColumn(scopeId);
  const where = buildFilterWhere(payload.filters);

  const query = table.query().select([indexColumn]);
  if (where) query.where(where);

  const rows = (await query.toArray()) as JsonRecord[];
  const indices = rows
    .map((row) => normalizeIndex(row[indexColumn]))
    .filter((value): value is number => value !== null);

  return c.json({ indices });
});

// --- Static files (parquet, images, etc.) ---

dataRoutes.get("/files/:filePath{.+}", async (c) => {
  const filePath = ensureSafeRelativePath(c.req.param("filePath"));

  if (DATA_DIR) {
    const fullPath = path.join(DATA_DIR, filePath);
    if (await fileExists(fullPath)) {
      const buffer = await readFile(fullPath);
      return new Response(buffer, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
  }

  if (RAW_DATA_URL) {
    const res = await fetch(buildFileUrl(filePath));
    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  return c.json({ error: "File not found" }, 404);
});

// Optional dataset listing for non-single-profile flows when backed by legacy API.
dataRoutes.get("/datasets", async () => {
  if (isApiDataUrl()) {
    const res = await proxyDataApi("GET", "/datasets");
    return passthrough(res);
  }
  if (PUBLIC_DATASET) {
    return new Response(JSON.stringify([{ id: PUBLIC_DATASET }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("[]", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
