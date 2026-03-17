import {
  startTransition,
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  memo,
} from 'react';
import PropTypes from 'prop-types';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight } from 'lucide-react';
import TopicListSidebar from './TopicListSidebar';
import FeedColumn from './FeedColumn';
import ThreadOverlay from './ThreadOverlay';
import { recordFeedCarouselDebug } from '../../../../lib/feedCarouselDebug';
import { DEFAULT_SORT_DIRECTIONS, sortClusters } from '../../../../lib/sortClusters';
import {
  FEED_CAROUSEL_COLUMN_WIDTH,
  FEED_CAROUSEL_GAP,
  FEED_CAROUSEL_LIST_WIDTH,
  getClosestSortedIndex,
  getPrefetchOriginalIndices,
  getSnapTargetForScrollLeft,
  getScrollTargetForColumn,
  getSpacerWidth,
  getTrackOffset,
} from './feedCarouselVirtualization';
import styles from './FeedCarousel.module.scss';

const PROGRAMMATIC_SCROLL_TOLERANCE = 8;
const MANUAL_SCROLL_IDLE_DELAY = 180;
const DEFAULT_VIEWPORT_WIDTH =
  typeof window === 'undefined' ? FEED_CAROUSEL_COLUMN_WIDTH : window.innerWidth;
const VIRTUALIZER_OVERSCAN = 2;

const EMPTY_TWEETS = [];

