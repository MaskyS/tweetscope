import { client } from '../api/client';
import type { JsonRecord, ScopeData, ScopeRow, NearestNeighborsRawResponse, NodeStatsResponse, ScopeRef, SearchEmbeddingInput } from '../api/types';

export { client };

export const apiUrl = import.meta.env.VITE_API_URL;

// ---------------------------------------------------------------------------
// Typed wrappers around the Hono RPC client.
// These preserve the same call signatures the consuming code already uses,
// so each consumer can migrate to direct `client.*` calls at its own pace.
// ---------------------------------------------------------------------------

export const catalogClient = {
  fetchDataset: async (datasetId: string): Promise<JsonRecord> => {
    const res = await client.api.datasets[':dataset'].meta.$get({
      param: { dataset: datasetId },
    });
    const data = await res.json();
    console.log('dataset meta', data);
    return data as JsonRecord;
  },
  fetchScope: async (datasetId: string, scopeId: string): Promise<ScopeData> => {
    const res = await client.api.datasets[':dataset'].scopes[':scope'].$get({
      param: { dataset: datasetId, scope: scopeId },
    });
    return (await res.json()) as ScopeData;
  },
  fetchScopes: async (datasetId: string): Promise<ScopeData[]> => {
    const res = await client.api.datasets[':dataset'].scopes.$get({
      param: { dataset: datasetId },
    });
    const data = (await res.json()) as ScopeData[];
    return data.sort((a, b) => a.id.localeCompare(b.id));
  },
  fetchEmbeddings: async (datasetId: string): Promise<JsonRecord[]> => {
    const res = await client.api.datasets[':dataset'].embeddings.$get({
      param: { dataset: datasetId },
    });
    return (await res.json()) as JsonRecord[];
  },
  fetchClusters: async (datasetId: string): Promise<JsonRecord[]> => {
    const res = await client.api.datasets[':dataset'].clusters.$get({
      param: { dataset: datasetId },
    });
    const data = (await res.json()) as JsonRecord[];
    return data.map((d) => ({
      ...d,
      url: `${apiUrl}/files/${datasetId}/clusters/${d.id}.png`,
    }));
  },
  fetchDatasets: async (): Promise<JsonRecord[]> => {
    const res = await client.api.datasets.$get();
    return (await res.json()) as JsonRecord[];
  },
  fetchAppConfig: async (): Promise<JsonRecord> => {
    const res = await client.api['app-config'].$get();
    return (await res.json()) as JsonRecord;
  },
};

export const viewClient = {
  fetchScopeRows: async (datasetId: string, scopeId: string): Promise<ScopeRow[]> => {
    const res = await client.api.datasets[':dataset'].views[':view'].rows.$get({
      param: { dataset: datasetId, view: scopeId },
    });
    return (await res.json()) as ScopeRow[];
  },
};

