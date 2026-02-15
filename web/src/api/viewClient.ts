import { apiUrl, parseJson } from './baseClient';
import type { JsonRecord, ScopeRow } from './types';

export const viewClient = {
  fetchUmaps: async (datasetId: string): Promise<JsonRecord[]> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/umaps`)
      .then((response) => parseJson<JsonRecord[]>(response))
      .then((data) =>
        data.map((d) => ({
          ...d,
          url: `${apiUrl}/files/${datasetId}/umaps/${d.id}.png`,
        }))
      );
  },
  fetchUmapPoints: async (datasetId: string, umapId: string): Promise<JsonRecord[]> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/umaps/${umapId}/points`).then((response) =>
      parseJson<JsonRecord[]>(response)
    );
  },
  fetchScopeRows: async (datasetId: string, scopeId: string): Promise<ScopeRow[]> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/scopes/${scopeId}/parquet`).then((response) =>
      parseJson<ScopeRow[]>(response)
    );
  },
};
