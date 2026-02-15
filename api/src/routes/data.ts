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

dataRoutes.route("/", catalogRoutes);
dataRoutes.route("/", viewsRoutes);
dataRoutes.route("/", graphRoutes);
dataRoutes.route("/", queryRoutes);

export { getScopeMeta } from "./dataShared.js";
