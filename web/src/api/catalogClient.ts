import { apiUrl, parseJson, parseText } from './baseClient';
import type { JsonRecord, ScopeData } from './types';

export const catalogClient = {
  fetchDataset: async (datasetId: string): Promise<JsonRecord> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/meta`)
      .then((response) => parseJson<JsonRecord>(response))
      .then((data) => {
        console.log('dataset meta', data);
        return data;
      })
      .catch((error) => {
        console.error('Error fetching dataset metadata', error);
        throw error;
      });
  },
  fetchScope: async (datasetId: string, scopeId: string): Promise<ScopeData> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/scopes/${scopeId}`).then((response) =>
      parseJson<ScopeData>(response)
    );
  },
  fetchScopes: async (datasetId: string): Promise<ScopeData[]> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/scopes`)
      .then((response) => parseJson<ScopeData[]>(response))
      .then((data) => data.sort((a, b) => a.id.localeCompare(b.id)));
  },
  fetchEmbeddings: async (datasetId: string): Promise<JsonRecord[]> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/embeddings`).then((response) =>
      parseJson<JsonRecord[]>(response)
    );
  },
  fetchClusters: async (datasetId: string): Promise<JsonRecord[]> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/clusters`)
      .then((response) => parseJson<JsonRecord[]>(response))
      .then((data) =>
        data.map((d) => ({
          ...d,
          url: `${apiUrl}/files/${datasetId}/clusters/${d.id}.png`,
        }))
      );
  },
  fetchClusterLabelsAvailable: async (
    datasetId: string,
    clusterId: string
  ): Promise<JsonRecord[]> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/clusters/${clusterId}/labels_available`).then(
      (response) => parseJson<JsonRecord[]>(response)
    );
  },
  fetchClusterLabels: async (
    datasetId: string,
    clusterId: string,
    labelId: string
  ): Promise<JsonRecord[]> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/clusters/${clusterId}/labels/${labelId}`).then(
      (response) => parseJson<JsonRecord[]>(response)
    );
  },
  fetchDatasets: async (): Promise<JsonRecord[]> => {
    return fetch(`${apiUrl}/datasets`).then((response) => parseJson<JsonRecord[]>(response));
  },
  fetchVersion: async (): Promise<string> => {
    return fetch(`${apiUrl}/version`).then(parseText);
  },
  fetchAppConfig: async (): Promise<JsonRecord> => {
    return fetch(`${apiUrl}/app-config`).then((response) => parseJson<JsonRecord>(response));
  },
  fetchSettings: async (): Promise<JsonRecord> => {
    return fetch(`${apiUrl}/settings`).then((response) => parseJson<JsonRecord>(response));
  },
  fetchExportList: async (datasetId: string): Promise<JsonRecord> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/export/list`).then((response) =>
      parseJson<JsonRecord>(response)
    );
  },
};
