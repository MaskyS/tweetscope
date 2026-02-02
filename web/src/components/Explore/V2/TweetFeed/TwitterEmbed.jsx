import { useEffect, useRef, useState, memo } from 'react';
import PropTypes from 'prop-types';
import styles from './TwitterEmbed.module.scss';

// Track if widgets.js is loaded globally
let widgetsLoaded = false;
let widgetsLoading = false;
const loadCallbacks = [];

const WIDGETS_SCRIPT_SRC = 'https://platform.twitter.com/widgets.js';
const WIDGETS_SCRIPT_SELECTOR = 'script[data-twitter-widgets="true"]';
const WIDGETS_LOAD_TIMEOUT_MS = 15000;

function isWidgetsReady() {
  if (typeof window === 'undefined') return false;
  return !!(
    window.twttr &&
    window.twttr.widgets &&
    typeof window.twttr.widgets.createTweet === 'function'
  );
}

// Load Twitter widgets.js once
function loadWidgets() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(null);
  }
  if (widgetsLoaded && isWidgetsReady()) return Promise.resolve(window.twttr);
  if (isWidgetsReady()) {
    widgetsLoaded = true;
    return Promise.resolve(window.twttr);
  }

  if (widgetsLoading) {
    return new Promise((resolve) => {
      loadCallbacks.push(resolve);
    });
  }

  widgetsLoading = true;

  return new Promise((resolve) => {
    let settled = false;

    const finish = (twttr) => {
      if (settled) return;
      settled = true;
      widgetsLoaded = !!twttr && isWidgetsReady();
      widgetsLoading = false;
      resolve(twttr);
      loadCallbacks.forEach((cb) => cb(twttr));
      loadCallbacks.length = 0;
    };

    // Initialize twttr stub and queue the ready callback BEFORE the script loads.
    window.twttr = window.twttr || {};
    window.twttr._e = window.twttr._e || [];
    window.twttr.ready =
      window.twttr.ready ||
      function (f) {
        window.twttr._e.push(f);
      };

    const timeout = window.setTimeout(() => {
      finish(isWidgetsReady() ? window.twttr : null);
    }, WIDGETS_LOAD_TIMEOUT_MS);

    window.twttr.ready(() => {
      window.clearTimeout(timeout);
      finish(window.twttr);
    });

    const existing = document.querySelector(WIDGETS_SCRIPT_SELECTOR);
    if (existing) {
      // Script tag exists; rely on ready callback or timeout.
      return;
    }

    const script = document.createElement('script');
    script.src = WIDGETS_SCRIPT_SRC;
    script.async = true;
    script.charset = 'utf-8';
    script.setAttribute('data-twitter-widgets', 'true');

    script.onload = () => {
      // Some environments never fire twttr.ready; fall back to readiness check.
      if (!settled && isWidgetsReady()) {
        window.clearTimeout(timeout);
        finish(window.twttr);
      }
    };

    script.onerror = () => {
      window.clearTimeout(timeout);
      finish(null);
    };

    document.head.appendChild(script);
  });
}

// Extract tweet ID from various URL formats
function extractTweetId(url) {
  if (!url) return null;

  // Handle direct tweet ID
  if (/^\d+$/.test(url)) return url;

  // Handle twitter.com/x.com URLs
  const patterns = [
    /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/i,
    /(?:twitter\.com|x\.com)\/i\/web\/status\/(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

TwitterEmbed.propTypes = {
  tweetId: PropTypes.string,
  tweetUrl: PropTypes.string,
  theme: PropTypes.oneOf(['light', 'dark']),
  hideConversation: PropTypes.bool,
  hideMedia: PropTypes.bool,
  compact: PropTypes.bool,
  onLoad: PropTypes.func,
  onError: PropTypes.func,
};

function TwitterEmbed({
  tweetId,
  tweetUrl,
  theme = 'light',
  hideConversation = true,
  hideMedia = false,
  compact = false,
  onLoad,
  onError,
}) {
  const containerRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Resolve tweet ID from either prop
  const resolvedId = tweetId || extractTweetId(tweetUrl);

  useEffect(() => {
    console.log('[TwitterEmbed] Mounting with:', {
      tweetId,
      tweetUrl,
      resolvedId,
      tweetIdType: typeof tweetId,
      resolvedIdType: typeof resolvedId
    });

    if (!resolvedId || !containerRef.current) {
      setError('Invalid tweet ID or URL');
      setLoading(false);
      return;
    }

    let cancelled = false;
    const container = containerRef.current;

    // Clear previous content
    container.innerHTML = '';
    setLoading(true);
    setError(null);

    console.log('[TwitterEmbed] Calling createTweet with ID:', resolvedId);

    const EMBED_TIMEOUT_MS = 15000;

    loadWidgets().then((twttr) => {
      if (cancelled || !twttr) {
        if (!cancelled) {
          setError('Failed to load Twitter widgets');
          setLoading(false);
          onError?.();
        }
        return;
      }

      // Only specify non-default widget params. Invalid values can cause embeds to hang.
      const options = {
        theme,
        align: 'center',
        dnt: true, // Do not track
        ...(hideConversation ? { conversation: 'none' } : {}),
        ...(hideMedia ? { cards: 'hidden' } : {}),
      };

      const embedPromise = twttr.widgets?.createTweet?.(resolvedId, container, options);
      if (!embedPromise || typeof embedPromise.then !== 'function') {
        setError('Twitter widgets not ready');
        setLoading(false);
        onError?.();
        return;
      }

      const timeoutPromise = new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error('Embed timeout')), EMBED_TIMEOUT_MS);
      });

      Promise.race([embedPromise, timeoutPromise])
        .then((el) => {
          if (cancelled) return;
          setLoading(false);
          if (el) {
            onLoad?.();
          } else {
            setError('Tweet not found or unavailable');
            onError?.();
          }
        })
        .catch(() => {
          if (cancelled) return;
          setError('Failed to embed tweet');
          setLoading(false);
          onError?.();
        });
    });

    return () => {
      cancelled = true;
    };
  }, [resolvedId, theme, hideConversation, hideMedia, onLoad, onError]);

  if (!resolvedId) {
    return null;
  }

  return (
    <div className={`${styles.embedContainer} ${compact ? styles.compact : ''}`}>
      <div
        ref={containerRef}
        className={`${styles.tweetContainer} ${loading || error ? styles.tweetContainerHidden : ''}`}
      />
      {loading && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <span>Loading tweet...</span>
        </div>
      )}
      {error && !loading && (
        <div className={styles.errorState}>
          <span>{error}</span>
          {tweetUrl && (
            <a
              href={tweetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.fallbackLink}
            >
              View on X
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(TwitterEmbed);

// Export utility for preloading widgets
export { loadWidgets, extractTweetId };
