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
import { dataProxyRoutes } from "./dataProxy.js";
import { graphRoutes } from "./graph.js";
import { queryRoutes } from "./query.js";
import { viewsRoutes } from "./views.js";

export const dataRoutes = new Hono();

const rawDataUrl = process.env.DATA_URL?.replace(/\/$/, "");
const proxyMode = Boolean(rawDataUrl && rawDataUrl.endsWith("/api"));

if (proxyMode) {
  // Proxy legacy "data surface" endpoints to an upstream API. Keep query routes local
  // (these are LanceDB-only and have no legacy proxy fallback today).
  dataRoutes.route("/", dataProxyRoutes);
  dataRoutes.route("/", queryRoutes);
} else {
  dataRoutes.route("/", catalogRoutes);
  dataRoutes.route("/", viewsRoutes);
  dataRoutes.route("/", graphRoutes);
  dataRoutes.route("/", queryRoutes);
}

export { getScopeMeta } from "./dataShared.js";
