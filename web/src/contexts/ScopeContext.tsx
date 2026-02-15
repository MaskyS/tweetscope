import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useParams } from 'react-router-dom';

import { apiUrl, catalogClient, viewClient, apiService } from '../lib/apiService';
import { saeAvailable } from '../lib/SAE';
import type { ClusterLabel, JsonRecord, ScopeData, ScopeRow } from '../api/types';

type DatasetMeta = ScopeData['dataset'];
type ClusterMapEntry = ClusterLabel | { cluster: string | number; label: string };

interface ClusterTreeNode extends ClusterLabel {
  children: ClusterTreeNode[];
  cumulativeLikes?: number;
  cumulativeCount?: number;
}

interface ClusterHierarchy {
  name: string;
  children: ClusterTreeNode[];
  layers: number[];
  totalClusters: number;
}

interface ScopeContextValue {
  userId?: string;
  datasetId?: string;
  scopeId?: string;
  dataset: DatasetMeta | null;
  scope: ScopeData | null;
  sae: JsonRecord | null;
  scopeLoaded: boolean;
  clusterMap: Record<number, ClusterMapEntry>;
  clusterLabels: ClusterLabel[];
  clusterHierarchy: ClusterHierarchy | null;
  scopeRows: ScopeRow[];
  deletedIndices: number[];
  features: JsonRecord[];
  setFeatures: Dispatch<SetStateAction<JsonRecord[]>>;
  scopes: ScopeData[];
  embeddings: JsonRecord[];
  tags: string[];
}

const ScopeContext = createContext<ScopeContextValue | null>(null);

function toNumber(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const num = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(num) ? num : 0;
}

