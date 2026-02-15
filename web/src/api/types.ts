export type JsonRecord = Record<string, unknown>;

export interface ApiError extends Error {
  status?: number;
}

export interface ScopeRef {
  id: string;
  dataset: {
    id: string;
    text_column?: string;
  };
}

export interface SearchEmbeddingInput {
  id: string;
  dimensions?: number;
}

export interface NearestNeighborsRawResponse {
  indices: number[];
  distances: number[];
  search_embedding: number[][];
}

export interface NearestNeighborsResponse {
  indices: number[];
  distances: number[];
  searchEmbedding: number[];
}

export interface NodeStatsResponse {
  ls_index: Array<number | null>;
  tweet_id: Array<string | null>;
  thread_root_id: Array<string | null>;
  thread_depth: Array<number | null>;
  thread_size: Array<number | null>;
  reply_child_count: Array<number | null>;
  reply_in_count: Array<number | null>;
  reply_out_count: Array<number | null>;
  quote_in_count: Array<number | null>;
  quote_out_count: Array<number | null>;
}

export interface NodeStatsEntry {
  threadDepth: number;
  threadSize: number;
  replyChildCount: number;
  replyInCount: number;
  replyOutCount: number;
  quoteInCount: number;
  quoteOutCount: number;
  threadRootId: string | null;
  tweetId: string | null;
}

export interface ClusterLabel extends JsonRecord {
  cluster: string | number;
  parent_cluster?: string | number | null;
  layer?: number;
  count?: number;
  likes?: number;
  children?: ClusterLabel[];
  cumulativeLikes?: number;
  cumulativeCount?: number;
}

export interface ScopeRow extends JsonRecord {
  ls_index: number;
  cluster: string | number;
  label?: string;
  deleted?: boolean;
  favorites?: unknown;
  favorite_count?: unknown;
  like_count?: unknown;
  likes?: unknown;
}

export interface ScopeData extends JsonRecord {
  id: string;
  dataset: {
    id: string;
    text_column?: string;
    [key: string]: unknown;
  };
  embedding_id?: string;
  embedding?: {
    model_id?: string;
    [key: string]: unknown;
  };
  sae?: JsonRecord | null;
  cluster_labels_lookup?: ClusterLabel[];
  hierarchical_labels?: boolean;
}
