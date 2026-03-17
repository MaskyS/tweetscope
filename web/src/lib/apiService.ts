import { client } from '../api/client';
import type { JsonRecord, ScopeData, ScopeRow, ScopePoint, NearestNeighborsRawResponse, KeywordSearchRawResponse, NodeStatsResponse, ScopeRef, SearchEmbeddingInput } from '../api/types';

export { client };

type RequestOptions = {
  signal?: AbortSignal;
};

function withApiPrefix(rawUrl: string | undefined): string {
  const raw = (rawUrl || '').trim().replace(/\/+$/, '').replace(/\/api$/, '');
  return `${raw}/api`;
}

export const apiUrl = withApiPrefix(import.meta.env.VITE_API_URL);

// Jobs now run on the TS API.
export const jobsApiUrl = apiUrl;

// ---------------------------------------------------------------------------
// Typed wrappers around the Hono RPC client.
// These preserve the same call signatures the consuming code already uses,
// so each consumer can migrate to direct `client.*` calls at its own pace.
// ---------------------------------------------------------------------------

export const catalogClient = {
  fetchDataset: async (datasetId: string, options: RequestOptions = {}): Promise<JsonRecord> => {
    const { signal } = options;
    const res = await client.api.datasets[':dataset'].meta.$get({
      param: { dataset: datasetId },
    }, { init: { signal } });
    const data = await res.json();
    return data as JsonRecord;
  },
  fetchScope: async (
    datasetId: string,
    scopeId: string,
    options: RequestOptions = {}
  ): Promise<ScopeData> => {
    const { signal } = options;
    const res = await client.api.datasets[':dataset'].scopes[':scope'].$get({
      param: { dataset: datasetId, scope: scopeId },
    }, { init: { signal } });
    return (await res.json()) as ScopeData;
  },
  fetchScopes: async (datasetId: string, options: RequestOptions = {}): Promise<ScopeData[]> => {
    const { signal } = options;
    const res = await client.api.datasets[':dataset'].scopes.$get({
      param: { dataset: datasetId },
    }, { init: { signal } });
    const data = (await res.json()) as ScopeData[];
    return data.sort((a, b) => a.id.localeCompare(b.id));
  },
  fetchEmbeddings: async (
    datasetId: string,
    options: RequestOptions = {}
  ): Promise<JsonRecord[]> => {
    const { signal } = options;
    const res = await client.api.datasets[':dataset'].embeddings.$get({
      param: { dataset: datasetId },
    }, { init: { signal } });
    return (await res.json()) as JsonRecord[];
  },
  fetchClusters: async (datasetId: string, options: RequestOptions = {}): Promise<JsonRecord[]> => {
    const { signal } = options;
    const res = await client.api.datasets[':dataset'].clusters.$get({
      param: { dataset: datasetId },
    }, { init: { signal } });
    const data = (await res.json()) as JsonRecord[];
    return data.map((d) => ({
      ...d,
      url: `${apiUrl}/files/${datasetId}/clusters/${d.id}.png`,
    }));
  },
  fetchDatasets: async (options: RequestOptions = {}): Promise<JsonRecord[]> => {
    const { signal } = options;
    const res = await client.api.datasets.$get({}, { init: { signal } });
    return (await res.json()) as JsonRecord[];
  },
  fetchAppConfig: async (options: RequestOptions = {}): Promise<JsonRecord> => {
    const { signal } = options;
    const res = await client.api['app-config'].$get({}, { init: { signal } });
    return (await res.json()) as JsonRecord;
  },
};

