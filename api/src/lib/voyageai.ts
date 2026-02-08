/**
 * VoyageAI embedding helper — thin wrapper around the REST API.
 * https://docs.voyageai.com/reference/embeddings-api
 */

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

interface VoyageEmbeddingResponse {
  object: "list";
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

export async function embedQuery(
  query: string,
  opts: {
    apiKey: string;
    model: string;
    dimensions?: number;
  }
): Promise<number[]> {
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
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VoyageAI API error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as VoyageEmbeddingResponse;
  return json.data[0].embedding;
}
