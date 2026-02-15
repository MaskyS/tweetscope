import { apiUrl, parseJsonOrThrow } from './baseClient';
import type { JsonRecord, NodeStatsResponse } from './types';

export const graphClient = {
  fetchLinksMeta: async (datasetId: string): Promise<JsonRecord> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/links/meta`).then((response) =>
      parseJsonOrThrow<JsonRecord>(response, 'Failed to fetch links meta')
    );
  },
  fetchLinksByIndices: async (datasetId: string, payload: JsonRecord | null): Promise<JsonRecord> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/links/by-indices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
    }).then((response) => parseJsonOrThrow<JsonRecord>(response, 'Failed to fetch links by indices'));
  },
  fetchNodeStats: async (datasetId: string): Promise<NodeStatsResponse> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/links/node-stats`).then((response) =>
      parseJsonOrThrow<NodeStatsResponse>(response, 'Failed to fetch node stats')
    );
  },
  fetchThread: async (datasetId: string, tweetId: string): Promise<JsonRecord> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/links/thread/${encodeURIComponent(tweetId)}`).then((response) =>
      parseJsonOrThrow<JsonRecord>(response, 'Failed to fetch thread')
    );
  },
  fetchQuotes: async (datasetId: string, tweetId: string): Promise<JsonRecord> => {
    return fetch(`${apiUrl}/datasets/${datasetId}/links/quotes/${encodeURIComponent(tweetId)}`).then((response) =>
      parseJsonOrThrow<JsonRecord>(response, 'Failed to fetch quotes')
    );
  },
};
