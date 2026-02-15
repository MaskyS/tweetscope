import path from "node:path";

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", p.slice(2));
  }
  return p;
}

export const RAW_DATA_URL = process.env.DATA_URL?.replace(/\/$/, "");

export const PUBLIC_DATASET =
  process.env.PUBLIC_DATASET ?? process.env.LATENT_SCOPE_PUBLIC_DATASET ?? null;

export const PUBLIC_SCOPE =
  process.env.PUBLIC_SCOPE ?? process.env.LATENT_SCOPE_PUBLIC_SCOPE ?? null;

export const DATA_DIR = process.env.LATENT_SCOPE_DATA
  ? expandHome(process.env.LATENT_SCOPE_DATA)
  : null;

export function resolveScopeId(payload: Record<string, unknown>): string | null {
  const candidate = payload.scope_id;
  if (typeof candidate === "string" && candidate.trim()) return candidate;
  return PUBLIC_SCOPE;
}

export function resolveDataset(payload: Record<string, unknown>): string | null {
  const candidate = payload.dataset;
  if (typeof candidate === "string" && candidate.trim()) return candidate;
  return PUBLIC_DATASET;
}
