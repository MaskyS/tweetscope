import { Hono } from "hono";
import type * as lancedb from "@lancedb/lancedb";
import { getDatasetTable, paginatedFilteredScan, paginatedScan } from "../lib/lancedb.js";
import {
  attachIndexFields,
  buildFilterWhere,
  ensureIndexInSelection,
  jsonSafe,
  normalizeIndex,
  resolveDataset,
  resolveLanceTableId,
  resolveScopeId,
  sortRows,
  sqlIdentifier,
  type JsonRecord,
} from "./dataShared.js";

function uniqueIntegers(values: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

async function getTableColumnsFromSchema(table: lancedb.Table): Promise<string[]> {
  const schema = (await table.schema()) as { fields?: Array<{ name?: string }> };
  return (schema.fields ?? [])
    .map((field) => String(field.name ?? ""))
    .filter((name) => name.length > 0);
}

function resolveIndexColumn(tableColumns: string[]): string {
  const candidates = ["index", "ls_index", "id"];
  return candidates.find((name) => tableColumns.includes(name)) ?? "index";
}

export const queryRoutes = new Hono()
  .post("/indexed", async (c) => {
    const payload = (await c.req.json().catch(() => ({}))) as JsonRecord;
    const rawIndices = Array.isArray(payload.indices) ? payload.indices : [];
    const requested = uniqueIntegers(
      rawIndices
      .map((v) => normalizeIndex(v))
      .filter((v): v is number => v !== null),
    );
    if (requested.length === 0) return c.json([]);

    const scopeId = resolveScopeId(payload);
    if (!scopeId) {
      return c.json(
        { error: "scope_id is required when LATENT_SCOPE_PUBLIC_SCOPE is not configured" },
        400
      );
    }
    const dataset = resolveDataset(payload);
    if (!dataset) {
      return c.json({ error: "dataset is required" }, 400);
    }
    const tableId = await resolveLanceTableId(dataset, scopeId);
    const table = await getDatasetTable(dataset, tableId);
    const tableColumns = await getTableColumnsFromSchema(table);
    const indexColumn = resolveIndexColumn(tableColumns);

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
  })
  .post("/query", async (c) => {
    const payload = (await c.req.json().catch(() => ({}))) as JsonRecord;
    const scopeId = resolveScopeId(payload);
    if (!scopeId) {
      return c.json(
        { error: "scope_id is required when LATENT_SCOPE_PUBLIC_SCOPE is not configured" },
        400
      );
    }
    const dataset = resolveDataset(payload);
    if (!dataset) {
      return c.json({ error: "dataset is required" }, 400);
    }
    const tableId = await resolveLanceTableId(dataset, scopeId);
    const table = await getDatasetTable(dataset, tableId);
    const tableColumns = await getTableColumnsFromSchema(table);
    const indexColumn = resolveIndexColumn(tableColumns);

    const perPage = 100;
    const page = Math.min(Math.max(0, normalizeIndex(payload.page) ?? 0), 10_000);
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
      ? uniqueIntegers(
          payload.indices
          .map((value) => normalizeIndex(value))
          .filter((value): value is number => value !== null),
        )
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
      const allRows = (await paginatedScan(table, selectedColumns)) as JsonRecord[];
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
  })
  .post("/column-filter", async (c) => {
    const payload = (await c.req.json().catch(() => ({}))) as JsonRecord;
    const scopeId = resolveScopeId(payload);
    if (!scopeId) {
      return c.json(
        { error: "scope_id is required when LATENT_SCOPE_PUBLIC_SCOPE is not configured" },
        400
      );
    }
    const dataset = resolveDataset(payload);
    if (!dataset) {
      return c.json({ error: "dataset is required" }, 400);
    }
    const tableId = await resolveLanceTableId(dataset, scopeId);
    const table = await getDatasetTable(dataset, tableId);
    const tableColumns = await getTableColumnsFromSchema(table);
    const indexColumn = resolveIndexColumn(tableColumns);
    const where = buildFilterWhere(payload.filters);

    const rows = where
      ? ((await paginatedFilteredScan(table, where, [indexColumn])) as JsonRecord[])
      : ((await paginatedScan(table, [indexColumn])) as JsonRecord[]);
    const indices = uniqueIntegers(
      rows
      .map((row) => normalizeIndex(row[indexColumn]))
      .filter((value): value is number => value !== null),
    );

    return c.json({ indices });
  });