export const graphClient = {
  fetchLinksMeta: async (datasetId: string): Promise<JsonRecord> => {
    const res = await client.api.datasets[':dataset'].links.meta.$get({
      param: { dataset: datasetId },
    });
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Failed to fetch links meta (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as JsonRecord;
  },
  fetchLinksByIndices: async (datasetId: string, payload: JsonRecord | null): Promise<JsonRecord> => {
    const res = await client.api.datasets[':dataset'].links['by-indices'].$post({
      param: { dataset: datasetId },
      json: (payload || {}) as Record<string, unknown>,
    });
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Failed to fetch links by indices (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as JsonRecord;
  },
  fetchNodeStats: async (datasetId: string): Promise<NodeStatsResponse> => {
    const res = await client.api.datasets[':dataset'].links['node-stats'].$get({
      param: { dataset: datasetId },
    });
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Failed to fetch node stats (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as unknown as NodeStatsResponse;
  },
  fetchThread: async (datasetId: string, tweetId: string): Promise<JsonRecord> => {
    const res = await client.api.datasets[':dataset'].links.thread[':tweetId'].$get({
      param: { dataset: datasetId, tweetId },
    });
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Failed to fetch thread (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as JsonRecord;
  },
  fetchQuotes: async (datasetId: string, tweetId: string): Promise<JsonRecord> => {
    const res = await client.api.datasets[':dataset'].links.quotes[':tweetId'].$get({
      param: { dataset: datasetId, tweetId },
    });
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(`Failed to fetch quotes (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as JsonRecord;
  },
};

export const queryClient = {
  searchNearestNeighbors: async (
    datasetId: string,
    embedding: SearchEmbeddingInput,
    query: string,
    scope: { id: string } | null = null
  ): Promise<{ indices: number[]; distances: number[]; searchEmbedding: number[] }> => {
    const res = await client.api.search.nn.$get({
      query: {
        dataset: datasetId,
        query,
        embedding_id: embedding.id,
        ...(scope !== null ? { scope_id: scope.id } : {}),
        ...(embedding.dimensions !== undefined ? { dimensions: String(embedding.dimensions) } : {}),
      },
    });
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
  fetchDataFromIndices: async (
    datasetId: string,
    indices: number[],
    scopeId: string | null = null
  ): Promise<Array<JsonRecord & { index: number }>> => {
    const res = await client.api.indexed.$post({
      json: {
        dataset: datasetId,
        indices,
        ...(scopeId ? { scope_id: scopeId } : {}),
      },
    });
    const data = (await res.json()) as JsonRecord[];
    return data.map((row: JsonRecord, index: number) => ({
      index: indices[index],
      ...row,
    }));
  },
  getHoverRecord: async (
    scope: ScopeRef,
    index: number,
    columns: string[] | null = null
  ): Promise<JsonRecord | null> => {
    const res = await client.api.query.$post({
      json: {
        dataset: scope.dataset.id,
        scope_id: scope.id,
        indices: [index],
        page: 0,
        ...(Array.isArray(columns) && columns.length ? { columns } : {}),
      },
    });
    const data = (await res.json()) as { rows?: JsonRecord[] };
    return data?.rows?.[0] || null;
  },
  getHoverText: async (scope: ScopeRef, index: number): Promise<string> => {
    const textColumn = scope.dataset.text_column;
    if (!textColumn) return '';
    const row = await queryClient.getHoverRecord(scope, index, [textColumn]);
    if (!row) return '';
    return String(row[textColumn] ?? '');
  },
  columnFilter: async (
    datasetId: string,
    filters: JsonRecord[],
    scopeId: string | null = null
  ): Promise<{ indices: number[] }> => {
    const res = await client.api['column-filter'].$post({
      json: {
        dataset: datasetId,
        filters,
        ...(scopeId ? { scope_id: scopeId } : {}),
      },
    });
    return (await res.json()) as { indices: number[] };
  },
};

// Legacy Flask-only endpoints — not part of the TS API
const legacyMiscClient = {
  updateDataset: async (datasetId: string, key: string, value: string | number | boolean) => {
    return fetch(`${apiUrl}/datasets/${datasetId}/meta/update?key=${key}&value=${value}`).then(
      (response) => response.json()
    );
  },
  fetchClusterIndices: async (datasetId: string, clusterId: string) => {
    return fetch(`${apiUrl}/datasets/${datasetId}/clusters/${clusterId}/indices`)
      .then((response) => response.json())
      .then((data: JsonRecord) => {
        data.cluster_id = clusterId;
        return data;
      });
  },
  killJob: async (datasetId: string, jobId: string) => {
    return fetch(`${apiUrl}/jobs/kill?dataset=${datasetId}&job_id=${jobId}`).then((response) =>
      response.json()
    );
  },
  updateScopeLabelDescription: async (
    datasetId: string,
    scopeId: string,
    label: string,
    description: string
  ) => {
    return fetch(
      `${apiUrl}/datasets/${datasetId}/scopes/${scopeId}/description?label=${label}&description=${description}`
    ).then((response) => response.json());
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
  ...queryClient,
  ...legacyMiscClient,
};