function normalizeScopeRows(rows: ScopeRow[]): ScopeRow[] {
  return (rows || []).map((row, idx) => {
    const lsIndexRaw = row?.ls_index ?? row?.index ?? idx;
    const lsIndex = Number.isFinite(Number(lsIndexRaw)) ? Number(lsIndexRaw) : idx;
    return {
      ...row,
      ls_index: lsIndex,
    };
  });
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const { user: userId, dataset: datasetId, scope: scopeId } = useParams<{
    user?: string;
    dataset?: string;
    scope?: string;
  }>();

  const [scope, setScope] = useState<ScopeData | null>(null);
  const [dataset, setDataset] = useState<DatasetMeta | null>(null);
  const [sae, setSae] = useState<JsonRecord | null>(null);

  const [scopeLoaded, setScopeLoaded] = useState(false);
  const [scopeRows, setScopeRows] = useState<ScopeRow[]>([]);

  useEffect(() => {
    if (!datasetId || !scopeId) {
      setScope(null);
      setDataset(null);
      setSae(null);
      setScopeLoaded(false);
      return;
    }

    let cancelled = false;
    setScopeLoaded(false);

    catalogClient.fetchScope(datasetId, scopeId).then((nextScope) => {
      if (cancelled) return;
      setScope(nextScope);
      setDataset(nextScope.dataset);

      const embeddingModelId = nextScope.embedding?.model_id;
      const hasSaeSupport =
        typeof embeddingModelId === 'string' &&
        Object.prototype.hasOwnProperty.call(saeAvailable, embeddingModelId);
      if (hasSaeSupport) {
        setSae((nextScope.sae as JsonRecord | null) ?? null);
      } else {
        setSae(null);
      }

      console.log('=== Scope ===', nextScope);
    });

    return () => {
      cancelled = true;
    };
  }, [userId, datasetId, scopeId]);

  const [scopes, setScopes] = useState<ScopeData[]>([]);
  useEffect(() => {
    if (!datasetId) {
      setScopes([]);
      return;
    }

    catalogClient.fetchScopes(datasetId).then((data) => {
      setScopes(data);
    });
  }, [datasetId, setScopes]);

  const [embeddings, setEmbeddings] = useState<JsonRecord[]>([]);
  useEffect(() => {
    if (!datasetId) {
      setEmbeddings([]);
      return;
    }

    catalogClient.fetchEmbeddings(datasetId).then((data) => {
      setEmbeddings(data);
    });
  }, [datasetId, setEmbeddings]);

  const [tagset, setTagset] = useState<Record<string, unknown>>({});
  const fetchTagSet = useCallback(() => {
    if (!datasetId) {
      setTagset({});
      return;
    }

    fetch(`${apiUrl}/tags?dataset=${datasetId}`)
      .then((response) => response.json())
      .then((data) => setTagset((data ?? {}) as Record<string, unknown>));
  }, [datasetId, setTagset]);

  useEffect(() => {
    fetchTagSet();
  }, [fetchTagSet]);

  const tags = useMemo(() => {
    return Object.keys(tagset);
  }, [tagset]);

  const [features, setFeatures] = useState<JsonRecord[]>([]);
  useEffect(() => {
    if (!datasetId || !sae || !scope || embeddings.length === 0) return;

    const embedding = embeddings.find(
      (entry) => String(entry.id ?? '') === String(scope.embedding_id ?? '')
    );
    const modelId =
      embedding && typeof embedding.model_id === 'string'
        ? embedding.model_id
        : undefined;

    const saeConfig =
      modelId && Object.prototype.hasOwnProperty.call(saeAvailable, modelId)
        ? (saeAvailable as Record<string, { url: string }>)[modelId]
        : undefined;

    const saeId = typeof sae.id === 'string' ? sae.id : String(sae.id ?? '');
    if (!saeConfig?.url || !saeId) return;

    apiService.getFeatures(saeConfig.url).then((ftsRaw: unknown) => {
      const fts = (Array.isArray(ftsRaw) ? ftsRaw : []) as JsonRecord[];
      apiService.getDatasetFeatures(datasetId, saeId).then((dsfts: JsonRecord[]) => {
        dsfts.forEach((ft, i) => {
          const target = fts[i] as Record<string, unknown> | undefined;
          if (!target) return;
          target.dataset_max = ft.max_activation;
          target.dataset_avg = ft.avg_activation;
          target.dataset_count = ft.count;
        });
        console.log('DATASET included FEATURES', fts);
        setFeatures(fts);
      });
    });
  }, [scope, sae, embeddings, datasetId]);

  useEffect(() => {
    if (!scope?.id || !datasetId) {
      setScopeRows([]);
      setScopeLoaded(false);
      return;
    }

    let cancelled = false;
    viewClient
      .fetchScopeRows(datasetId, scope.id)
      .then((scopeRowsResponse) => {
        if (cancelled) return;
        setScopeRows(normalizeScopeRows(scopeRowsResponse));
        setScopeLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('Fetching data failed', error);
        setScopeRows([]);
        setScopeLoaded(false);
      });

    return () => {
      cancelled = true;
    };
  }, [datasetId, scope?.id]);

  const buildClusterTree = useCallback((labels: ClusterLabel[]): ClusterHierarchy | null => {
    if (!labels || labels.length === 0) return null;

    const byLayer: Record<number, ClusterLabel[]> = {};
    labels.forEach((label) => {
      const layer = Number(label.layer ?? 0);
      if (!byLayer[layer]) byLayer[layer] = [];
      byLayer[layer].push(label);
    });

    const layers = Object.keys(byLayer)
      .map(Number)
      .sort((a, b) => b - a);
    const maxLayer = layers[0] ?? 0;

    const labelMap = new Map<string, ClusterTreeNode>();
    labels.forEach((label) => {
      const node: ClusterTreeNode = { ...label, children: [] };
      labelMap.set(String(label.cluster), node);
    });

    labels.forEach((label) => {
      if (!label.parent_cluster) return;
      const parent = labelMap.get(String(label.parent_cluster));
      const child = labelMap.get(String(label.cluster));
      if (parent && child) {
        parent.children.push(child);
      }
    });

    const roots = labels
      .filter((label) => Number(label.layer ?? 0) === maxLayer || !label.parent_cluster)
      .map((label) => labelMap.get(String(label.cluster)))
      .filter((node): node is ClusterTreeNode => Boolean(node));

    const computeCumulativeMetrics = (node: ClusterTreeNode) => {
      let cumulativeLikes = Number(node.likes ?? 0);
      let cumulativeCount = Number(node.count ?? 0);

      if (node.children.length > 0) {
        node.children.forEach((child) => {
          computeCumulativeMetrics(child);
          cumulativeLikes += child.cumulativeLikes ?? 0;
          cumulativeCount += child.cumulativeCount ?? 0;
        });
      }

      node.cumulativeLikes = cumulativeLikes;
      node.cumulativeCount = cumulativeCount;
    };

    roots.forEach(computeCumulativeMetrics);

    const sortChildren = (node: ClusterTreeNode) => {
      if (node.children.length > 0) {
        node.children.sort((a, b) => {
          const likesDiff = (b.cumulativeLikes ?? 0) - (a.cumulativeLikes ?? 0);
          if (likesDiff !== 0) return likesDiff;
          return (b.cumulativeCount ?? 0) - (a.cumulativeCount ?? 0);
        });
        node.children.forEach(sortChildren);
      }
    };

    roots.sort((a, b) => {
      const likesDiff = (b.cumulativeLikes ?? 0) - (a.cumulativeLikes ?? 0);
      if (likesDiff !== 0) return likesDiff;
      return (b.cumulativeCount ?? 0) - (a.cumulativeCount ?? 0);
    });
    roots.forEach(sortChildren);

    return {
      name: 'Root',
      children: roots,
      layers,
      totalClusters: labels.length,
    };
  }, []);

  const { clusterMap, clusterLabels, clusterHierarchy, deletedIndices } = useMemo(() => {
    const labelSource = Array.isArray(scope?.cluster_labels_lookup)
      ? scope.cluster_labels_lookup
      : [];

    const preparedLabels: ClusterLabel[] = labelSource
      .filter(Boolean)
      .map((label) => ({ ...label, count: 0, likes: 0 }));

    const clusterLookupMap = new Map<string | number, ClusterLabel>();
    preparedLabels.forEach((cluster, idx) => {
      clusterLookupMap.set(cluster.cluster, cluster);
      clusterLookupMap.set(idx, cluster);
    });

    const nextClusterMap: Record<number, ClusterMapEntry> = {};
    const nonDeletedClusters = new Set<string | number>();
    const nextDeletedIndices: number[] = [];

    scopeRows.forEach((row) => {
      const cluster =
        clusterLookupMap.get(row.cluster) ??
        clusterLookupMap.get(Number(row.cluster));
      if (cluster) {
        cluster.count = Number(cluster.count ?? 0) + 1;
        const likesValue = toNumber(
          row.favorites ?? row.favorite_count ?? row.like_count ?? row.likes
        );
        cluster.likes = Number(cluster.likes ?? 0) + likesValue;
      }

      nextClusterMap[row.ls_index] =
        cluster ?? { cluster: row.cluster, label: row.label || 'Unknown' };

      if (!row.deleted) {
        nonDeletedClusters.add(row.cluster);
      } else {
        nextDeletedIndices.push(row.ls_index);
      }
    });

    const visibleLabels = preparedLabels.filter((label) =>
      nonDeletedClusters.has(label.cluster)
    );
    const hierarchy =
      scope?.hierarchical_labels && visibleLabels.length > 0
        ? buildClusterTree(visibleLabels)
        : null;

    return {
      clusterMap: nextClusterMap,
      clusterLabels: visibleLabels,
      clusterHierarchy: hierarchy,
      deletedIndices: nextDeletedIndices,
    };
  }, [scope, scopeRows, buildClusterTree]);

  const value = useMemo<ScopeContextValue>(
    () => ({
      userId,
      datasetId,
      scopeId,
      dataset,
      scope,
      sae,
      scopeLoaded,
      clusterMap,
      clusterLabels,
      clusterHierarchy,
      scopeRows,
      deletedIndices,
      features,
      setFeatures,
      scopes,
      embeddings,
      tags,
    }),
    [
      userId,
      datasetId,
      scopeId,
      dataset,
      scope,
      sae,
      scopeLoaded,
      clusterMap,
      clusterLabels,
      clusterHierarchy,
      scopeRows,
      deletedIndices,
      features,
      setFeatures,
      scopes,
      embeddings,
      tags,
    ]
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  const context = useContext(ScopeContext);
  if (!context) {
    throw new Error('useScope must be used within a ScopeProvider');
  }
  return context;
}