function FeedCarousel({
  topLevelClusters,
  columnData,
  columnRowsMap,
  loadMore,
  ensureColumnsLoaded,
  activeSubClusters,
  setSubClusterFilter,
  dataset,
  clusterMap,
  focusedClusterIndex,
  onFocusedIndexChange,
  nodeStats,
  onViewQuotes,
  subNavProps,
}) {
  const containerRef = useRef(null);
  const tocContainerRef = useRef(null);
  const scrollRafRef = useRef(null);
  const lastToCPointerRef = useRef({ x: null, y: null });
  const latestScrollLeftRef = useRef(0);
  const [carouselGeometry, setCarouselGeometry] = useState({
    paddingLeft: 0,
    viewportWidth: DEFAULT_VIEWPORT_WIDTH,
  });
  const [overlayTweetId, setOverlayTweetId] = useState(null);
  const [overlayLsIndex, setOverlayLsIndex] = useState(null);
  const [isListScrolledOff, setIsListScrolledOff] = useState(false);
  const [isToCRevealed, setIsToCRevealed] = useState(false);
  const [isPinnedAfterToCAction, setIsPinnedAfterToCAction] = useState(false);
  const [sortMode, setSortMode] = useState('popular');
  const [sortDirection, setSortDirection] = useState(DEFAULT_SORT_DIRECTIONS.popular);
  const [visualSortedIndex, setVisualSortedIndex] = useState(0);
  const hasInitialScrollSyncRef = useRef(false);
  const isListScrolledOffRef = useRef(false);
  const isToCRevealedRef = useRef(false);
  const manualSnapPendingRef = useRef(false);

  // ── Sticky ToC state ──
  const isHoveringStickyToCRef = useRef(false);
  const isPinnedAfterToCActionRef = useRef(false);
  const isProgrammaticScrollRef = useRef(false);
  const shouldHideToCAfterProgrammaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef(null);
  const programmaticScrollReasonRef = useRef(null);
  const programmaticTargetLeftRef = useRef(null);

  // Keep the sticky shell mounted for the whole "scrolled away from start"
  // state. Only the shell's visual exposure changes; otherwise hiding the ToC
  // can perturb browser scroll/focus behavior and jerk the carousel sideways.
  const isToCStickyShell = isListScrolledOff;
  const isToCStickyVisible = isListScrolledOff && (isToCRevealed || isPinnedAfterToCAction);

  const setIsListScrolledOffIfChanged = useCallback((nextValue) => {
    const normalized = Boolean(nextValue);
    if (isListScrolledOffRef.current === normalized) return;
    isListScrolledOffRef.current = normalized;
    setIsListScrolledOff(normalized);
  }, []);

  const setIsToCRevealedIfChanged = useCallback((nextValue) => {
    const normalized = Boolean(nextValue);
    if (isToCRevealedRef.current === normalized) return;
    isToCRevealedRef.current = normalized;
    setIsToCRevealed(normalized);
  }, []);

  const setVisualSortedIndexIfChanged = useCallback((nextValue, { defer = false } = {}) => {
    const normalized = Number.isFinite(nextValue) ? Math.max(0, Math.trunc(nextValue)) : 0;
    const commit = () => {
      setVisualSortedIndex((current) => (current === normalized ? current : normalized));
    };

    if (defer) {
      startTransition(commit);
      return;
    }

    commit();
  }, []);

  const clearLastToCPointer = useCallback(() => {
    lastToCPointerRef.current = { x: null, y: null };
  }, []);

  const updateLastToCPointer = useCallback((event) => {
    if (!event) return;
    lastToCPointerRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
  }, []);

  const isPointerWithinStickyToC = useCallback(() => {
    const tocEl = tocContainerRef.current;
    if (!tocEl || typeof document === 'undefined') return false;
    if (tocEl.matches(':hover')) return true;

    const { x, y } = lastToCPointerRef.current;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

    const hoveredEl = document.elementFromPoint(x, y);
    return Boolean(hoveredEl && tocEl.contains(hoveredEl));
  }, []);

  const revealToC = useCallback(() => {
    setIsToCRevealedIfChanged(true);
  }, [setIsToCRevealedIfChanged]);

  const clearToCReveal = useCallback(() => {
    if (tocContainerRef.current?.contains(document.activeElement)) {
      // Once the sticky ToC is no longer visually exposed, any focused control
      // inside it becomes an offscreen target. Browsers may then auto-scroll
      // the horizontal strip back toward the start to reveal that focused
      // element, so blur it before collapsing the sticky shell.
      document.activeElement.blur();
    }
    clearLastToCPointer();
    shouldHideToCAfterProgrammaticScrollRef.current = false;
    isHoveringStickyToCRef.current = false;
    isPinnedAfterToCActionRef.current = false;
    setIsPinnedAfterToCAction(false);
    setIsToCRevealedIfChanged(false);
  }, [clearLastToCPointer, setIsToCRevealedIfChanged]);

  const pinToCAfterAction = useCallback(() => {
    shouldHideToCAfterProgrammaticScrollRef.current = false;
    isPinnedAfterToCActionRef.current = true;
    setIsPinnedAfterToCAction(true);
    setIsToCRevealedIfChanged(true);
  }, [setIsToCRevealedIfChanged]);

  const handleToCMouseEnter = useCallback((event) => {
    updateLastToCPointer(event);
    if (!latestScrollLeftRef.current || latestScrollLeftRef.current <= 50) return;
    isHoveringStickyToCRef.current = true;
    setIsToCRevealedIfChanged(true);
  }, [setIsToCRevealedIfChanged, updateLastToCPointer]);

  const handleToCMouseMove = useCallback((event) => {
    updateLastToCPointer(event);
    if (!latestScrollLeftRef.current || latestScrollLeftRef.current <= 50) return;
    isHoveringStickyToCRef.current = true;
  }, [updateLastToCPointer]);

  const handleToCMouseLeave = useCallback(() => {
    if (!latestScrollLeftRef.current || latestScrollLeftRef.current <= 50) return;
    if (isProgrammaticScrollRef.current) {
      // Keep the sticky ToC mounted until the click-driven horizontal scroll
      // settles. Clearing reveal immediately changes the strip's snap/layout
      // state mid-flight, which can cause the browser to re-snap back to the
      // first column.
      clearLastToCPointer();
      shouldHideToCAfterProgrammaticScrollRef.current = true;
      isHoveringStickyToCRef.current = false;
      isPinnedAfterToCActionRef.current = false;
      setIsPinnedAfterToCAction(false);
      return;
    }
    clearToCReveal();
  }, [clearLastToCPointer, clearToCReveal]);

  const handleSortChange = useCallback(
    (nextSortMode) => {
      pinToCAfterAction();
      setSortMode(nextSortMode);
    },
    [pinToCAfterAction]
  );

  const handleSortDirectionToggle = useCallback(() => {
    pinToCAfterAction();
    setSortDirection((current) => (current === 'desc' ? 'asc' : 'desc'));
  }, [pinToCAfterAction]);

  const endProgrammaticScroll = useCallback((source, scrollLeft) => {
    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
      programmaticScrollTimerRef.current = null;
    }

    // Preserve the sticky ToC after a programmatic click-driven scroll if the
    // pointer is still physically over it, even if React enter/leave state
    // momentarily lags during the rerender/scroll sequence.
    const hoveredStickyToC = isHoveringStickyToCRef.current || isPointerWithinStickyToC();
    const shouldHideToCAfterProgrammaticScroll =
      shouldHideToCAfterProgrammaticScrollRef.current;
    shouldHideToCAfterProgrammaticScrollRef.current = false;
    isProgrammaticScrollRef.current = false;
    recordFeedCarouselDebug('programmatic-scroll-end', {
      source,
      reason: programmaticScrollReasonRef.current,
      targetLeft: programmaticTargetLeftRef.current,
      scrollLeft,
      hoveredStickyToC,
      pinnedAfterToCAction: isPinnedAfterToCActionRef.current,
      shouldHideToCAfterProgrammaticScroll,
    });
    programmaticScrollReasonRef.current = null;
    programmaticTargetLeftRef.current = null;

    if (hoveredStickyToC) {
      isHoveringStickyToCRef.current = true;
      setIsToCRevealedIfChanged(true);
      return;
    }

    if (!hoveredStickyToC) {
      clearToCReveal();
    }
  }, [clearToCReveal, isPointerWithinStickyToC, setIsToCRevealedIfChanged]);

  const beginProgrammaticScroll = useCallback((reason = 'unknown', targetLeft = null) => {
    isProgrammaticScrollRef.current = true;
    programmaticScrollReasonRef.current = reason;
    programmaticTargetLeftRef.current = targetLeft;

    const distance = targetLeft == null
      ? 0
      : Math.abs(targetLeft - latestScrollLeftRef.current);
    const timeoutMs = Math.max(600, Math.min(3000, 600 + distance * 0.12));

    recordFeedCarouselDebug('programmatic-scroll-begin', {
      reason,
      targetLeft,
      timeoutMs,
      scrollLeft: latestScrollLeftRef.current,
      focusedOriginal: focusedIndexRef.current,
    });
    manualSnapPendingRef.current = false;

    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
    }
    programmaticScrollTimerRef.current = setTimeout(() => {
      recordFeedCarouselDebug('programmatic-scroll-timeout', {
        reason: programmaticScrollReasonRef.current,
        targetLeft: programmaticTargetLeftRef.current,
        scrollLeft: latestScrollLeftRef.current,
      });
      endProgrammaticScroll('timeout', latestScrollLeftRef.current);
    }, timeoutMs);
  }, [endProgrammaticScroll]);

  // ── Sort clusters: produces sorted array + index mappings ──
  const { sortedClusters, sortToOriginal, originalToSort } = useMemo(
    () => sortClusters(topLevelClusters, sortMode, sortDirection),
    [topLevelClusters, sortDirection, sortMode]
  );

  // ── Focused index in both spaces ──
  const normalizedFocusedIndex = Number.isFinite(focusedClusterIndex)
    ? Math.trunc(focusedClusterIndex)
    : 0;
  const clampedFocusedIndex = topLevelClusters.length > 0
    ? Math.min(Math.max(normalizedFocusedIndex, 0), topLevelClusters.length - 1)
    : 0;
  const sortedFocusedIndex = originalToSort[clampedFocusedIndex] ?? 0;

  const focusedIndexRef = useRef(clampedFocusedIndex); // original space
  focusedIndexRef.current = clampedFocusedIndex;

  // Stable ref for sortToOriginal so scroll handler doesn't stale-close
  const sortToOriginalRef = useRef(sortToOriginal);
  sortToOriginalRef.current = sortToOriginal;

  useEffect(() => {
    if (!sortedClusters.length) {
      setVisualSortedIndexIfChanged(0);
      return;
    }

    if (!isProgrammaticScrollRef.current) {
      setVisualSortedIndexIfChanged(sortedFocusedIndex);
    }
  }, [setVisualSortedIndexIfChanged, sortedClusters.length, sortedFocusedIndex]);

  const getClusterDebugMeta = useCallback(
    (originalIdx, sortedIdx = originalToSort[originalIdx]) => {
      const originalCluster = Number.isInteger(originalIdx) ? topLevelClusters[originalIdx] : null;
      const sortedCluster = Number.isInteger(sortedIdx) ? sortedClusters[sortedIdx] : null;
      const cluster = originalCluster || sortedCluster;

      return {
        originalIdx,
        sortedIdx,
        clusterId: cluster?.cluster ?? null,
        label: cluster?.label ?? null,
      };
    },
    [originalToSort, sortedClusters, topLevelClusters]
  );

  const emitFocusedIndexChange = useCallback(
    (source, originalIdx, extra = {}) => {
      recordFeedCarouselDebug('focus-change', {
        source,
        ...getClusterDebugMeta(originalIdx),
        currentFocusedOriginal: focusedIndexRef.current,
        scrollLeft: latestScrollLeftRef.current,
        ...extra,
      });
      if (source === 'scroll-center') {
        startTransition(() => {
          onFocusedIndexChange(originalIdx);
        });
        return;
      }

      onFocusedIndexChange(originalIdx);
    },
    [getClusterDebugMeta, onFocusedIndexChange]
  );

  const measureCarouselGeometry = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const computedStyle = window.getComputedStyle(container);
    const nextPaddingLeft = Number.parseFloat(computedStyle.paddingLeft) || 0;
    const nextViewportWidth = container.clientWidth || window.innerWidth;

    setCarouselGeometry((prev) => {
      if (prev.paddingLeft === nextPaddingLeft && prev.viewportWidth === nextViewportWidth) {
        return prev;
      }
      return {
        paddingLeft: nextPaddingLeft,
        viewportWidth: nextViewportWidth,
      };
    });
  }, []);

  const spacerWidth = useMemo(() => {
    return getSpacerWidth(carouselGeometry);
  }, [carouselGeometry]);

  const trackOffset = useMemo(() => getTrackOffset(carouselGeometry), [carouselGeometry]);

  const settleScrollToNearestColumn = useCallback(
    (reason = 'manual-scroll-idle') => {
      const container = containerRef.current;
      if (!container || !sortedClusters.length || isProgrammaticScrollRef.current) {
        manualSnapPendingRef.current = false;
        return;
      }

      manualSnapPendingRef.current = false;

      const currentLeft = container.scrollLeft;
      const { sortedIndex, scrollLeft: targetLeft } = getSnapTargetForScrollLeft(
        currentLeft,
        carouselGeometry,
        sortedClusters.length
      );

      setVisualSortedIndexIfChanged(sortedIndex);

      if (Math.abs(currentLeft - targetLeft) <= PROGRAMMATIC_SCROLL_TOLERANCE) {
        return;
      }

      const originalIdx = sortToOriginalRef.current[sortedIndex];
      recordFeedCarouselDebug('manual-snap', {
        reason,
        currentLeft,
        targetLeft,
        ...getClusterDebugMeta(originalIdx, sortedIndex),
      });

      if (originalIdx !== undefined && originalIdx !== focusedIndexRef.current) {
        emitFocusedIndexChange(reason, originalIdx, {
          currentLeft,
          targetLeft,
          sortedIndex,
        });
      }

      beginProgrammaticScroll(reason, targetLeft);
      latestScrollLeftRef.current = targetLeft;
      setIsListScrolledOffIfChanged(targetLeft > 50);
      container.scrollTo({
        left: targetLeft,
        behavior: 'smooth',
      });
    },
    [
      beginProgrammaticScroll,
      carouselGeometry,
      emitFocusedIndexChange,
      getClusterDebugMeta,
      setIsListScrolledOffIfChanged,
      setVisualSortedIndexIfChanged,
      sortedClusters.length,
    ]
  );

  const columnVirtualizer = useVirtualizer({
    count: sortedClusters.length,
    horizontal: true,
    getScrollElement: () => containerRef.current,
    estimateSize: () => FEED_CAROUSEL_COLUMN_WIDTH,
    gap: FEED_CAROUSEL_GAP,
    overscan: VIRTUALIZER_OVERSCAN,
    getItemKey: (index) => sortedClusters[index]?.cluster ?? index,
    scrollMargin: trackOffset,
    isScrollingResetDelay: MANUAL_SCROLL_IDLE_DELAY,
    onChange: (_, sync) => {
      if (sync || isProgrammaticScrollRef.current || !manualSnapPendingRef.current) return;
      settleScrollToNearestColumn();
    },
  });

  const virtualItems = columnVirtualizer.getVirtualItems();

  useLayoutEffect(() => {
    measureCarouselGeometry();
  }, [measureCarouselGeometry]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        measureCarouselGeometry();
      });
      resizeObserver.observe(container);
    }

    window.addEventListener('resize', measureCarouselGeometry);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measureCarouselGeometry);
    };
  }, [measureCarouselGeometry]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      manualSnapPendingRef.current = false;
      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // Reset sticky-ToC reveal state when the user is genuinely back at the
    // strip start. Do not clear it while a click-driven scroll is leaving the
    // start, otherwise the ToC can collapse before the sticky shell takes over.
    if (!isListScrolledOff && !isProgrammaticScrollRef.current) {
      clearToCReveal();
    }
  }, [clearToCReveal, isListScrolledOff]);

  useEffect(() => {
    if (!isToCRevealed) return undefined;

    const viewportHeight = window.innerHeight;

    const handlePointerMove = (event) => {
      // Don't collapse the sticky ToC while a click-triggered horizontal scroll
      // is still settling. Changing reveal state here mutates the strip layout
      // and can force the browser to re-snap to the start.
      if (isProgrammaticScrollRef.current) return;
      if (isHoveringStickyToCRef.current || isPinnedAfterToCActionRef.current) return;
      if (
        event.clientX > FEED_CAROUSEL_LIST_WIDTH ||
        event.clientY < 0 ||
        event.clientY > viewportHeight
      ) {
        setIsToCRevealedIfChanged(false);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    return () => window.removeEventListener('pointermove', handlePointerMove);
  }, [isToCRevealed, setIsToCRevealedIfChanged]);

  // scrollend listener — clears programmatic flag (supersedes fallback timeout)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScrollEnd = () => {
      if (!isProgrammaticScrollRef.current) return;
      endProgrammaticScroll('scrollend', el.scrollLeft);
    };
    el.addEventListener('scrollend', onScrollEnd);
    return () => el.removeEventListener('scrollend', onScrollEnd);
  }, [endProgrammaticScroll]);

  useEffect(() => {
    if (!topLevelClusters.length) return;
    if (normalizedFocusedIndex !== clampedFocusedIndex) {
      emitFocusedIndexChange('clamp-focused-index', clampedFocusedIndex, {
        normalizedFocusedIndex,
      });
    }
  }, [normalizedFocusedIndex, clampedFocusedIndex, emitFocusedIndexChange, topLevelClusters.length]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    latestScrollLeftRef.current = containerRef.current.scrollLeft;
    if (scrollRafRef.current !== null) return;

    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const scrollLeft = latestScrollLeftRef.current;
      const nextIsScrolledOff = scrollLeft > 50;
      setIsListScrolledOffIfChanged(nextIsScrolledOff);

      const closestSortedIndex = getClosestSortedIndex(
        scrollLeft,
        carouselGeometry,
        sortedClusters.length
      );
      setVisualSortedIndexIfChanged(closestSortedIndex, { defer: true });

      if (
        !isProgrammaticScrollRef.current &&
        !isHoveringStickyToCRef.current &&
        !isPinnedAfterToCActionRef.current &&
        nextIsScrolledOff
      ) {
        setIsToCRevealedIfChanged(false);
      }

      // Don't let the scroll listener rewrite focus while an entry/sort/click
      // scroll is still settling; otherwise the virtualized window can "walk"
      // focus away from the intended column.
      if (isProgrammaticScrollRef.current) {
        const targetLeft = programmaticTargetLeftRef.current;
        if (
          targetLeft != null &&
          Math.abs(scrollLeft - targetLeft) <= PROGRAMMATIC_SCROLL_TOLERANCE
        ) {
          endProgrammaticScroll('target-reached', scrollLeft);
        }
        return;
      }

      manualSnapPendingRef.current = true;

      const closestOriginalIndex = sortToOriginalRef.current[closestSortedIndex];

      // Convert sorted index → original index for parent
      if (closestOriginalIndex !== undefined && closestOriginalIndex !== focusedIndexRef.current) {
        emitFocusedIndexChange('scroll-center', closestOriginalIndex, {
          scrollLeft,
          closestSortedIndex,
        });
      }
    });
  }, [
    carouselGeometry,
    emitFocusedIndexChange,
    endProgrammaticScroll,
    setIsListScrolledOffIfChanged,
    setIsToCRevealedIfChanged,
    setVisualSortedIndexIfChanged,
    sortedClusters.length,
  ]);

  const correctStartPositionIfNeeded = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    if (Math.abs(container.scrollLeft) <= PROGRAMMATIC_SCROLL_TOLERANCE) return true;

    latestScrollLeftRef.current = 0;
    setIsListScrolledOffIfChanged(false);
    container.scrollTo({
      left: 0,
      behavior: 'auto',
    });
    return false;
  }, [setIsListScrolledOffIfChanged]);

  const scrollToStart = useCallback(
    ({ behavior = 'auto', reason = 'unknown' } = {}) => {
      if (!containerRef.current) return;

      recordFeedCarouselDebug('scroll-to-start', {
        reason,
        behavior,
        currentLeft: containerRef.current.scrollLeft,
      });
      beginProgrammaticScroll(reason, 0);

      setVisualSortedIndexIfChanged(0);
      latestScrollLeftRef.current = 0;
      setIsListScrolledOffIfChanged(false);
      containerRef.current.scrollTo({
        left: 0,
        behavior,
      });

      // Some browsers re-anchor the newly mounted overflow container after the
      // expanded layout settles. Only re-apply the start position if the first
      // scroll write did not stick, otherwise we add extra work to the return
      // path for no user-facing gain.
      requestAnimationFrame(() => {
        if (correctStartPositionIfNeeded()) return;

        requestAnimationFrame(() => {
          correctStartPositionIfNeeded();
        });
      });
    },
    [
      beginProgrammaticScroll,
      correctStartPositionIfNeeded,
      setIsListScrolledOffIfChanged,
      setVisualSortedIndexIfChanged,
    ]
  );

  const performScrollToColumn = useCallback(
    (sortedIndex, { behavior = 'smooth', reason = 'unknown' } = {}) => {
      if (!containerRef.current || sortedIndex <= 0) return;

      const scrollTarget = getScrollTargetForColumn(sortedIndex, carouselGeometry);
      const originalIdx = sortToOriginalRef.current[sortedIndex];

      recordFeedCarouselDebug('scroll-to-column', {
        reason,
        behavior,
        targetLeft: scrollTarget,
        currentLeft: containerRef.current.scrollLeft,
        ...getClusterDebugMeta(originalIdx, sortedIndex),
      });

      beginProgrammaticScroll(reason, scrollTarget);

      latestScrollLeftRef.current = scrollTarget;
      setIsListScrolledOffIfChanged(scrollTarget > 50);
      columnVirtualizer.scrollToOffset(scrollTarget, {
        behavior,
      });
    },
    [
      beginProgrammaticScroll,
      carouselGeometry,
      columnVirtualizer,
      getClusterDebugMeta,
      setIsListScrolledOffIfChanged,
    ]
  );

  // scrollToColumn takes a SORTED index
  const scrollToColumn = useCallback(
    (sortedIndex, options = {}) => {
      if (!containerRef.current) return;

      if (sortedIndex <= 0) {
        scrollToStart({
          ...options,
          behavior: options.behavior ?? 'smooth',
        });
        return;
      }

      setVisualSortedIndexIfChanged(sortedIndex);
      performScrollToColumn(sortedIndex, options);
    },
    [performScrollToColumn, scrollToStart, setVisualSortedIndexIfChanged]
  );

  useLayoutEffect(() => {
    if (!sortedClusters.length || !containerRef.current || hasInitialScrollSyncRef.current) return;

    const initialOriginalIndex = sortToOriginalRef.current[0] ?? 0;
    if (initialOriginalIndex !== focusedIndexRef.current) {
      setVisualSortedIndexIfChanged(0);
      emitFocusedIndexChange('initial-sync', initialOriginalIndex);
      return;
    }

    // First open of the expanded carousel should land at the start of the
    // current column sort: ToC fully visible, first sorted topic selected.
    hasInitialScrollSyncRef.current = true;
    scrollToStart({ behavior: 'auto' });
  }, [
    clampedFocusedIndex,
    emitFocusedIndexChange,
    scrollToStart,
    setVisualSortedIndexIfChanged,
    sortedClusters.length,
  ]);

  // Scroll to focused cluster when sort mode changes
  const prevSortKeyRef = useRef(`${sortMode}:${sortDirection}`);
  useEffect(() => {
    const nextSortKey = `${sortMode}:${sortDirection}`;
    if (prevSortKeyRef.current !== nextSortKey) {
      prevSortKeyRef.current = nextSortKey;
      requestAnimationFrame(() => {
        scrollToColumn(sortedFocusedIndex, { reason: 'sort-change' });
      });
    }
  }, [sortDirection, sortMode, sortedFocusedIndex, scrollToColumn]);

  // ── Sidebar click handlers ──
  // TopicListSidebar passes sorted indices; we convert to original for data ops

  const handleListClusterClick = useCallback(
    (sortedIdx) => {
      pinToCAfterAction();
      const originalIdx = sortToOriginalRef.current[sortedIdx];
      recordFeedCarouselDebug('toc-cluster-click', {
        ...getClusterDebugMeta(originalIdx, sortedIdx),
        currentFocusedOriginal: focusedIndexRef.current,
      });
      if (originalIdx !== undefined && originalIdx !== focusedIndexRef.current) {
        emitFocusedIndexChange('toc-cluster-click', originalIdx);
      }
      scrollToColumn(sortedIdx, { reason: 'toc-cluster-click' });
    },
    [emitFocusedIndexChange, getClusterDebugMeta, pinToCAfterAction, scrollToColumn]
  );

  const handleListSubClusterClick = useCallback(
    (sortedIdx, subClusterId) => {
      pinToCAfterAction();
      const originalIdx = sortToOriginalRef.current[sortedIdx];
      recordFeedCarouselDebug('toc-subcluster-click', {
        ...getClusterDebugMeta(originalIdx, sortedIdx),
        subClusterId,
        currentFocusedOriginal: focusedIndexRef.current,
      });
      if (originalIdx !== undefined && originalIdx !== focusedIndexRef.current) {
        emitFocusedIndexChange('toc-subcluster-click', originalIdx, { subClusterId });
      }
      scrollToColumn(sortedIdx, { reason: 'toc-subcluster-click' });
      if (originalIdx !== undefined) {
        setSubClusterFilter(originalIdx, subClusterId);
      }
    },
    [emitFocusedIndexChange, getClusterDebugMeta, pinToCAfterAction, scrollToColumn, setSubClusterFilter]
  );


  // FeedColumn's onSubClusterSelect passes original index (columnIndex prop is original)
  const handleColumnSubClusterClick = useCallback(
    (originalIdx, subClusterId) => {
      setSubClusterFilter(originalIdx, subClusterId);
    },
    [setSubClusterFilter]
  );

  const handleOpenThreadOverlay = useCallback((lsIndex) => {
    const tid = nodeStats?.get(lsIndex)?.tweetId;
    if (!tid) return;
    setOverlayTweetId(tid);
    setOverlayLsIndex(lsIndex);
  }, [nodeStats]);

  const handleCloseThreadOverlay = useCallback(() => {
    setOverlayTweetId(null);
    setOverlayLsIndex(null);
  }, []);

  const getFocusState = (sortedIdx) => {
    const distance = Math.abs(sortedIdx - visualSortedIndex);
    if (distance === 0) return 'focused';
    if (distance <= 2) return 'adjacent';
    return 'far';
  };

  const visibleOriginalIndices = useMemo(
    () => getPrefetchOriginalIndices(virtualItems, sortToOriginal, sortedClusters.length),
    [sortToOriginal, sortedClusters.length, virtualItems]
  );
  const visibleOriginalIndicesKey = useMemo(
    () => visibleOriginalIndices.join(','),
    [visibleOriginalIndices]
  );

  useEffect(() => {
    if (!visibleOriginalIndicesKey) return;
    ensureColumnsLoaded?.(visibleOriginalIndices);
  }, [ensureColumnsLoaded, visibleOriginalIndices, visibleOriginalIndicesKey]);

  if (!topLevelClusters?.length) {
    return (
      <div className={styles.emptyCarousel}>
        <p>No hierarchical clusters available for carousel view.</p>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div ref={containerRef} className={styles.carousel} onScroll={handleScroll}>
        <TopicListSidebar
          containerRef={tocContainerRef}
          topLevelClusters={sortedClusters}
          focusedIndex={sortedFocusedIndex}
          onClickCluster={handleListClusterClick}
          onClickSubCluster={handleListSubClusterClick}
          sortMode={sortMode}
          onSortChange={handleSortChange}
          sortDirection={sortDirection}
          onSortDirectionToggle={handleSortDirectionToggle}
          isStickyShell={isToCStickyShell}
          isStickyVisible={isToCStickyVisible}
          onMouseEnter={handleToCMouseEnter}
          onMouseMove={handleToCMouseMove}
          onMouseLeave={handleToCMouseLeave}
          subNavProps={subNavProps}
        />

        <div
          style={{
            width: columnVirtualizer.getTotalSize(),
            height: '100%',
            position: 'relative',
            flexShrink: 0,
            marginLeft: spacerWidth,
          }}
        >
          {virtualItems.map((item) => {
            const sortedIdx = item.index;
            const cluster = sortedClusters[sortedIdx];
            const originalIdx = sortToOriginal[sortedIdx];
            const col = columnData[originalIdx] || {};
            const tweets = columnRowsMap[originalIdx] || EMPTY_TWEETS;

            if (!cluster || originalIdx === undefined) {
              return null;
            }

            return (
              <div
                key={item.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  display: 'flex',
                  width: FEED_CAROUSEL_COLUMN_WIDTH,
                  height: '100%',
                  minHeight: 0,
                  transform: `translateX(${item.start - trackOffset}px)`,
                }}
              >
                <FeedColumn
                  columnIndex={originalIdx}
                  cluster={cluster}
                  tweets={tweets}
                  focusState={getFocusState(sortedIdx)}
                  columnWidth={FEED_CAROUSEL_COLUMN_WIDTH}
                  subClusters={cluster.children}
                  activeSubCluster={activeSubClusters[originalIdx] || null}
                  onSubClusterSelect={handleColumnSubClusterClick}
                  dataset={dataset}
                  clusterMap={clusterMap}
                  loading={col.loading}
                  hasMore={col.hasMore}
                  onLoadMore={loadMore}
                  nodeStats={nodeStats}
                  onViewThread={handleOpenThreadOverlay}
                  onViewQuotes={onViewQuotes}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Left-edge hover zone with visible tab indicator */}
      {!isToCStickyVisible && isListScrolledOff && (
        <div
          className={styles.hoverZone}
          onMouseEnter={revealToC}
        >
          <div className={styles.hoverTab}>
            <ChevronRight size={14} />
          </div>
        </div>
      )}

      <ThreadOverlay
        open={!!overlayTweetId}
        dataset={dataset}
        tweetId={overlayTweetId}
        currentLsIndex={overlayLsIndex}
        nodeStats={nodeStats}
        clusterMap={clusterMap}
        onClose={handleCloseThreadOverlay}
        onViewThread={handleOpenThreadOverlay}
        onViewQuotes={onViewQuotes}
      />
    </div>
  );
}

FeedCarousel.propTypes = {
  topLevelClusters: PropTypes.array.isRequired,
  columnData: PropTypes.object.isRequired,
  columnRowsMap: PropTypes.object.isRequired,
  loadMore: PropTypes.func,
  ensureColumnsLoaded: PropTypes.func,
  activeSubClusters: PropTypes.object.isRequired,
  setSubClusterFilter: PropTypes.func.isRequired,
  dataset: PropTypes.object,
  clusterMap: PropTypes.object,
  focusedClusterIndex: PropTypes.number,
  onFocusedIndexChange: PropTypes.func.isRequired,
  nodeStats: PropTypes.shape({
    get: PropTypes.func,
  }),
  onViewQuotes: PropTypes.func,
  subNavProps: PropTypes.shape({
    dataset: PropTypes.object,
    scope: PropTypes.object,
    scopes: PropTypes.array,
    onScopeChange: PropTypes.func,
    onBack: PropTypes.func,
  }),
};

export default memo(FeedCarousel);
