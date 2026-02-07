import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import { groups } from 'd3-array';
import PropTypes from 'prop-types';
// import Scatter from '../Scatter';
// import Scatter from '../ScatterCanvas';
// import Scatter from './ScatterGL';
import Scatter, { getClusterColorCSS } from './DeckGLScatter';
import AnnotationPlot from '../../AnnotationPlot';
import HullPlot from '../../HullPlot';
import TilePlot from '../../TilePlot';
import { Tooltip } from 'react-tooltip';
import CrossHair from './Crosshair';
import { processHulls } from './util';
// import PointLabel from './PointLabel'; // Removed - DeckGLScatter handles this internally
import { filterConstants } from './Search/utils';

// import { useColorMode } from '../../hooks/useColorMode';

import { useScope } from '../../../contexts/ScopeContext';
import { useFilter } from '../../../contexts/FilterContext';

import { mapSelectionOpacity, mapPointSizeRange, mapSelectionKey } from '../../../lib/colors';
import styles from './VisualizationPane.module.scss';
import hoverStyles from './HoverCard.module.scss';
import ConfigurationPanel from '../ConfigurationPanel';
import { Icon, Button } from 'react-element-forge';

// VisualizationPane.propTypes = {
//   hoverAnnotations: PropTypes.array.isRequired,
//   hoveredCluster: PropTypes.object,
//   cluster: PropTypes.object,
//   scope: PropTypes.object,
//   selectedAnnotations: PropTypes.array.isRequired,
//   onScatter: PropTypes.func.isRequired,
//   onSelect: PropTypes.func.isRequired,
//   onHover: PropTypes.func.isRequired,
//   hovered: PropTypes.object,
//   dataset: PropTypes.object.isRequired,
//   containerRef: PropTypes.object.isRequired,
// };

