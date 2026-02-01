import { useState, useCallback, useMemo } from 'react';
import PropTypes from 'prop-types';
import { useScope } from '@/contexts/ScopeContext';
import { useFilter } from '@/contexts/FilterContext';
import styles from './TopicTree.module.scss';

TopicTree.propTypes = {
  onSelectCluster: PropTypes.func,
  onZoomToCluster: PropTypes.func,
  selectedCluster: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  visibleLayers: PropTypes.arrayOf(PropTypes.number),
};

function TopicTree({
  onSelectCluster,
  onZoomToCluster,
  selectedCluster,
  visibleLayers = [],
}) {
  const { clusterHierarchy, clusterLabels, scope, scopeRows } = useScope();
  const { setClusterFilter } = useFilter();

  const [expandedNodes, setExpandedNodes] = useState(new Set());

  const isHierarchical = scope?.hierarchical_labels;

  const toggleNode = useCallback((clusterId, event) => {
    event.stopPropagation();
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(clusterId)) {
        newSet.delete(clusterId);
      } else {
        newSet.add(clusterId);
      }
      return newSet;
    });
  }, []);

  const handleSelectCluster = useCallback((cluster) => {
    if (onSelectCluster) {
      onSelectCluster(cluster);
    }
    // Also update the filter context
    if (setClusterFilter) {
      setClusterFilter({ cluster });
    }
  }, [onSelectCluster, setClusterFilter]);

  // Handle zoom to cluster - compute bounds from hull and call callback
  const handleZoomToCluster = useCallback((cluster) => {
    if (!onZoomToCluster || !cluster.hull || cluster.hull.length < 3) return;

    // Compute bounds from hull indices
    const hullPoints = cluster.hull
      .map(idx => scopeRows[idx])
      .filter(p => p && !p.deleted);

    if (hullPoints.length < 3) return;

    const xs = hullPoints.map(p => p.x);
    const ys = hullPoints.map(p => p.y);
    const bounds = [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys)
    ];

    // Add padding (15%)
    const padX = (bounds[2] - bounds[0]) * 0.15;
    const padY = (bounds[3] - bounds[1]) * 0.15;

    onZoomToCluster([
      bounds[0] - padX,
      bounds[1] - padY,
      bounds[2] + padX,
      bounds[3] + padY
    ]);
  }, [onZoomToCluster, scopeRows]);

  const renderNode = useCallback((node, depth = 0) => {
    if (!node) return null;

    const hasChildren = node.children && node.children.length > 0;
    const isExpanded = expandedNodes.has(node.cluster);
    const isSelected = selectedCluster === node.cluster;
    const isVisible = visibleLayers.length === 0 || visibleLayers.includes(node.layer);

    return (
      <div key={node.cluster} className={styles.treeNode}>
        <div
          className={`${styles.treeItem} ${isSelected ? styles.selected : ''} ${!isVisible ? styles.hidden : ''}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => handleSelectCluster(node)}
          onDoubleClick={() => handleZoomToCluster(node)}
          title="Double-click to zoom to cluster"
        >
          {hasChildren && (
            <button
              className={styles.expandBtn}
              onClick={(e) => toggleNode(node.cluster, e)}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? '▼' : '▶'}
            </button>
          )}
          {!hasChildren && <span className={styles.expandPlaceholder} />}
          <span className={styles.label} title={node.label}>
            {node.label}
          </span>
          <span className={styles.count}>({node.count || 0})</span>
          {node.layer !== undefined && (
            <span className={styles.layer}>L{node.layer}</span>
          )}
        </div>

        {hasChildren && isExpanded && (
          <div className={styles.treeChildren}>
            {node.children.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }, [expandedNodes, selectedCluster, visibleLayers, handleSelectCluster, handleZoomToCluster, toggleNode]);

  // For flat (non-hierarchical) labels, render as a simple list
  const renderFlatList = useMemo(() => {
    if (!clusterLabels || clusterLabels.length === 0) return null;

    return clusterLabels
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .map(label => (
        <div
          key={label.cluster}
          className={`${styles.treeItem} ${selectedCluster === label.cluster ? styles.selected : ''}`}
          style={{ paddingLeft: '8px' }}
          onClick={() => handleSelectCluster(label)}
          onDoubleClick={() => handleZoomToCluster(label)}
          title="Double-click to zoom to cluster"
        >
          <span className={styles.label} title={label.label}>
            {label.label}
          </span>
          <span className={styles.count}>({label.count || 0})</span>
        </div>
      ));
  }, [clusterLabels, selectedCluster, handleSelectCluster, handleZoomToCluster]);

  if (!scope) {
    return (
      <div className={styles.topicTree}>
        <div className={styles.header}>
          <h4>Topics</h4>
        </div>
        <div className={styles.empty}>Loading...</div>
      </div>
    );
  }

  return (
    <div className={styles.topicTree}>
      <div className={styles.header}>
        <h4>
          {isHierarchical ? 'Topic Hierarchy' : 'Topics'}
        </h4>
        {isHierarchical && clusterHierarchy && (
          <span className={styles.stats}>
            {clusterHierarchy.totalClusters} topics, {clusterHierarchy.layers?.length || 1} layers
          </span>
        )}
      </div>

      <div className={styles.treeContainer}>
        {isHierarchical && clusterHierarchy ? (
          // Hierarchical tree view
          clusterHierarchy.children?.map(node => renderNode(node, 0))
        ) : (
          // Flat list view
          renderFlatList
        )}

        {(!clusterLabels || clusterLabels.length === 0) && (
          <div className={styles.empty}>No topics available</div>
        )}
      </div>
    </div>
  );
}

export default TopicTree;
