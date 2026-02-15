import type { JsonRecord } from "./types.js";

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

