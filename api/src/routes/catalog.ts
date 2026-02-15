import { Hono } from "hono";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  DATA_DIR,
  PUBLIC_DATASET,
  PUBLIC_SCOPE,
  RAW_DATA_URL,
  buildFileUrl,
  ensureSafeRelativePath,
  fileExists,
  getScopeMeta,
  isApiDataUrl,
  listDatasetsFromDataDir,
  listJsonObjects,
  loadJsonFile,
  passthrough,
  proxyDataApi,
} from "./dataShared.js";

export const catalogRoutes = new Hono();

catalogRoutes.get("/datasets/:dataset/meta", async (c) => {
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

catalogRoutes.get("/datasets/:dataset/scopes", async (c) => {
  const dataset = c.req.param("dataset");
  try {
    if (PUBLIC_SCOPE) {
      const scope = await getScopeMeta(dataset, PUBLIC_SCOPE);
      return c.json([scope]);
    }
    if (!DATA_DIR) throw new Error("No local scope listing available");
    const scopes = await listJsonObjects(`${dataset}/scopes`, /.*[0-9]+\.json$/);
    return c.json(scopes);
  } catch {
    if (isApiDataUrl()) {
      const res = await proxyDataApi("GET", `/datasets/${dataset}/scopes`);
      return passthrough(res);
    }
    return c.json({ error: "Scopes not found" }, 404);
  }
});

catalogRoutes.get("/datasets/:dataset/scopes/:scope", async (c) => {
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

catalogRoutes.get("/tags", async (c) => {
  if (isApiDataUrl()) {
    const query = c.req.url.split("?")[1] ?? "";
    const res = await proxyDataApi("GET", "/tags", query);
    return passthrough(res);
  }
  return c.json({});
});

catalogRoutes.get("/models/embedding_models", async () => {
  // Explore-only deployment path does not depend on this endpoint.
  return new Response("[]", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

catalogRoutes.get("/files/:filePath{.+}", async (c) => {
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
catalogRoutes.get("/datasets", async () => {
  if (isApiDataUrl()) {
    const res = await proxyDataApi("GET", "/datasets");
    return passthrough(res);
  }
  const localDatasets = await listDatasetsFromDataDir();
  if (localDatasets.length > 0) {
    return new Response(JSON.stringify(localDatasets), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
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
