/**
 * Shared data access helpers for read-only Explore serving.
 *
 * This file is a stable compatibility layer: route handlers import from
 * `./dataShared.js`, and we re-export the public surface from focused modules
 * under `./dataShared/*`.
 */

export type { JsonRecord, EdgeRow, NodeStatsRow } from "./dataShared/types.js";

export {
  RAW_DATA_URL,
  PUBLIC_DATASET,
  PUBLIC_SCOPE,
  DATA_DIR,
  resolveDataset,
  resolveScopeId,
} from "./dataShared/env.js";

export {
  buildFileUrl,
  ensureSafeRelativePath,
  fileExists,
} from "./dataShared/paths.js";

export { scopeContract, validateRequiredColumns } from "./dataShared/contracts.js";

export {
  attachIndexFields,
  ensureIndexInSelection,
  jsonSafe,
  normalizeIndex,
  sortRows,
} from "./dataShared/transforms.js";

export { buildFilterWhere, sqlIdentifier } from "./dataShared/sql.js";

export {
  getScopeMeta,
  listDatasetsFromDataDir,
  listJsonObjects,
  loadJsonFile,
  resolveLanceTableId,
} from "./dataShared/storage.js";
