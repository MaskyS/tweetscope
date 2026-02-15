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
  listDatasetsFromDataDir,
  listJsonObjects,
  loadJsonFile,
} from "./dataShared.js";

export const catalogRoutes = new Hono()
  .get("/datasets/:dataset/meta", async (c) => {
    const dataset = c.req.param("dataset");
    try {
      const meta = await loadJsonFile(`${dataset}/meta.json`);
      return c.json(meta);
    } catch {
      return c.json({ error: "Dataset metadata not found" }, 404);
    }
  })
  .get("/datasets/:dataset/scopes", async (c) => {
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
      return c.json({ error: "Scopes not found" }, 404);
    }
  })
  .get("/datasets/:dataset/scopes/:scope", async (c) => {
    const { dataset, scope } = c.req.param();
    try {
      const scopeMeta = await getScopeMeta(dataset, scope);
      return c.json(scopeMeta);
    } catch {
      return c.json({ error: "Scope not found" }, 404);
    }
  })
  .get("/tags", async (c) => {
    return c.json({});
  })
  .get("/models/embedding_models", async (c) => {
    return c.json([] as string[]);
  })
  .get("/files/:filePath{.+}", async (c) => {
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
  })
  .get("/datasets", async (c) => {
    const localDatasets = await listDatasetsFromDataDir();
    if (localDatasets.length > 0) {
      return c.json(localDatasets);
    }
    if (PUBLIC_DATASET) {
      return c.json([{ id: PUBLIC_DATASET }]);
    }
    return c.json([] as string[]);
  });
