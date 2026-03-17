/**
 * TweetScope Serving API — Hono app.
 *
 * Sole backend for all frontend serving (search, query, catalog, jobs).
 * Handles: search (LanceDB Cloud + VoyageAI), URL resolution,
 * data queries, catalog metadata, job management, and file serving.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { rateLimiter } from "hono-rate-limiter";
import { searchRoutes } from "./routes/search.js";
import { resolveUrlRoutes } from "./routes/resolve-url.js";
import { dataRoutes } from "./routes/data.js";
import { jobsRoutes } from "./routes/jobs.js";

const app = new Hono();

type AppMode = "studio" | "hosted" | "single_profile";
const isProduction = process.env.NODE_ENV === "production";

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "t", "yes", "y", "on"].includes(raw.trim().toLowerCase());
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOrigins(raw: string | undefined): string | string[] {
  if (!raw || !raw.trim()) {
    if (isProduction) {
      console.warn("CORS_ORIGIN not set — defaulting to restrictive. Set CORS_ORIGIN env var.");
      return [];
    }
    return "*"; // Dev uses Vite proxy (same-origin)
  }
  if (raw.trim() === "*") return "*";
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length <= 1 ? origins[0] ?? "*" : origins;
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
const disableNewCollection = parseBool(
  process.env.DISABLE_NEW_COLLECTION ?? process.env.LATENT_SCOPE_DISABLE_NEW_COLLECTION
);
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
  twitter_import: !disableNewCollection && (appMode === "hosted" || appMode === "studio") && !readOnly,
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

// --- Rate Limiting ---

const rateLimitWindowMs = parsePositiveInt(process.env.LATENT_SCOPE_RATE_LIMIT_WINDOW_MS, 60 * 1000);
const searchLimit = parsePositiveInt(
  process.env.LATENT_SCOPE_SEARCH_RATE_LIMIT,
  isProduction ? 20 : 500
);
const globalLimit = parsePositiveInt(
  process.env.LATENT_SCOPE_GLOBAL_RATE_LIMIT,
  isProduction ? 200 : 5000
);
const rateLimitKey = (c: any) =>
  c.req.header("x-forwarded-for") ??
  c.req.header("x-real-ip") ??
  (isProduction ? "unknown" : "dev-local");

const searchLimiter = rateLimiter({
  windowMs: rateLimitWindowMs,
  limit: searchLimit,
  keyGenerator: rateLimitKey,
});

const globalLimiter = rateLimiter({
  windowMs: rateLimitWindowMs,
  limit: globalLimit,
  keyGenerator: rateLimitKey,
});

app.use("/api/search/*", searchLimiter);
app.use("/api/*", globalLimiter);

// --- Routes ---
// Chain all .route() and inline handlers so TypeScript can infer the full type for RPC.

const routes = app
  .route("/api/search", searchRoutes)
  .route("/api", resolveUrlRoutes)
  .route("/api", dataRoutes)
  .route("/api/jobs", jobsRoutes)
  .get("/api/health", (c) => c.json({ status: "ok" }))
  .get("/api/app-config", (c) =>
    c.json({
      mode: appMode,
      read_only: readOnly,
      public_dataset_id: publicDataset,
      public_scope_id: publicScope,
      features,
      limits: { max_upload_mb: Number.isFinite(maxUploadMb) ? maxUploadMb : 1024 },
      version: "ts-api-0.1.0",
    })
  )
  .get("/api/version", (c) => c.text("ts-api-0.1.0"));

// --- Server ---

const port = parseInt(process.env.PORT ?? "3000", 10);

// For local dev with @hono/node-server
if (!isProduction) {
  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`TweetScope API listening on http://localhost:${info.port}`);
  });
}

// Export for serverless (Vercel, Cloudflare Workers)
export default app;
export type AppType = typeof routes;
