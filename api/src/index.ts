/**
 * TweetScope Serving API — Hono app.
 *
 * Thin TS API that replaces the Flask backend for production serving.
 * Handles: search (LanceDB Cloud + VoyageAI), URL resolution,
 * and proxies static metadata from DATA_URL (R2/S3 CDN).
 *
 * Python Flask server (latentscope/server/) is kept for local dev/studio only.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { searchRoutes } from "./routes/search.js";
import { resolveUrlRoutes } from "./routes/resolve-url.js";
import { dataRoutes } from "./routes/data.js";

const app = new Hono();

// --- Middleware ---

app.use("*", logger());

app.use(
  "/api/*",
  cors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// --- Routes ---

app.route("/api/search", searchRoutes);
app.route("/api", resolveUrlRoutes);
app.route("/api", dataRoutes);

// Health check
app.get("/api/health", (c) => c.json({ status: "ok" }));

// App config — keys must match web/src/App.jsx:64-66
app.get("/api/app-config", (c) =>
  c.json({
    mode: "single_profile",
    read_only: true,
    public_dataset_id:
      process.env.PUBLIC_DATASET ??
      process.env.LATENT_SCOPE_PUBLIC_DATASET ??
      "visakanv",
    public_scope_id:
      process.env.PUBLIC_SCOPE ??
      process.env.LATENT_SCOPE_PUBLIC_SCOPE ??
      "scopes-001",
    features: {
      can_explore: true,
      can_compare: false,
      can_ingest: false,
      can_setup: false,
      can_jobs: false,
      can_export: false,
      can_settings: false,
    },
    limits: { max_upload_mb: 0 },
    version: "ts-api-0.1.0",
  })
);

// Version
app.get("/api/version", (c) => c.text("ts-api-0.1.0"));

// --- Server ---

const port = parseInt(process.env.PORT ?? "3000", 10);

// For local dev with @hono/node-server
if (process.env.NODE_ENV !== "production") {
  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`TweetScope API listening on http://localhost:${info.port}`);
  });
}

// Export for serverless (Vercel, Cloudflare Workers)
export default app;
