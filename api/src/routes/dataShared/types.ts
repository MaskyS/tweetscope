export type JsonRecord = Record<string, unknown>;

export interface EdgeRow {
  edge_id: string | null;
  edge_kind: string;
  src_tweet_id: string;
  dst_tweet_id: string;
  src_ls_index: number | null;
  dst_ls_index: number | null;
  internal_target: boolean;
  provenance: string | null;
  source_url: string | null;
}

export interface NodeStatsRow {
  tweet_id: string | null;
  ls_index: number | null;
  thread_root_id: string | null;
  thread_depth: number | null;
  thread_size: number | null;
  reply_child_count: number | null;
  reply_in_count: number | null;
  reply_out_count: number | null;
  quote_in_count: number | null;
  quote_out_count: number | null;
}

