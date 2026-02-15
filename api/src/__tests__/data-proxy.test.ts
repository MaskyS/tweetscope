import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

async function importFreshDataRoutes(): Promise<{ dataRoutes: { fetch: (req: Request) => Promise<Response> } }> {
  const url = new URL("../routes/data.js", import.meta.url);
  const mod = await import(`${url.href}?t=${Date.now()}`);
  return mod as { dataRoutes: { fetch: (req: Request) => Promise<Response> } };
}

describe("serving cutover (no proxy mode)", () => {
  const originalDataUrl = process.env.DATA_URL;

  after(() => {
    if (originalDataUrl === undefined) {
      delete process.env.DATA_URL;
    } else {
      process.env.DATA_URL = originalDataUrl;
    }
  });

  it("fails fast when DATA_URL ends with /api", async () => {
    process.env.DATA_URL = "http://example.com/api";
    await assert.rejects(importFreshDataRoutes, /DATA_URL must not end with/);
  });

  it("serves /datasets without DATA_URL configured", async () => {
    delete process.env.DATA_URL;
    delete process.env.LATENT_SCOPE_DATA;
    delete process.env.PUBLIC_DATASET;
    delete process.env.LATENT_SCOPE_PUBLIC_DATASET;
    const { dataRoutes } = await importFreshDataRoutes();
    const res = await dataRoutes.fetch(new Request("http://local/datasets"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as unknown;
    assert.ok(Array.isArray(body));
  });
});
