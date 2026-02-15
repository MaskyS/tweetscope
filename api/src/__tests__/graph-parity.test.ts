/**
 * Graph endpoint parity tests.
 *
 * These validate the response-shape contract that both file-based and
 * LanceDB-backed implementations must satisfy.  Run with:
 *   npx tsx --test api/src/__tests__/graph-parity.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Shape helpers — the canonical response contracts
// ---------------------------------------------------------------------------

function assertEdgeRow(edge: Record<string, unknown>): void {
  assert.ok(typeof edge.edge_id === "string" || edge.edge_id === null, "edge_id: string|null");
  assert.ok(typeof edge.edge_kind === "string", "edge_kind: string");
  assert.ok(["reply", "quote"].includes(edge.edge_kind as string), "edge_kind in {reply,quote}");
  assert.ok(typeof edge.src_tweet_id === "string", "src_tweet_id: string");
  assert.ok(typeof edge.dst_tweet_id === "string", "dst_tweet_id: string");
  assert.ok(typeof edge.src_ls_index === "number" || edge.src_ls_index === null, "src_ls_index: number|null");
  assert.ok(typeof edge.dst_ls_index === "number" || edge.dst_ls_index === null, "dst_ls_index: number|null");
  assert.ok(typeof edge.internal_target === "boolean", "internal_target: boolean");
  assert.ok(typeof edge.provenance === "string" || edge.provenance === null, "provenance: string|null");
  assert.ok(typeof edge.source_url === "string" || edge.source_url === null, "source_url: string|null");
}

function assertNodeStatsColumnar(body: Record<string, unknown>): void {
  const requiredArrays = [
    "ls_index", "tweet_id", "thread_root_id",
    "thread_depth", "thread_size", "reply_child_count",
    "reply_in_count", "reply_out_count",
    "quote_in_count", "quote_out_count",
  ];
  for (const key of requiredArrays) {
    assert.ok(Array.isArray(body[key]), `node-stats.${key} must be an array`);
  }
  // All arrays must have the same length
  const lengths = requiredArrays.map((k) => (body[k] as unknown[]).length);
  const unique = new Set(lengths);
  assert.equal(unique.size, 1, "all node-stats arrays must have equal length");
}

function assertByIndicesResponse(body: Record<string, unknown>): void {
  assert.ok(Array.isArray(body.edges), "by-indices: edges array");
  assert.ok(typeof body.total === "number", "by-indices: total number");
  assert.ok(typeof body.returned === "number", "by-indices: returned number");
  assert.ok(typeof body.truncated === "boolean", "by-indices: truncated boolean");
  for (const edge of body.edges as Record<string, unknown>[]) {
    assertEdgeRow(edge);
  }
}

function assertThreadResponse(body: Record<string, unknown>): void {
  assert.ok(typeof body.tweet_id === "string", "thread: tweet_id string");
  assert.ok(Array.isArray(body.parent_chain), "thread: parent_chain array");
  assert.ok(Array.isArray(body.descendants), "thread: descendants array");
  assert.ok(Array.isArray(body.edges), "thread: edges array");
  for (const node of body.parent_chain as Record<string, unknown>[]) {
    assert.ok(typeof node.tweet_id === "string", "chain node: tweet_id string");
    assert.ok(typeof node.ls_index === "number" || node.ls_index === null, "chain node: ls_index number|null");
  }
  for (const edge of body.edges as Record<string, unknown>[]) {
    assertEdgeRow(edge);
  }
}

function assertQuotesResponse(body: Record<string, unknown>): void {
  assert.ok(typeof body.tweet_id === "string", "quotes: tweet_id string");
  assert.ok(Array.isArray(body.outgoing), "quotes: outgoing array");
  assert.ok(Array.isArray(body.incoming), "quotes: incoming array");
  assert.ok(typeof body.outgoing_total === "number", "quotes: outgoing_total number");
  assert.ok(typeof body.incoming_total === "number", "quotes: incoming_total number");
  assert.ok(typeof body.truncated === "boolean", "quotes: truncated boolean");
  for (const edge of [...(body.outgoing as Record<string, unknown>[]), ...(body.incoming as Record<string, unknown>[])]) {
    assertEdgeRow(edge);
  }
}

function assertLinksMetaResponse(body: Record<string, unknown>): void {
  assert.ok(typeof body.dataset_id === "string", "meta: dataset_id string");
  assert.ok(typeof body.nodes === "number", "meta: nodes number");
  assert.ok(typeof body.edges === "number", "meta: edges number");
  assert.ok(typeof body.edge_kind_counts === "object" && body.edge_kind_counts !== null, "meta: edge_kind_counts object");
  const ekc = body.edge_kind_counts as Record<string, unknown>;
  assert.ok(typeof ekc.reply === "number", "meta: edge_kind_counts.reply number");
  assert.ok(typeof ekc.quote === "number", "meta: edge_kind_counts.quote number");
}

// ---------------------------------------------------------------------------
// Synthetic fixture data for unit validation
// ---------------------------------------------------------------------------

const SAMPLE_EDGE: Record<string, unknown> = {
  edge_id: "abc123",
  edge_kind: "reply",
  src_tweet_id: "111",
  dst_tweet_id: "222",
  src_ls_index: 0,
  dst_ls_index: 5,
  internal_target: true,
  provenance: "native_field",
  source_url: null,
};

const SAMPLE_NODE_STATS_COLUMNAR: Record<string, unknown> = {
  ls_index: [0, 1],
  tweet_id: ["111", "222"],
  thread_root_id: ["111", "111"],
  thread_depth: [0, 1],
  thread_size: [2, 2],
  reply_child_count: [1, 0],
  reply_in_count: [0, 1],
  reply_out_count: [1, 0],
  quote_in_count: [0, 0],
  quote_out_count: [0, 0],
};

const SAMPLE_BY_INDICES: Record<string, unknown> = {
  edges: [SAMPLE_EDGE],
  total: 1,
  returned: 1,
  truncated: false,
};

const SAMPLE_THREAD: Record<string, unknown> = {
  tweet_id: "222",
  parent_chain: [{ tweet_id: "111", ls_index: 0 }],
  descendants: [],
  edges: [SAMPLE_EDGE],
};

const SAMPLE_QUOTES: Record<string, unknown> = {
  tweet_id: "111",
  outgoing: [],
  incoming: [],
  outgoing_total: 0,
  incoming_total: 0,
  truncated: false,
};

const SAMPLE_META: Record<string, unknown> = {
  dataset_id: "test-dataset",
  scope_id: null,
  schema_version: "links-v2",
  built_at: "2026-01-01T00:00:00Z",
  nodes: 2,
  edges: 1,
  edge_kind_counts: { reply: 1, quote: 0 },
  internal_edge_kind_counts: { reply: 1, quote: 0 },
  internal_edges: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Graph response shape contracts", () => {
  it("EdgeRow shape", () => {
    assertEdgeRow(SAMPLE_EDGE);
  });

  it("EdgeRow with null ls_index", () => {
    assertEdgeRow({ ...SAMPLE_EDGE, dst_ls_index: null, internal_target: false });
  });

  it("node-stats columnar shape", () => {
    assertNodeStatsColumnar(SAMPLE_NODE_STATS_COLUMNAR);
  });

  it("by-indices response shape", () => {
    assertByIndicesResponse(SAMPLE_BY_INDICES);
  });

  it("thread response shape", () => {
    assertThreadResponse(SAMPLE_THREAD);
  });

  it("quotes response shape", () => {
    assertQuotesResponse(SAMPLE_QUOTES);
  });

  it("links/meta response shape", () => {
    assertLinksMetaResponse(SAMPLE_META);
  });

  it("empty edge list in by-indices", () => {
    assertByIndicesResponse({ edges: [], total: 0, returned: 0, truncated: false });
  });

  it("empty thread response", () => {
    assertThreadResponse({ tweet_id: "999", parent_chain: [], descendants: [], edges: [] });
  });
});

// Export shape validators for reuse by integration tests
export {
  assertEdgeRow,
  assertNodeStatsColumnar,
  assertByIndicesResponse,
  assertThreadResponse,
  assertQuotesResponse,
  assertLinksMetaResponse,
};
