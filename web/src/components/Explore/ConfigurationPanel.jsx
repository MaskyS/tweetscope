import { Button, Switch } from 'react-element-forge';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useColorMode } from '../../hooks/useColorMode';
import styles from './ConfigurationPanel.module.scss';

const THEME_CYCLE = ['auto', 'light', 'dark'];
const THEME_META = {
  auto: { Icon: Monitor, label: 'Auto' },
  light: { Icon: Sun, label: 'Light' },
  dark: { Icon: Moon, label: 'Dark' },
};

const ConfigurationPanel = ({
  isOpen,
  onClose,
  title = 'Configuration',
  vizConfig,
  toggleShowHeatMap,
  toggleShowClusterOutlines,
  updatePointSize,
  updatePointOpacity,
  linksAvailable = false,
  linksMeta = null,
  linksLoading = false,
  toggleShowReplyEdges = () => {},
  toggleShowQuoteEdges = () => {},
  updateEdgeWidthScale = () => {},
  timelineHasDates = false,
  toggleShowTimeline = () => {},
}) => {
  const { themePreference, setThemePreference } = useColorMode();

  const {
    showHeatMap,
    showClusterOutlines,
    pointSize,
    pointOpacity,
    showReplyEdges = true,
    showQuoteEdges = true,
    edgeWidthScale = 1,
    showTimeline = false,
  } = vizConfig;

  const internalReplyEdges = linksMeta?.internal_edge_type_counts?.reply;
  const internalQuoteEdges = linksMeta?.internal_edge_type_counts?.quote;
  const internalEdges = linksMeta?.internal_edges ?? linksMeta?.internal_internal_edges;
  const hasInternalBreakdown =
    Number.isFinite(internalEdges) &&
    Number.isFinite(internalReplyEdges) &&
    Number.isFinite(internalQuoteEdges);

  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(themePreference);
    setThemePreference(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]);
  };

  const { Icon: ThemeIcon, label: themeLabel } = THEME_META[themePreference] || THEME_META.auto;

  return (
    <div className={`${styles.panel} ${isOpen ? styles.open : ''}`}>
      <div className={styles.header}>
        <h3>{title}</h3>
        <Button
          className={styles.closeButton}
          variant="outline"
          onClick={onClose}
          aria-label="Minimize configuration panel"
          icon="minus"
        />
      </div>

      <div className={styles.content}>
        <div className={styles.configSection}>
          <label>Point Size: {pointSize}x</label>
          <input
            type="range"
            min="0.1"
            max="10"
            step="0.1"
            value={pointSize}
            onChange={(e) => updatePointSize(+e.target.value)}
            className={styles.slider}
          />
        </div>

        <div className={styles.configSection}>
          <label>Point Opacity: {pointOpacity}x</label>
          <input
            type="range"
            min="0.1"
            max="1.5"
            step="0.1"
            value={pointOpacity}
            onChange={(e) => updatePointOpacity(+e.target.value)}
            className={styles.slider}
          />
        </div>

        <Switch
          value={showClusterOutlines}
          onChange={toggleShowClusterOutlines}
          defaultState={showClusterOutlines}
          color="secondary"
          label="Show Cluster Outlines"
        />

        {timelineHasDates && (
          <Switch
            value={showTimeline}
            onChange={toggleShowTimeline}
            color="secondary"
            label="Show Timeline"
          />
        )}

        {linksAvailable && (
          <>
            <Switch
              value={showReplyEdges}
              onChange={toggleShowReplyEdges}
              defaultState={showReplyEdges}
              color="secondary"
              label="Show Reply Edges"
            />

            <Switch
              value={showQuoteEdges}
              onChange={toggleShowQuoteEdges}
              defaultState={showQuoteEdges}
              color="secondary"
              label="Show Quote Edges"
            />

            <div className={styles.configSection}>
              <label>Edge Width: {edgeWidthScale.toFixed(1)}x</label>
              <input
                type="range"
                min="0.2"
                max="2.2"
                step="0.1"
                value={edgeWidthScale}
                onChange={(e) => updateEdgeWidthScale(+e.target.value)}
                className={styles.slider}
              />
            </div>

            <div className={styles.linksMeta}>
              {linksLoading ? (
                <span>Loading links...</span>
              ) : (
                <span>
                  {hasInternalBreakdown
                    ? `In-dataset links: ${internalEdges} (${internalReplyEdges} replies, ${internalQuoteEdges} quotes)`
                    : `Links: ${linksMeta?.edges ?? 0} (${linksMeta?.edge_type_counts?.reply ?? 0} replies, ${linksMeta?.edge_type_counts?.quote ?? 0} quotes)`}
                </span>
              )}
            </div>
          </>
        )}

        <button className={styles.themeCycler} onClick={cycleTheme} title={`Theme: ${themeLabel}`}>
          <ThemeIcon size={14} />
          <span>{themeLabel}</span>
        </button>
      </div>
    </div>
  );
};

export default ConfigurationPanel;
