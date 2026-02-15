import { apiUrl } from '../api/baseClient';
import { catalogClient } from '../api/catalogClient';
import { viewClient } from '../api/viewClient';
import { graphClient } from '../api/graphClient';
import { queryClient } from '../api/queryClient';
import type { JsonRecord } from '../api/types';

export { apiUrl, catalogClient, viewClient, graphClient, queryClient };

const { asyncBufferFromUrl, parquetRead } = await import('hyparquet');

const legacyMiscClient = {
  updateDataset: async (datasetId: string, key: string, value: string | number | boolean) => {
    return fetch(`${apiUrl}/datasets/${datasetId}/meta/update?key=${key}&value=${value}`).then(
      (response) => response.json()
    );
  },
  getEmbeddingModels: async () => {
    return fetch(`${apiUrl}/models/embedding_models`).then((response) => response.json());
  },
  getRecentEmbeddingModels: async () => {
    return fetch(`${apiUrl}/models/embedding_models/recent`).then((response) => response.json());
  },
  getRecentChatModels: async () => {
    return fetch(`${apiUrl}/models/chat_models/recent`).then((response) => response.json());
  },
  searchHFSTModels: async (query?: string) => {
    const limit = query ? 5 : 5;
    let url = `https://huggingface.co/api/models?filter=sentence-transformers&sort=downloads&limit=${limit}&full=false&config=false`;
    if (query) {
      url += `&search=${query}`;
    }
    return fetch(url)
      .then((response) => response.json() as Promise<Array<{ id: string; downloads?: number }>>)
      .then((data) => {
        return data.map((d: { id: string; downloads?: number }) => ({
          id: '🤗-' + d.id.replace('/', '___'),
          name: d.id,
          provider: '🤗',
          downloads: d.downloads ?? 0,
          params: {},
        }));
      });
  },
  searchHFChatModels: async (query?: string) => {
    const limit = 100;
    let url = `https://huggingface.co/api/models?pipeline_tag=text-generation&library=transformers,safetensors&other=conversational&sort=downloads&limit=${limit}&full=false&config=false`;
    if (query) {
      url += `&search=${query}`;
    }
    return fetch(url)
      .then((response) =>
        response.json() as Promise<Array<{ id: string; downloads?: number; tags?: string[] }>>
      )
      .then((data) => {
        return data
          .filter(
            (d: { tags?: string[] }) =>
              Array.isArray(d.tags) &&
              d.tags.includes('conversational') &&
              !d.tags.includes('gguf')
          )
          .map((d: { id: string; downloads?: number }) => ({
            id: '🤗-' + d.id.replace('/', '___'),
            name: d.id,
            provider: '🤗',
            downloads: d.downloads ?? 0,
            params: {},
          }))
          .slice(0, 5);
      });
  },
  searchHFDatasets: async (query?: string) => {
    const limit = query ? 5 : 10;
    let url = `https://huggingface.co/api/datasets?filter=latent-scope&sort=downloads&limit=${limit}&full=false&config=false`;
    if (query) {
      url += `&search=${query}`;
    }
    return fetch(url)
      .then((response) =>
        response.json() as Promise<Array<{ id: string; downloads?: number; description?: string }>>
      )
      .then((data) => {
        return data.map((d: { id: string; downloads?: number; description?: string }) => {
          const size = d.description?.match(/Total size of dataset files: (\d+\.\d+ [A-Za-z]+)/)?.[1];
          return {
            id: d.id,
            name: d.id,
            provider: '',
            downloads: d.downloads ?? 0,
            size,
            params: {},
          };
        });
      });
  },
  fetchOllamaChatModels: async () => {
    return fetch(`http://localhost:11434/api/tags`)
      .then((response) => response.json())
      .then((data) => {
        return data?.models?.map((d: { name: string }) => ({
          id: 'ollama-' + d.name,
          name: d.name,
          provider: 'ollama',
          params: {},
        }));
      })
      .catch((error) => {
        console.error('Error fetching Ollama chat models', error);
      });
  },
  fetchClusterIndices: async (datasetId: string, clusterId: string) => {
    return fetch(`${apiUrl}/datasets/${datasetId}/clusters/${clusterId}/indices`)
      .then((response) => response.json())
      .then((data: JsonRecord) => {
        data.cluster_id = clusterId;
        return data;
      });
  },
  fetchChatModels: async () => {
    return fetch(`${apiUrl}/models/chat_models`).then((response) => response.json());
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
  fetchSaes: async (datasetId: string) => {
    return fetch(`${apiUrl}/datasets/${datasetId}/saes`).then((response) => response.json());
  },
  fetchSae: async (datasetId: string, saeId: string) => {
    return fetch(`${apiUrl}/datasets/${datasetId}/saes/${saeId}`).then((response) =>
      response.json()
    );
  },
  fetchCustomModels: async () => {
    return fetch(`${apiUrl}/models/custom-models`).then((response) => response.json());
  },
  addCustomModel: async (modelData: JsonRecord) => {
    return fetch(`${apiUrl}/models/custom-models`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(modelData),
    }).then((response) => response.json());
  },
  deleteCustomModel: async (modelId: string) => {
    return fetch(`${apiUrl}/models/custom-models/${modelId}`, {
      method: 'DELETE',
    }).then((response) => response.json());
  },
  getFeatures: async (url: string): Promise<JsonRecord[]> => {
    const buffer = await asyncBufferFromUrl(url);
    return new Promise<JsonRecord[]>((resolve) => {
      parquetRead({
        file: buffer,
        onComplete: (data: Array<Array<number | string>>) => {
          const fts = data.map((f: Array<number | string>) => ({
            feature: parseInt(String(f[0]), 10),
            max_activation: f[1],
            label: f[6],
            order: f[7],
          }));
          resolve(fts);
        },
      });
    });
  },
  getDatasetFeatures: async (datasetId: string, saeId: string) => {
    return fetch(`${apiUrl}/datasets/${datasetId}/features/${saeId}`).then((response) =>
      response.json()
    );
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
