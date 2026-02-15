import { Hono, type Context } from "hono";

function getUpstreamBase(): string {
  const raw = process.env.DATA_URL?.replace(/\/$/, "");
  if (!raw || !raw.endsWith("/api")) {
    throw new Error("DATA_URL must be configured as an API proxy (ends with /api)");
  }
  return raw;
}

async function proxyRequest(c: Context): Promise<Response> {
  const method = c.req.method.toUpperCase();
  if (method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (method !== "GET" && method !== "POST") {
    return c.json({ error: "Method not allowed" }, 405);
  }

  let upstreamBase: string;
  try {
    upstreamBase = getUpstreamBase();
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }

  const incomingUrl = new URL(c.req.url);

  // Prevent path traversal attempts (especially through the /files/* proxy path).
  let decodedPath = incomingUrl.pathname;
  try {
    decodedPath = decodeURIComponent(incomingUrl.pathname);
  } catch {
    // Keep raw pathname on decode failure.
  }
  const segments = decodedPath.split("/");
  if (segments.some((seg) => seg === "..")) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const upstreamUrl = `${upstreamBase}${incomingUrl.pathname}${incomingUrl.search}`;

  const headers = new Headers();
  const contentType = c.req.header("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = c.req.header("accept");
  if (accept) headers.set("accept", accept);

  let body: ArrayBuffer | undefined;
  if (method === "POST") {
    body = await c.req.arrayBuffer();
  }

  let res: Response;
  try {
    res = await fetch(upstreamUrl, {
      method,
      headers,
      ...(body ? { body } : {}),
    });
  } catch {
    return c.json({ error: "Upstream proxy connection failed" }, 502);
  }

  const outHeaders = new Headers();
  const upstreamContentType = res.headers.get("content-type");
  if (upstreamContentType) outHeaders.set("content-type", upstreamContentType);
  const cacheControl = res.headers.get("cache-control");
  if (cacheControl) outHeaders.set("cache-control", cacheControl);

  return new Response(res.body, {
    status: res.status,
    headers: outHeaders,
  });
}

export const dataProxyRoutes = new Hono();

// Explicit allowlist of legacy data-surface endpoints.
dataProxyRoutes.all("/datasets", proxyRequest);
dataProxyRoutes.all("/datasets/:dataset/meta", proxyRequest);
dataProxyRoutes.all("/datasets/:dataset/scopes", proxyRequest);
dataProxyRoutes.all("/datasets/:dataset/scopes/:scope", proxyRequest);
dataProxyRoutes.all("/datasets/:dataset/scopes/:scope/parquet", proxyRequest);
dataProxyRoutes.all("/datasets/:dataset/embeddings", proxyRequest);
dataProxyRoutes.all("/datasets/:dataset/clusters", proxyRequest);
dataProxyRoutes.all("/datasets/:dataset/clusters/:cluster/labels_available", proxyRequest);
dataProxyRoutes.all("/datasets/:dataset/clusters/:cluster/labels/:labelId", proxyRequest);

dataProxyRoutes.all("/datasets/:dataset/links/meta", proxyRequest);
dataProxyRoutes.all("/datasets/:dataset/links/node-stats", proxyRequest);
dataProxyRoutes.all("/datasets/:dataset/links/by-indices", proxyRequest);
dataProxyRoutes.all("/datasets/:dataset/links/thread/:tweetId", proxyRequest);
dataProxyRoutes.all("/datasets/:dataset/links/quotes/:tweetId", proxyRequest);

dataProxyRoutes.all("/files/:filePath{.+}", proxyRequest);
dataProxyRoutes.all("/tags", proxyRequest);
