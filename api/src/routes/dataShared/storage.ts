import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { DATA_DIR, RAW_DATA_URL } from "./env.js";
import { ensureSafeRelativePath, fileExists, buildFileUrl } from "./paths.js";
import type { JsonRecord } from "./types.js";

const scopeCache = new Map<string, JsonRecord>();

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
  filenamePattern: RegExp,
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
