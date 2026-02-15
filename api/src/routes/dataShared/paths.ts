import { stat } from "node:fs/promises";

import { RAW_DATA_URL } from "./env.js";

function isApiDataUrl(): boolean {
  return Boolean(RAW_DATA_URL && RAW_DATA_URL.endsWith("/api"));
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

