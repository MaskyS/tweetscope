import { useState, useCallback } from 'react';
import { queryClient } from '../api/queryClient';

export default function useNearestNeighborsSearch({ userId, datasetId, scope, deletedIndices }) {
  const [distances, setDistances] = useState([]);

  const filter = async (query) => {
    try {
      return await queryClient
        .searchNearestNeighbors(datasetId, scope.embedding, query, scope)
        .then((data) => {
          const { indices, distances } = data;
          const filteredIndices = indices.filter((idx) => !deletedIndices.includes(idx));
          setDistances(distances);
          const limit = 20;
          return filteredIndices.slice(0, limit);
        });
    } catch (error) {
      console.error('Search failed:', error);
      return [];
    }
  };

  const clear = useCallback(() => {
    setDistances([]);
  }, []);

  return {
    filter,
    clear,
    distances,
  };
}
