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

type AppMode = "studio" | "hosted" | "single_profile";

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "t", "yes", "y", "on"].includes(raw.trim().toLowerCase());
}

function parseOrigins(raw: string | undefined): string | string[] {
  if (!raw || !raw.trim()) return "http://localhost:5173";
  if (raw.trim() === "*") return "*";
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length <= 1 ? origins[0] ?? "http://localhost:5173" : origins;
}

const rawMode = (
  process.env.LATENT_SCOPE_APP_MODE ??
  process.env.APP_MODE ??
  "single_profile"
)
  .trim()
  .toLowerCase();
const appMode: AppMode =
  rawMode === "studio" || rawMode === "hosted" || rawMode === "single_profile"
    ? rawMode
    : "single_profile";
const readOnly = parseBool(process.env.LATENT_SCOPE_READ_ONLY ?? process.env.READ_ONLY) || appMode === "single_profile";
const publicDataset =
  process.env.PUBLIC_DATASET ??
  process.env.LATENT_SCOPE_PUBLIC_DATASET ??
  (appMode === "single_profile" ? "visakanv" : null);
const publicScope =
  process.env.PUBLIC_SCOPE ??
  process.env.LATENT_SCOPE_PUBLIC_SCOPE ??
  (appMode === "single_profile" ? "scopes-001" : null);
const maxUploadMb = Number.parseInt(
  process.env.LATENT_SCOPE_MAX_UPLOAD_MB ?? "1024",
  10
);
const features = {
  can_explore: true,
  can_compare: appMode === "studio",
  can_ingest: (appMode === "studio" || appMode === "hosted") && !readOnly,
  can_setup: appMode === "studio" && !readOnly,
  can_jobs: appMode === "studio" && !readOnly,
  can_export: appMode === "studio" && !readOnly,
  can_settings: appMode === "studio" && !readOnly,
  twitter_import: (appMode === "hosted" || appMode === "studio") && !readOnly,
  generic_file_ingest: appMode === "studio" && !readOnly,
};

// --- Middleware ---

app.use("*", logger());

app.use(
  "/api/*",
  cors({
    origin: parseOrigins(process.env.CORS_ORIGIN),
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
    mode: appMode,
    read_only: readOnly,
    public_dataset_id: publicDataset,
    public_scope_id: publicScope,
    features,
    limits: { max_upload_mb: Number.isFinite(maxUploadMb) ? maxUploadMb : 1024 },
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
