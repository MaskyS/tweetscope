import { apiUrl, parseJson } from './baseClient';
import type {
  JsonRecord,
  NearestNeighborsRawResponse,
  NearestNeighborsResponse,
  ScopeRef,
  SearchEmbeddingInput,
} from './types';

export const queryClient = {
  searchNearestNeighbors: async (
    datasetId: string,
    embedding: SearchEmbeddingInput,
    query: string,
    scope: { id: string } | null = null
  ): Promise<NearestNeighborsResponse> => {
    const embeddingDimensions = embedding?.dimensions;
    const searchParams = new URLSearchParams({
      dataset: datasetId,
      query,
      embedding_id: embedding.id,
      ...(scope !== null ? { scope_id: scope.id } : {}),
      ...(embeddingDimensions !== undefined ? { dimensions: String(embeddingDimensions) } : {}),
    });

    const nearestNeigborsUrl = `${apiUrl}/search/nn?${searchParams.toString()}`;
    return fetch(nearestNeigborsUrl)
      .then((response) => parseJson<NearestNeighborsRawResponse>(response))
      .then((data) => {
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
      });
  },
  fetchDataFromIndices: async (
    datasetId: string,
    indices: number[],
    scopeId: string | null = null
  ): Promise<Array<JsonRecord & { index: number }>> => {
    return fetch(`${apiUrl}/indexed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dataset: datasetId,
        indices,
        ...(scopeId ? { scope_id: scopeId } : {}),
      }),
    })
      .then((response) => parseJson<JsonRecord[]>(response))
      .then((data) => {
        return data.map((row: JsonRecord, index: number) => ({
          index: indices[index],
          ...row,
        }));
      });
  },
  getHoverRecord: async (
    scope: ScopeRef,
    index: number,
    columns: string[] | null = null
  ): Promise<JsonRecord | null> => {
    return fetch(`${apiUrl}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dataset: scope.dataset.id,
        scope_id: scope.id,
        indices: [index],
        page: 0,
        ...(Array.isArray(columns) && columns.length ? { columns } : {}),
      }),
    })
      .then((response) => parseJson<{ rows?: JsonRecord[] }>(response))
      .then((data) => data?.rows?.[0] || null);
  },
  getHoverText: async (scope: ScopeRef, index: number): Promise<string> => {
    const textColumn = scope.dataset.text_column;
    if (!textColumn) return '';
    return queryClient.getHoverRecord(scope, index, [textColumn]).then((row) => {
      if (!row) return '';
      return String(row[textColumn] ?? '');
    });
  },
  columnFilter: async (
    datasetId: string,
    filters: JsonRecord[],
    scopeId: string | null = null
  ): Promise<{ indices: number[] }> => {
    return fetch(`${apiUrl}/column-filter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dataset: datasetId,
        filters,
        ...(scopeId ? { scope_id: scopeId } : {}),
      }),
    }).then((response) => parseJson<{ indices: number[] }>(response));
  },
};
