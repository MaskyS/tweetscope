/**
 * Data route composition for read-only Explore serving.
 *
 * Domain handlers are split by bounded context:
 * - catalog
 * - views
 * - graph
 * - query
 */

import { Hono } from "hono";
import { catalogRoutes } from "./catalog.js";
import { graphRoutes } from "./graph.js";
import { queryRoutes } from "./query.js";
import { viewsRoutes } from "./views.js";

export const dataRoutes = new Hono();

const rawDataUrl = process.env.DATA_URL?.replace(/\/$/, "");
if (rawDataUrl && rawDataUrl.endsWith("/api")) {
  throw new Error(
    "DATA_URL must not end with '/api'. Set it to the file base URL (e.g. https://your-bucket.r2.dev).",
  );
}

dataRoutes.route("/", catalogRoutes);
dataRoutes.route("/", viewsRoutes);
dataRoutes.route("/", graphRoutes);
dataRoutes.route("/", queryRoutes);

export { getScopeMeta } from "./dataShared.js";
