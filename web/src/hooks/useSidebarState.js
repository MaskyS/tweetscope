import { useState, useCallback } from 'react';

const MODES = {
  COLLAPSED: 'collapsed',
  NORMAL: 'normal',
  EXPANDED: 'expanded',
  THREAD: 'thread',
  QUOTES: 'quotes',
};

export { MODES as SIDEBAR_MODES };

export default function useSidebarState() {
  const [sidebarMode, setSidebarModeRaw] = useState(MODES.NORMAL);
  const [focusedClusterIndex, setFocusedClusterIndex] = useState(0);
  const [savedGraphViewState, setSavedGraphViewState] = useState(null);
  const [threadTargetIndex, setThreadTargetIndex] = useState(null);
  const [threadTargetTweetId, setThreadTargetTweetId] = useState(null);

  const setSidebarMode = useCallback((mode, graphViewState) => {
    setSidebarModeRaw((prev) => {
      // When entering expanded mode, save the graph view state
      if (mode === MODES.EXPANDED && prev !== MODES.EXPANDED && graphViewState) {
        setSavedGraphViewState(graphViewState);
      }
      return mode;
    });
  }, []);

  // Toggle between expanded and non-expanded modes.
  const toggleExpand = useCallback((graphViewState) => {
    setSidebarModeRaw((prev) => {
      if (prev === MODES.EXPANDED) {
        return MODES.NORMAL;
      }
      if (graphViewState) setSavedGraphViewState(graphViewState);
      return MODES.EXPANDED;
    });
  }, []);

  const toggleCollapse = useCallback(() => {
    setSidebarModeRaw((prev) => {
      if (prev === MODES.COLLAPSED) return MODES.NORMAL;
      return MODES.COLLAPSED;
    });
  }, []);

  const openThread = useCallback((lsIndex, tweetId, graphViewState) => {
    if (graphViewState) setSavedGraphViewState(graphViewState);
    setThreadTargetIndex(lsIndex);
    setThreadTargetTweetId(tweetId);
    setSidebarModeRaw(MODES.THREAD);
  }, []);

  const openQuotes = useCallback((lsIndex, tweetId, graphViewState) => {
    if (graphViewState) setSavedGraphViewState(graphViewState);
    setThreadTargetIndex(lsIndex);
    setThreadTargetTweetId(tweetId);
    setSidebarModeRaw(MODES.QUOTES);
  }, []);

  const closeThread = useCallback(() => {
    setThreadTargetIndex(null);
    setThreadTargetTweetId(null);
    setSidebarModeRaw(MODES.NORMAL);
  }, []);

  return {
    sidebarMode,
    setSidebarMode,
    toggleExpand,
    toggleCollapse,
    focusedClusterIndex,
    setFocusedClusterIndex,
    savedGraphViewState,
    threadTargetIndex,
    threadTargetTweetId,
    openThread,
    openQuotes,
    closeThread,
  };
}
