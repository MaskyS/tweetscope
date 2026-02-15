import { apiUrl } from '../api/baseClient';
import { catalogClient } from '../api/catalogClient';
import { viewClient } from '../api/viewClient';
import { graphClient } from '../api/graphClient';
import { queryClient } from '../api/queryClient';
import type { JsonRecord } from '../api/types';

export { apiUrl, catalogClient, viewClient, graphClient, queryClient };

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
    return fetch(`${apiUrl}/resolve-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
    }).then((response) => response.json());
  },
  resolveUrls: async (urls: string[]) => {
    return fetch(`${apiUrl}/resolve-urls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ urls }),
    }).then((response) => response.json());
  },
};

export const apiService = {
  ...catalogClient,
  ...viewClient,
  ...graphClient,
  ...queryClient,
  ...legacyMiscClient,
};