const VisualizationPane = forwardRef(function VisualizationPane({
  width,
  height,
  onScatter,
  hovered,
  hoveredIndex,
  onHover,
  onSelect,
  hoverAnnotations,
  selectedAnnotations,
  hoveredCluster,
  dataTableRows,
}, ref) {
  const { scopeRows, clusterLabels, clusterMap, deletedIndices, scope, features } = useScope();

  const { featureFilter, clusterFilter, shownIndices, filterConfig, filteredIndices } = useFilter();

  // only show the hull if we are filtering by cluster
  const showHull = filterConfig?.type === filterConstants.CLUSTER;

  const maxZoom = 40;

  // Ref for scatter component to enable programmatic zoom
  const scatterRef = useRef(null);

  // Expose zoomToBounds and getViewState methods to parent
  useImperativeHandle(ref, () => ({
    zoomToBounds: (bounds, duration) => {
      scatterRef.current?.zoomToBounds(bounds, duration);
    },
    getViewState: () => scatterRef.current?.getViewState?.(),
  }), []);

  const [xDomain, setXDomain] = useState([-1, 1]);
  const [yDomain, setYDomain] = useState([-1, 1]);
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });
  const handleView = useCallback(
    (xDomain, yDomain, transform) => {
      setXDomain(xDomain);
      setYDomain(yDomain);
      setTransform(transform);
    },
    [setXDomain, setYDomain]
  );

  // const [isFullScreen, setIsFullScreen] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(true);
  const umapRef = useRef(null);
  const [umapOffset, setUmapOffset] = useState(0);

  const size = [width, height];

  const featureIsSelected = featureFilter.feature !== -1;

  // Add new memoized feature activation lookup
  const featureActivationMap = useMemo(() => {
    if (!featureIsSelected || !dataTableRows || !shownIndices) {
      return new Map();
    }

    const lookup = new Map();
    dataTableRows.forEach((data, index) => {
      const activatedIdx = data.sae_indices.indexOf(featureFilter.feature);
      if (activatedIdx !== -1) {
        const activatedFeature = data.sae_acts[activatedIdx];
        // normalize the activation to be between 0 and 1
        const min = 0.0;
        const max = features[featureFilter.feature].dataset_max;
        const normalizedActivation = (activatedFeature - min) / (max - min);
        lookup.set(data.ls_index, normalizedActivation);
      }
    });
    return lookup;
  }, [featureIsSelected, dataTableRows, featureFilter.feature, features]);

  const isFilterActive = !!filterConfig;
  const filteredIndexSet = useMemo(() => new Set(filteredIndices || []), [filteredIndices]);

  // Points format: [x, y, selectionKey, activation, cluster]
  const drawingPoints = useMemo(() => {
    return scopeRows.map((p, i) => {
      const cluster = p.cluster ?? 0;
      const lsIndex = p.ls_index ?? i;
      const isMatch = isFilterActive ? filteredIndexSet.has(lsIndex) : true;

      if (featureIsSelected) {
        const activation = featureActivationMap.get(lsIndex);
        const selectionKey = isMatch ? mapSelectionKey.selected : mapSelectionKey.notSelected;
        return [
          p.x,
          p.y,
          selectionKey,
          selectionKey === mapSelectionKey.selected && activation !== undefined ? activation : 0.0,
          cluster,
        ];
      }

      if (p.deleted) {
        return [-10, -10, mapSelectionKey.hidden, 0.0, cluster];
      }

      if (isFilterActive) {
        return [
          p.x,
          p.y,
          isMatch ? mapSelectionKey.selected : mapSelectionKey.notSelected,
          0.0,
          cluster,
        ];
      }

      return [p.x, p.y, mapSelectionKey.normal, 0.0, cluster];
    });
  }, [scopeRows, featureActivationMap, featureIsSelected, isFilterActive, filteredIndexSet]);

  const points = useMemo(() => {
    return scopeRows
      .filter((p) => !p.deleted)
      .map((p) => {
        return [p.x, p.y];
      });
  }, [scopeRows]);

  // const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  // useEffect(() => {
  //   console.log('==== hovered ==== ', hovered);
  //   if (hovered) {
  //     // console.log("hovered", hovered, scopeRows[hovered.index])
  //     const point = scopeRows[hovered.index];
  //     if (point && xDomain && yDomain) {
  //       let px = point.x;
  //       if (px < xDomain[0]) px = xDomain[0];
  //       if (px > xDomain[1]) px = xDomain[1];
  //       let py = point.y;
  //       if (py < yDomain[0]) py = yDomain[0];
  //       if (py > yDomain[1]) py = yDomain[1];
  //       const xPos = ((px - xDomain[0]) / (xDomain[1] - xDomain[0])) * width + 19;
  //       const yPos = ((py - yDomain[1]) / (yDomain[0] - yDomain[1])) * size[1] + umapOffset - 28;
  //       // console.log("xPos", xPos, "yPos", yPos)
  //       setTooltipPosition({
  //         x: xPos,
  //         y: yPos,
  //       });
  //     }
  //   }
  // }, [hovered, scopeRows, xDomain, yDomain, width, height, umapOffset]);

  const hulls = useMemo(() => {
    return processHulls(clusterLabels, scopeRows, (d) => (d.deleted ? null : [d.x, d.y]));
  }, [scopeRows, clusterLabels]);

  // derive the hulls from the cluster, and filter deleted points via an accessor
  const clusterHulls = useMemo(() => {
    if (!clusterFilter.cluster || !scopeRows) return [];
    return processHulls([clusterFilter.cluster], scopeRows, (d) => (d.deleted ? null : [d.x, d.y]));
  }, [clusterFilter.cluster, scopeRows]);

  const hoveredHulls = useMemo(() => {
    if (!hoveredCluster || !scopeRows) return [];
    return processHulls([hoveredCluster], scopeRows, (d) => (d.deleted ? null : [d?.x, d?.y]));
  }, [hoveredCluster, scopeRows]);

  // TODO: these should just be based on which tile we choose, 32, 64 or 128
  const tileMeta = useMemo(() => {
    return {
      size: 2 / 64,
      cols: 64,
    };
  }, []);
  const tiles = useMemo(() => {
    return groups(scopeRows, (d) => d.tile_index_64).map((tile) => {
      return {
        tile_index: tile[0],
        points: tile[1],
      };
    });
  }, [scopeRows]);

  // ====================================================================================================
  // Configuration Panel
  // ====================================================================================================
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [vizConfig, setVizConfig] = useState({
    showHeatMap: false,
    showClusterOutlines: true,
    pointSize: 1,
    pointOpacity: 1,
  });

  const toggleShowHeatMap = useCallback(() => {
    setVizConfig((prev) => ({ ...prev, showHeatMap: !prev.showHeatMap }));
  }, []);

  const toggleShowClusterOutlines = useCallback(() => {
    setVizConfig((prev) => ({ ...prev, showClusterOutlines: !prev.showClusterOutlines }));
  }, []);

  const updatePointSize = useCallback((value) => {
    setVizConfig((prev) => ({ ...prev, pointSize: value }));
  }, []);

  const updatePointOpacity = useCallback((value) => {
    setVizConfig((prev) => ({ ...prev, pointOpacity: value }));
  }, []);

  const pointSizeRange = useMemo(() => {
    return mapPointSizeRange.map((d) => d * vizConfig.pointSize);
  }, [vizConfig.pointSize]);
  const pointOpacityRange = useMemo(() => {
    return mapSelectionOpacity.map((d) => d * vizConfig.pointOpacity);
  }, [vizConfig.pointOpacity]);

  // ensure the order of selectedPoints
  // exactly matches the ordering of indexes in shownIndices.
  const selectedPoints = useMemo(() => {
    if (!shownIndices || !scopeRows) return [];
    return shownIndices
      .map((ls_index, i) => {
        // Find the point in scopeRows with matching ls_index
        const point = scopeRows.find((p) => p.ls_index === ls_index);
        return point ? { ...point, index: i } : null;
      })
      .filter((point) => point !== null);
  }, [shownIndices, scopeRows]);

  // console.log({
  //   shownIndices,
  //   selectedPoints: selectedPoints.map((p) => {
  //     return {
  //       index: p.index,
  //       ls_index: p.ls_index,
  //     };
  //   }),
  // });

  return (
    // <div style={{ width, height }} ref={umapRef}>
    <div ref={umapRef} style={{ width: '100%', height: '100%' }}>
      <div className={styles.configToggleContainer}>
        <Button
          className={styles['configToggle']}
          onClick={() => setIsPanelOpen(!isPanelOpen)}
          aria-label="Toggle configuration panel"
          icon={'settings'}
          size="small"
          // color="#333"
        />

        <ConfigurationPanel
          isOpen={isPanelOpen}
          onClose={() => setIsPanelOpen(false)}
          title="View Settings"
          vizConfig={vizConfig}
          toggleShowHeatMap={toggleShowHeatMap}
          toggleShowClusterOutlines={toggleShowClusterOutlines}
          updatePointSize={updatePointSize}
          updatePointOpacity={updatePointOpacity}
        />
      </div>

      <div className={styles.scatters + ' ' + (isFullScreen ? styles.fullScreen : '')}>
        {scope && (
          <Scatter
            ref={scatterRef}
            points={drawingPoints}
            width={width}
            height={height}
            pointScale={vizConfig.pointSize}
            pointOpacity={vizConfig.pointOpacity}
            onView={handleView}
            onSelect={onSelect}
            onHover={onHover}
            featureIsSelected={featureIsSelected}
            maxZoom={maxZoom}
          />
        )}
        {/* show all the hulls */}
        {vizConfig.showClusterOutlines && hulls.length && (
          <HullPlot
            hulls={hulls}
            // stroke="#E7C7AA"
            // stroke={cluster && cluster.hull ? 'lightgray' : '#E7C7AA'}
            // stroke={isDark ? '#E0EFFF' : '#d4b297'}
            stroke="#d4b297"
            // stroke={'#E0EFFF'}
            fill="none"
            duration={200}
            strokeWidth={0.75}
            xDomain={xDomain}
            yDomain={yDomain}
            width={width}
            height={height}
          />
        )}
        {hoveredCluster && hoveredHulls && scope.cluster_labels_lookup && (
          <HullPlot
            hulls={hoveredHulls}
            fill="#8bcf66"
            stroke="#6aa64f"
            strokeWidth={2.5}
            // if there are selected indices already, that means other points will be less visible
            // so we can make the hull a bit more transparent
            opacity={0.2}
            duration={0}
            xDomain={xDomain}
            yDomain={yDomain}
            width={width}
            height={height}
            label={scope.cluster_labels_lookup[hoveredCluster.cluster]}
            k={transform.k}
            maxZoom={maxZoom}
          />
        )}
        {/* Cluster is selected via filter */}
        {showHull &&
          clusterFilter.cluster &&
          clusterFilter.cluster.hull &&
          !scope.ignore_hulls &&
          scope.cluster_labels_lookup && (
            <HullPlot
              hulls={clusterHulls}
              fill="#D3965E"
              stroke="#C77C37"
              strokeWidth={3}
              opacity={0.25}
              duration={0}
              xDomain={xDomain}
              yDomain={yDomain}
              width={width}
              height={height}
              label={scope.cluster_labels_lookup[clusterFilter.cluster.cluster]}
            />
          )}
        <AnnotationPlot
          points={hoverAnnotations}
          stroke="black"
          fill="#8bcf66"
          size="16"
          xDomain={xDomain}
          yDomain={yDomain}
          width={width}
          height={height}
        />
        <AnnotationPlot
          points={selectedAnnotations}
          stroke="black"
          fill="purple"
          size="16"
          xDomain={xDomain}
          yDomain={yDomain}
          width={width}
          height={height}
        />
        {vizConfig.showHeatMap && tiles?.length > 1 && (
          <TilePlot
            tiles={tiles}
            tileMeta={tileMeta}
            xDomain={xDomain}
            yDomain={yDomain}
            width={width}
            height={height}
            fill="gray"
            // stroke="black"
          />
        )}
        {/* PointLabel removed - numbered dots were conflicting with DeckGL coordinates */}
        {/* <CrossHair xDomain={xDomain} yDomain={yDomain} width={width} height={height} /> */}
      </div>

      {/* Hover information display */}
      {hovered && (
        <div
          data-tooltip-id="featureTooltip"
          style={{
            position: 'absolute',
            right: 225,
            top: 0,
            pointerEvents: 'none',
          }}
        ></div>
      )}
      {hovered && (
        <Tooltip
          id="featureTooltip"
          isOpen={hovered !== null}
          delayShow={0}
          delayHide={0}
          delayUpdate={0}
          noArrow={true}
          className={`tooltip-area ${hoverStyles.hoverCard}`}
        >
          {hoveredCluster && (
            <div className={hoverStyles.clusterRow}>
              <span
                className={hoverStyles.clusterDot}
                style={{ backgroundColor: getClusterColorCSS(hoveredCluster.cluster) }}
              />
              <span className={hoverStyles.clusterLabel}>
                {hoveredCluster.label}
                <span className={hoverStyles.clusterNumber}> #{hoveredCluster.cluster}</span>
              </span>
            </div>
          )}
          <div className={hoverStyles.indexRow}>
            Index: {hovered.index}
          </div>
          <p className={hoverStyles.textPreview}>{hovered.text}</p>
        </Tooltip>
      )}

      {/* {!isMobileDevice() && (
              <div className="hovered-point">
                  {hoveredCluster && (
                      <span>
                          <span className="key">Cluster {hoveredCluster.cluster}:</span>
                          <span className="value">{hoveredCluster.label}</span>
                      </span>
                  )}
                  {hovered &&
                      Object.keys(hovered).map((key, idx) => {
                          let d = hovered[key];
                if (typeof d === "object" && !Array.isArray(d)) {
                    d = JSON.stringify(d);
                }
                let meta =
                    dataset.column_metadata && dataset.column_metadata[key];
                let value;
                if (meta && meta.image) {
                  value = (
                      <span className="value" key={idx}>
                          <img src={d} alt={key} height={64} />
                      </span>
                  );
              } else if (meta && meta.url) {
                  value = (
                      <span className="value" key={idx}>
                          <a href={d}>url</a>
                      </span>
                  );
              } else if (meta && meta.type == "array") {
                  value = (
                      <span className="value" key={idx}>
                          [{d.length}]
                      </span>
                  );
              } else {
                    value = (
                        <span className="value" key={idx}>
                            {d}
                        </span>
                    );
                }
                return (
                    <span key={key}>
                        <span className="key">{key}:</span>
                        {value}
                    </span>
                );
            })}
              </div>
          )} */}
    </div>
  );
});

export default VisualizationPane;
