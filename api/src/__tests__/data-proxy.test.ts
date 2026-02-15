import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

type Upstream = {
  baseUrl: string;
  hits: string[];
  close: () => Promise<void>;
};

function startUpstream(): Promise<Upstream> {
  return new Promise((resolve) => {
    const hits: string[] = [];

    const server = http.createServer(async (req, res) => {
      const url = req.url ?? "";
      hits.push(url);

      if (url === "/api/datasets/fail/meta") {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "upstream_fail" }));
        return;
      }

      let body = "";
      for await (const chunk of req) {
        body += chunk.toString("utf-8");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          method: req.method,
          url,
          content_type: req.headers["content-type"] ?? null,
          body: body || null,
        })
      );
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}/api`;
      resolve({
        baseUrl,
        hits,
        close: () =>
          new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function importFreshDataRoutes(): Promise<{ dataRoutes: { fetch: (req: Request) => Promise<Response> } }> {
  const url = new URL("../routes/data.ts", import.meta.url);
  const mod = await import(`${url.href}?t=${Date.now()}`);
  return mod as { dataRoutes: { fetch: (req: Request) => Promise<Response> } };
}

describe("data proxy mode", () => {
  let upstream: Upstream;
  const originalDataUrl = process.env.DATA_URL;

  before(async () => {
    upstream = await startUpstream();
  });

  after(async () => {
    await upstream.close();
    if (originalDataUrl === undefined) {
      delete process.env.DATA_URL;
    } else {
      process.env.DATA_URL = originalDataUrl;
    }
  });

  it("proxies allowlisted GET path + query", async () => {
    process.env.DATA_URL = upstream.baseUrl;
    const { dataRoutes } = await importFreshDataRoutes();

    const res = await dataRoutes.fetch(
      new Request("http://local/datasets/my%20dataset/meta?x=1")
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.url, "/api/datasets/my%20dataset/meta?x=1");
    assert.equal(body.method, "GET");
  });

  it("proxies allowlisted POST body and content-type", async () => {
    process.env.DATA_URL = upstream.baseUrl;
    const { dataRoutes } = await importFreshDataRoutes();

    const res = await dataRoutes.fetch(
      new Request("http://local/datasets/foo/links/by-indices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ indices: [1, 2, 3] }),
      })
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.url, "/api/datasets/foo/links/by-indices");
    assert.equal(body.method, "POST");
    assert.equal(body.content_type, "application/json");
    assert.equal(body.body, JSON.stringify({ indices: [1, 2, 3] }));
  });

  it("propagates upstream status codes", async () => {
    process.env.DATA_URL = upstream.baseUrl;
    const { dataRoutes } = await importFreshDataRoutes();

    const res = await dataRoutes.fetch(new Request("http://local/datasets/fail/meta"));
    assert.equal(res.status, 500);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, "upstream_fail");
  });

  it("returns 404 for non-allowlisted paths (not an open relay)", async () => {
    upstream.hits.length = 0;
    process.env.DATA_URL = upstream.baseUrl;
    const { dataRoutes } = await importFreshDataRoutes();

    const res = await dataRoutes.fetch(new Request("http://local/not-allowlisted"));
    assert.equal(res.status, 404);
    assert.equal(upstream.hits.length, 0);
  });

  it("rejects path traversal attempts", async () => {
    upstream.hits.length = 0;
    process.env.DATA_URL = upstream.baseUrl;
    const { dataRoutes } = await importFreshDataRoutes();

    const res = await dataRoutes.fetch(new Request("http://local/files/..%2Fsecret.txt"));
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, "Invalid path");
    assert.equal(upstream.hits.length, 0);
  });

  it("returns 502 when upstream is unreachable", async () => {
    process.env.DATA_URL = "http://127.0.0.1:1/api";
    const { dataRoutes } = await importFreshDataRoutes();

    const res = await dataRoutes.fetch(new Request("http://local/datasets/foo/meta"));
    assert.equal(res.status, 502);
  });
});

describe("non-proxy mode", () => {
  const originalDataUrl = process.env.DATA_URL;

  after(() => {
    if (originalDataUrl === undefined) {
      delete process.env.DATA_URL;
    } else {
      process.env.DATA_URL = originalDataUrl;
    }
  });

  it("does not mount proxy routes when DATA_URL is not an /api URL", async () => {
    delete process.env.DATA_URL;
    const { dataRoutes } = await importFreshDataRoutes();

    const res = await dataRoutes.fetch(new Request("http://local/datasets/foo/meta"));
    assert.equal(res.status, 404);
  });
});
