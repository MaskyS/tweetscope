type NullableScalar = string | number | null | undefined;

function normalizeIndices(indices: Array<number | string> | null | undefined): number[] {
  return (indices || [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));
}

export function hashIndices(indices: Array<number | string> | null | undefined): string {
  return normalizeIndices(indices).join(',');
}

export const queryKeys = {
  appConfig: () => ['appConfig'] as const,
  datasets: () => ['datasets'] as const,
  scope: (datasetId: NullableScalar, scopeId: NullableScalar) =>
    ['scope', datasetId ?? null, scopeId ?? null] as const,
  scopeRows: (datasetId: NullableScalar, scopeId: NullableScalar) =>
    ['scopeRows', datasetId ?? null, scopeId ?? null] as const,
  scopes: (datasetId: NullableScalar) => ['scopes', datasetId ?? null] as const,
  embeddings: (datasetId: NullableScalar) => ['embeddings', datasetId ?? null] as const,
  tags: (datasetId: NullableScalar) => ['tags', datasetId ?? null] as const,
  rowsByIndices: (
    datasetId: NullableScalar,
    scopeId: NullableScalar,
    indices: Array<number | string> | null | undefined
  ) => [
    'rowsByIndices',
    datasetId ?? null,
    scopeId ?? null,
    hashIndices(indices),
  ] as const,
  nearestNeighbors: (
    datasetId: NullableScalar,
    scopeId: NullableScalar,
    embeddingId: NullableScalar,
    query: NullableScalar
  ) => [
    'nearestNeighbors',
    datasetId ?? null,
    scopeId ?? null,
    embeddingId ?? null,
    query ?? '',
  ] as const,
  columnFilter: (
    datasetId: NullableScalar,
    scopeId: NullableScalar,
    column: NullableScalar,
    value: NullableScalar
  ) => [
    'columnFilter',
    datasetId ?? null,
    scopeId ?? null,
    column ?? null,
    value ?? null,
  ] as const,
  keywordSearch: (
    datasetId: NullableScalar,
    scopeId: NullableScalar,
    query: NullableScalar
  ) => [
    'keywordSearch',
    datasetId ?? null,
    scopeId ?? null,
    query ?? '',
  ] as const,
  nodeStats: (datasetId: NullableScalar) => ['nodeStats', datasetId ?? null] as const,
  linksMeta: (datasetId: NullableScalar) => ['linksMeta', datasetId ?? null] as const,
  linksByIndices: (
    datasetId: NullableScalar,
    indices: Array<number | string> | null | undefined
  ) => [
    'linksByIndices',
    datasetId ?? null,
    hashIndices(indices),
  ] as const,
  hoverRecord: (
    datasetId: NullableScalar,
    scopeId: NullableScalar,
    index: NullableScalar,
    columns: Array<string> | null | undefined
  ) => [
    'hoverRecord',
    datasetId ?? null,
    scopeId ?? null,
    index ?? null,
    (columns || []).join(','),
  ] as const,
  thread: (datasetId: NullableScalar, tweetId: NullableScalar, descLimit?: number | null) =>
    ['thread', datasetId ?? null, tweetId ?? null, descLimit ?? null] as const,
  quotes: (datasetId: NullableScalar, tweetId: NullableScalar) =>
    ['quotes', datasetId ?? null, tweetId ?? null] as const,
  scopeThumbnailPoints: (datasetId: NullableScalar, scopeId: NullableScalar) =>
    ['scopeThumbnailPoints', datasetId ?? null, scopeId ?? null] as const,
};