export const viewClient = {
  fetchScopePoints: async (
    datasetId: string,
    scopeId: string,
    options: RequestOptions & { sample?: number } = {}
  ): Promise<ScopePoint[]> => {
    const { signal, sample } = options;
    const res = await client.api.datasets[':dataset'].views[':view'].points.$get({
      param: { dataset: datasetId, view: scopeId },
      query: sample ? { sample } : {},
    }, { init: { signal } });
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Failed to fetch scope points (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as ScopePoint[];
  },
  fetchScopeRows: async (
    datasetId: string,
    scopeId: string,
    options: RequestOptions = {}
  ): Promise<ScopeRow[]> => {
    const { signal } = options;
    const res = await client.api.datasets[':dataset'].views[':view'].rows.$get({
      param: { dataset: datasetId, view: scopeId },
    }, { init: { signal } });
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Failed to fetch scope rows (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as ScopeRow[];
  },
};

export const graphClient = {
  fetchLinksMeta: async (datasetId: string, options: RequestOptions = {}): Promise<JsonRecord> => {
    const { signal } = options;
    const res = await client.api.datasets[':dataset'].links.meta.$get({
      param: { dataset: datasetId },
    }, { init: { signal } });
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Failed to fetch links meta (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as JsonRecord;
  },
  fetchLinksByIndices: async (
    datasetId: string,
    payload: JsonRecord | null,
    options: RequestOptions = {}
  ): Promise<JsonRecord> => {
    const { signal } = options;
    const res = await client.api.datasets[':dataset'].links['by-indices'].$post({
      param: { dataset: datasetId },
      json: (payload || {}) as Record<string, unknown>,
    }, { init: { signal } });
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Failed to fetch links by indices (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as JsonRecord;
  },
  fetchNodeStats: async (datasetId: string, options: RequestOptions = {}): Promise<NodeStatsResponse> => {
    const { signal } = options;
    const res = await client.api.datasets[':dataset'].links['node-stats'].$get({
      param: { dataset: datasetId },
    }, { init: { signal } });
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Failed to fetch node stats (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as unknown as NodeStatsResponse;
  },
  fetchThread: async (
    datasetId: string,
    tweetId: string,
    options: RequestOptions & { descLimit?: number } = {}
  ): Promise<JsonRecord> => {
    const { signal, descLimit } = options;
    const payload = descLimit != null
      ? {
          param: { dataset: datasetId, tweetId },
          query: { desc_limit: String(descLimit) },
        }
      : {
          param: { dataset: datasetId, tweetId },
        };
    const res = await client.api.datasets[':dataset'].links.thread[':tweetId'].$get(
      payload as any,
      { init: { signal } }
    );
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Failed to fetch thread (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as JsonRecord;
  },
  fetchQuotes: async (
    datasetId: string,
    tweetId: string,
    options: RequestOptions = {}
  ): Promise<JsonRecord> => {
    const { signal } = options;
    const res = await client.api.datasets[':dataset'].links.quotes[':tweetId'].$get({
      param: { dataset: datasetId, tweetId },
    }, { init: { signal } });
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Failed to fetch quotes (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as JsonRecord;
  },
};

export const queryApi = {
  searchNearestNeighbors: async (
    datasetId: string,
    embedding: SearchEmbeddingInput,
    query: string,
    scope: { id: string } | null = null,
    options: RequestOptions = {}
  ): Promise<{ indices: number[]; distances: number[]; searchEmbedding: number[] }> => {
    const { signal } = options;
    const res = await client.api.search.nn.$get({
      query: {
        dataset: datasetId,
        query,
        embedding_id: embedding.id,
        ...(scope !== null ? { scope_id: scope.id } : {}),
        ...(embedding.dimensions !== undefined ? { dimensions: String(embedding.dimensions) } : {}),
      },
    }, { init: { signal } });
    if (!res.ok) {
      let message = `Nearest-neighbor search failed (${res.status})`;
      const raw = await res.text();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { error?: unknown; detail?: unknown };
          if (typeof parsed.error === 'string' && parsed.error.trim()) {
            message = parsed.error;
          } else if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
            message = parsed.detail;
          } else {
            message = raw;
          }
        } catch {
          message = raw;
        }
      }
      const err: Error & { status?: number } = new Error(message);
      err.status = res.status;
      throw err;
    }

    const data = (await res.json()) as NearestNeighborsRawResponse;
    const dists: number[] = [];
    const inds = data.indices.map((idx: number, i: number) => {
      dists.push(data.distances[i]);
      return idx;
    });
    return {
      distances: dists,
      indices: inds,
      searchEmbedding: data.search_embedding[0],
    };
  },
  searchKeyword: async (
    datasetId: string,
    query: string,
    scope: { id: string },
    options: RequestOptions = {}
  ): Promise<{ indices: number[]; scores: number[] }> => {
    const { signal } = options;
    const res = await client.api.search.fts.$get({
      query: {
        dataset: datasetId,
        query,
        scope_id: scope.id,
      },
    }, { init: { signal } });
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Keyword search failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as KeywordSearchRawResponse;
  },
  fetchDataFromIndices: async (
    datasetId: string,
    indices: number[],
    scopeId: string | null = null,
    options: RequestOptions = {}
  ): Promise<Array<JsonRecord & { index: number }>> => {
    const { signal } = options;
    const res = await client.api.indexed.$post({
      json: {
        dataset: datasetId,
        indices,
        ...(scopeId ? { scope_id: scopeId } : {}),
      },
    }, { init: { signal } });
    const data = (await res.json()) as JsonRecord[];
    return data.map((row: JsonRecord, index: number) => ({
      index: indices[index],
      ...row,
    }));
  },
  getHoverRecord: async (
    scope: ScopeRef,
    index: number,
    columns: string[] | null = null,
    options: RequestOptions = {}
  ): Promise<JsonRecord | null> => {
    const { signal } = options;
    const res = await client.api.query.$post({
      json: {
        dataset: scope.dataset.id,
        scope_id: scope.id,
        indices: [index],
        page: 0,
        ...(Array.isArray(columns) && columns.length ? { columns } : {}),
      },
    }, { init: { signal } });
    const data = (await res.json()) as { rows?: JsonRecord[] };
    return data?.rows?.[0] || null;
  },
  getHoverText: async (
    scope: ScopeRef,
    index: number,
    options: RequestOptions = {}
  ): Promise<string> => {
    const textColumn = scope.dataset.text_column;
    if (!textColumn) return '';
    const row = await queryApi.getHoverRecord(scope, index, [textColumn], options);
    if (!row) return '';
    return String(row[textColumn] ?? '');
  },
  columnFilter: async (
    datasetId: string,
    filters: JsonRecord[],
    scopeId: string | null = null,
    options: RequestOptions = {}
  ): Promise<{ indices: number[] }> => {
    const { signal } = options;
    const res = await client.api['column-filter'].$post({
      json: {
        dataset: datasetId,
        filters,
        ...(scopeId ? { scope_id: scopeId } : {}),
      },
    }, { init: { signal } });
    return (await res.json()) as { indices: number[] };
  },
};

const miscClient = {
  killJob: async (datasetId: string, jobId: string) => {
    return fetch(`${jobsApiUrl}/jobs/kill?dataset=${datasetId}&job_id=${jobId}`).then((response) =>
      response.json()
    );
  },
  resolveUrl: async (url: string) => {
    const res = await client.api['resolve-url'].$post({
      json: { url },
    });
    return res.json();
  },
  resolveUrls: async (urls: string[]) => {
    const res = await client.api['resolve-urls'].$post({
      json: { urls },
    });
    return res.json();
  },
};

export const apiService = {
  ...catalogClient,
  ...viewClient,
  ...graphClient,
  ...queryApi,
  ...miscClient,
};
