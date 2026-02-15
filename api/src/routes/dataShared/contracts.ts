import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonRecord } from "./types.js";

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
    "..",
    "..",
    "..",
    "..",
    "contracts",
    "scope_input.schema.json",
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

