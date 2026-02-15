import type { JsonRecord } from "./types.js";

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

