/**
 * VoyageAI embedding helper — thin wrapper around the REST API.
 * https://docs.voyageai.com/reference/embeddings-api
 */

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_CONTEXT_API_URL = "https://api.voyageai.com/v1/contextualizedembeddings";

interface VoyageEmbeddingResponse {
  object: "list";
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

interface VoyageContextualEmbeddingResponse {
  object: "list";
  data: Array<{
    object: "list";
    data: Array<{ object: "embedding"; embedding: number[]; index: number }>;
    index: number;
  }>;
  model: string;
  usage: { total_tokens: number };
}

function isContextualModel(model: string): boolean {
  return model.toLowerCase().includes("context");
}

function parseErrorBody(text: string): string {
  try {
    const parsed = JSON.parse(text) as { detail?: unknown; error?: unknown };
    if (typeof parsed.detail === "string" && parsed.detail.trim()) return parsed.detail;
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
  } catch {
    // Non-JSON error body.
  }
  return text;
}

export async function embedQuery(
  query: string,
  opts: {
    apiKey: string;
    model: string;
    dimensions?: number;
  }
): Promise<number[]> {
  if (isContextualModel(opts.model)) {
    const body: Record<string, unknown> = {
      inputs: [[query]],
      model: opts.model,
      input_type: "query",
    };
    if (opts.dimensions) {
      body.output_dimension = opts.dimensions;
    }

    const res = await fetch(VOYAGE_CONTEXT_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text();
      const detail = parseErrorBody(text);
      throw new Error(`VoyageAI contextual API error ${res.status}: ${detail}`);
    }

    const json = (await res.json()) as VoyageContextualEmbeddingResponse;
    const firstGroup = json.data?.[0]?.data?.[0]?.embedding;
    if (!Array.isArray(firstGroup) || firstGroup.length === 0) {
      throw new Error("VoyageAI contextual API returned no embedding");
    }
    return firstGroup;
  }

  const body: Record<string, unknown> = {
    input: [query],
    model: opts.model,
    input_type: "query",
  };
  if (opts.dimensions) {
    body.output_dimension = opts.dimensions;
  }

  const res = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    const detail = parseErrorBody(text);
    throw new Error(`VoyageAI API error ${res.status}: ${detail}`);
  }

  const json = (await res.json()) as VoyageEmbeddingResponse;
  const embedding = json.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("VoyageAI API returned no embedding");
  }
  return embedding;
}
