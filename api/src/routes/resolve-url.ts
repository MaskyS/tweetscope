/**
 * URL resolver — t.co redirect resolution only.
 * Replaces /api/resolve-url and /api/resolve-urls from app.py.
 *
 * Only resolves t.co URLs to prevent SSRF.
 */

import { Hono } from "hono";

export const resolveUrlRoutes = new Hono();

const ALLOWED_DOMAINS = new Set(["t.co"]);

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_DOMAINS.has(parsed.hostname);
  } catch {
    return false;
  }
}

async function resolveRedirect(url: string): Promise<string> {
  if (!isAllowedUrl(url)) {
    return url; // Pass through non-t.co URLs unchanged
  }

  try {
    const res = await fetch(url, { redirect: "manual" });
    const location = res.headers.get("location");
    return location ?? url;
  } catch {
    return url;
  }
}

resolveUrlRoutes.post("/resolve-url", async (c) => {
  const body = await c.req.json<{ url?: string }>();
  if (!body.url) {
    return c.json({ error: "url is required" }, 400);
  }

  const resolved = await resolveRedirect(body.url);
  return c.json({ url: resolved });
});

resolveUrlRoutes.post("/resolve-urls", async (c) => {
  const body = await c.req.json<{ urls?: string[] }>();
  if (!body.urls || !Array.isArray(body.urls)) {
    return c.json({ error: "urls array is required" }, 400);
  }

  const results = await Promise.all(
    body.urls.map(async (url) => ({
      original: url,
      resolved: await resolveRedirect(url),
    }))
  );

  return c.json({ urls: results });
});
