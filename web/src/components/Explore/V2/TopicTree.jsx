import { useState, useCallback, useMemo, useEffect } from 'react';
import PropTypes from 'prop-types';
import { useScope } from '@/contexts/ScopeContext';
import { useFilter } from '@/contexts/FilterContext';
import { useColorMode } from '@/hooks/useColorMode';
import { filterConstants } from './Search/utils';
import { getClusterColorRGBA } from './DeckGLScatter';
import styles from './TopicTree.module.scss';

TopicTree.propTypes = {
  onSelectCluster: PropTypes.func,
  onZoomToCluster: PropTypes.func,
  selectedCluster: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  visibleLayers: PropTypes.arrayOf(PropTypes.number),
  hoveredCluster: PropTypes.object,
};

function TopicTree({
  onSelectCluster,
  onZoomToCluster,
  selectedCluster,
  visibleLayers = [],
  hoveredCluster = null,
}) {
  const { clusterHierarchy, clusterLabels, scope, scopeRows } = useScope();
  const {
    clusterFilter,
    filterConfig,
    setFilterConfig,
    setFilterActive,
    setFilterQuery,
    setUrlParams,
    filteredIndices,
  } = useFilter();
  const { isDark: isDarkMode } = useColorMode();

  const [expandedNodes, setExpandedNodes] = useState(new Set());
  const [internalSelectedCluster, setInternalSelectedCluster] = useState(null);
  const [selectedClusterData, setSelectedClusterData] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);

  const isHierarchical = scope?.hierarchical_labels;

  const buildClusterStyle = useCallback((clusterId, extraStyles = {}) => {
    const [r, g, b] = getClusterColorRGBA(clusterId, isDarkMode);
    const alphaSelected = isDarkMode ? 0.24 : 0.16;
    const alphaHover = isDarkMode ? 0.2 : 0.14;
    const alphaRing = isDarkMode ? 0.58 : 0.42;

    return {
      '--cluster-accent': `rgb(${r}, ${g}, ${b})`,
      '--cluster-selected-bg': `rgba(${r}, ${g}, ${b}, ${alphaSelected})`,
      '--cluster-hover-bg': `rgba(${r}, ${g}, ${b}, ${alphaHover})`,
      '--cluster-ring': `rgba(${r}, ${g}, ${b}, ${alphaRing})`,
      ...extraStyles,
    };
  }, [isDarkMode]);

  const selectedTagStyle = useMemo(() => {
    if (!selectedClusterData) return undefined;
    const [r, g, b] = getClusterColorRGBA(selectedClusterData.cluster, isDarkMode);
    return {
      '--selected-tag-color': `rgb(${r}, ${g}, ${b})`,
      '--selected-tag-bg': `rgba(${r}, ${g}, ${b}, ${isDarkMode ? 0.22 : 0.14})`,
      '--selected-tag-border': `rgba(${r}, ${g}, ${b}, ${isDarkMode ? 0.45 : 0.28})`,
      '--selected-tag-clear-bg': `rgba(${r}, ${g}, ${b}, ${isDarkMode ? 0.32 : 0.22})`,
      '--selected-tag-clear-hover-bg': `rgba(${r}, ${g}, ${b}, ${isDarkMode ? 0.44 : 0.34})`,
    };
  }, [selectedClusterData, isDarkMode]);

  // Auto-expand all nodes on mount for better visibility
  useEffect(() => {
    if (clusterHierarchy?.children) {
      const allClusters = new Set();
      const collectClusters = (nodes) => {
        nodes.forEach(node => {
          if (node.children && node.children.length > 0) {
            allClusters.add(node.cluster);
            collectClusters(node.children);
          }
        });
      };
      collectClusters(clusterHierarchy.children);
      setExpandedNodes(allClusters);
    }
  }, [clusterHierarchy]);

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

  // Filter topics by search query
  const filteredClusterLabels = useMemo(() => {
    if (!searchQuery.trim() || !clusterLabels) return clusterLabels;
    const query = searchQuery.toLowerCase();
    return clusterLabels.filter(label =>
      label.label?.toLowerCase().includes(query)
    );
  }, [clusterLabels, searchQuery]);

  // Keep local selected-tag UI in sync with externally-driven cluster filters
  // (e.g. map label click, hover card actions).
  useEffect(() => {
    const activeCluster = clusterFilter?.cluster;
    if (
      activeCluster &&
      filterConfig?.type === filterConstants.CLUSTER &&
      activeCluster.cluster !== undefined &&
      activeCluster.cluster !== null
    ) {
      const canonical = clusterLabels?.find((c) => String(c.cluster) === String(activeCluster.cluster));
      const next = canonical || activeCluster;
      setInternalSelectedCluster(next.cluster);
      setSelectedClusterData(next);
      return;
    }

    if (!activeCluster && (!filterConfig || filterConfig.type !== filterConstants.CLUSTER)) {
      setInternalSelectedCluster(null);
      setSelectedClusterData(null);
    }
  }, [clusterFilter?.cluster, filterConfig, clusterLabels]);

  const handleSelectCluster = useCallback((cluster) => {
    setInternalSelectedCluster(cluster.cluster);
    setSelectedClusterData(cluster);
    setIsExpanded(false); // Auto-collapse when selecting

    if (onSelectCluster) {
      onSelectCluster(cluster);
    }

    // Update filter context to filter tweets in the feed
    if (clusterFilter && setFilterConfig && setFilterActive) {
      clusterFilter.setCluster(cluster);
      setFilterQuery(cluster.label || String(cluster.cluster));
      setFilterConfig({
        type: filterConstants.CLUSTER,
        value: cluster.cluster,
        label: cluster.label,
      });
      setFilterActive(true);
      setUrlParams((prev) => {
        prev.set('cluster', cluster.cluster);
        prev.delete('feature');
        prev.delete('search');
        prev.delete('column');
        prev.delete('value');
        return new URLSearchParams(prev);
      });
    }
  }, [onSelectCluster, clusterFilter, setFilterConfig, setFilterActive, setFilterQuery, setUrlParams]);

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
    const isSelected = internalSelectedCluster === node.cluster || selectedCluster === node.cluster;
    const isVisible = visibleLayers.length === 0 || visibleLayers.includes(node.layer);
    // Magic Ink: highlight topic when user hovers a point in that cluster
    const isHoveredFromScatter = hoveredCluster && hoveredCluster.cluster === node.cluster;

    return (
      <div key={node.cluster} className={styles.treeNode}>
        <div
          className={`${styles.treeItem} ${isSelected ? styles.selected : ''} ${!isVisible ? styles.hidden : ''} ${isHoveredFromScatter ? styles.hoveredFromScatter : ''}`}
          style={buildClusterStyle(node.cluster, { paddingLeft: `${depth * 16 + 8}px` })}
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
  }, [expandedNodes, selectedCluster, internalSelectedCluster, visibleLayers, handleSelectCluster, handleZoomToCluster, toggleNode, hoveredCluster, buildClusterStyle]);

  // For flat (non-hierarchical) labels, render as a simple list
  const renderFlatList = useMemo(() => {
    if (!filteredClusterLabels || filteredClusterLabels.length === 0) return null;

    return filteredClusterLabels
      .sort((a, b) => {
        const likesDiff = (b.likes || 0) - (a.likes || 0);
        if (likesDiff !== 0) return likesDiff;
        return (b.count || 0) - (a.count || 0);
      })
      .map(label => {
        const isSelected = internalSelectedCluster === label.cluster || selectedCluster === label.cluster;
        const isHoveredFromScatter = hoveredCluster && hoveredCluster.cluster === label.cluster;

        return (
          <div
            key={label.cluster}
            className={`${styles.treeItem} ${isSelected ? styles.selected : ''} ${isHoveredFromScatter ? styles.hoveredFromScatter : ''}`}
            style={buildClusterStyle(label.cluster, { paddingLeft: '8px' })}
            onClick={() => handleSelectCluster(label)}
            onDoubleClick={() => handleZoomToCluster(label)}
            title="Click to filter • Double-click to zoom"
          >
            <span className={styles.label} title={label.label}>
              {label.label}
            </span>
            <span className={styles.count}>({label.count || 0})</span>
          </div>
        );
      });
  }, [filteredClusterLabels, selectedCluster, internalSelectedCluster, handleSelectCluster, handleZoomToCluster, hoveredCluster, buildClusterStyle]);

  if (!scope) {
    return (
      <div className={styles.topicTree}>
        <div className={styles.searchBar}>
          <div className={styles.searchInputWrapper}>
            <input
              type="text"
              className={styles.searchInput}
              placeholder="Search topics..."
              disabled
            />
          </div>
        </div>
        <div className={styles.empty}>Loading...</div>
      </div>
    );
  }

  // Clear filter handler
  const handleClearFilter = useCallback(() => {
    setInternalSelectedCluster(null);
    setSelectedClusterData(null);
    setSearchQuery('');
    // Preserve current expand/collapse state when clearing selection.
    if (clusterFilter) {
      clusterFilter.clear();
    }
    setFilterConfig(null);
    setFilterQuery('');
    if (setFilterActive) {
      setFilterActive(false);
    }
    setUrlParams((prev) => {
      prev.delete('cluster');
      prev.delete('feature');
      prev.delete('search');
      prev.delete('column');
      prev.delete('value');
      return new URLSearchParams(prev);
    });
  }, [clusterFilter, setFilterActive, setFilterConfig, setFilterQuery, setUrlParams]);

  return (
    <div className={styles.topicTree}>
      {/* Sticky search bar */}
      <div className={styles.searchBar}>
        <div className={styles.searchInputWrapper}>
          {selectedClusterData ? (
            <>
              <span className={styles.selectedTag} style={selectedTagStyle}>
                <span className={styles.tagLabel} title={selectedClusterData.label}>
                  {selectedClusterData.label}
                </span>
                <button
                  className={styles.tagClear}
                  onClick={handleClearFilter}
                  aria-label="Clear filter"
                >
                  ×
                </button>
              </span>
              <span className={styles.resultCount}>
                {filteredIndices?.length || 0} results
              </span>
            </>
          ) : (
            <input
              type="text"
              className={styles.searchInput}
              placeholder="Search topics..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          )}
        </div>
        <button
          className={styles.expandToggle}
          onClick={() => setIsExpanded(!isExpanded)}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
        >
          {isExpanded ? '▲' : '▼'}
        </button>
      </div>

      {/* Expandable topic list */}
      {isExpanded && (
        <div className={styles.treeContainer}>
          {isHierarchical && clusterHierarchy ? (
            clusterHierarchy.children?.map(node => renderNode(node, 0))
          ) : (
            renderFlatList
          )}

          {(!filteredClusterLabels || filteredClusterLabels.length === 0) && (
            <div className={styles.empty}>
              {searchQuery ? 'No matching topics' : 'No topics available'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default TopicTree;
