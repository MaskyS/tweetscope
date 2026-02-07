import { useState, useCallback } from 'react';

const MODES = {
  COLLAPSED: 'collapsed',
  NORMAL: 'normal',
  EXPANDED: 'expanded',
};

export { MODES as SIDEBAR_MODES };

export default function useSidebarState() {
  const [sidebarMode, setSidebarModeRaw] = useState(MODES.NORMAL);
  const [focusedClusterIndex, setFocusedClusterIndex] = useState(0);
  const [savedGraphViewState, setSavedGraphViewState] = useState(null);

  const setSidebarMode = useCallback((mode, graphViewState) => {
    setSidebarModeRaw((prev) => {
      // When entering expanded mode, save the graph view state
      if (mode === MODES.EXPANDED && prev !== MODES.EXPANDED && graphViewState) {
        setSavedGraphViewState(graphViewState);
      }
      return mode;
    });
  }, []);

  // Cycle: normal → expanded → normal, or collapsed → normal
  const toggleExpand = useCallback((graphViewState) => {
    setSidebarModeRaw((prev) => {
      if (prev === MODES.NORMAL) {
        if (graphViewState) setSavedGraphViewState(graphViewState);
        return MODES.EXPANDED;
      }
      return MODES.NORMAL;
    });
  }, []);

  const toggleCollapse = useCallback(() => {
    setSidebarModeRaw((prev) => {
      if (prev === MODES.COLLAPSED) return MODES.NORMAL;
      return MODES.COLLAPSED;
    });
  }, []);

  return {
    sidebarMode,
    setSidebarMode,
    toggleExpand,
    toggleCollapse,
    focusedClusterIndex,
    setFocusedClusterIndex,
    savedGraphViewState,
  };
}
