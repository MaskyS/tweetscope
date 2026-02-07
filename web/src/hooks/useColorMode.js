import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'theme-preference';

// ── Shared module-level store ──────────────────────────────────────────────────
// All useColorMode() instances share a single preference via useSyncExternalStore.
// Previously each hook call had its own useState copy, so changing theme in
// ConfigurationPanel didn't update isDarkMode in DeckGLScatter (stale closure).

let _preference = (() => {
  try { return localStorage.getItem(STORAGE_KEY) || 'auto'; } catch { return 'auto'; }
})();

const _listeners = new Set();
const _notify = () => _listeners.forEach((l) => l());

function _subscribe(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

function _getSnapshot() {
  return _preference;
}

function _applyPreference(value) {
  if (value === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', value);
  }
  try { localStorage.setItem(STORAGE_KEY, value); } catch { /* ignore */ }
}

function _setPreference(valueOrFn) {
  const next = typeof valueOrFn === 'function' ? valueOrFn(_preference) : valueOrFn;
  if (next === _preference) return;
  _preference = next;
  _applyPreference(next);
  _notify();
}

// Apply on module load so the DOM attribute is correct before first render
_applyPreference(_preference);

// ── Hook ───────────────────────────────────────────────────────────────────────

export const useColorMode = () => {
  const themePreference = useSyncExternalStore(_subscribe, _getSnapshot);

  const [systemTheme, setSystemTheme] = useState(() => {
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  });

  // Watch for OS-level preference changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e) => setSystemTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const colorMode = themePreference === 'auto' ? systemTheme : themePreference;

  const setThemePreference = useCallback((valueOrFn) => {
    _setPreference(valueOrFn);
  }, []);

  const toggleColorMode = useCallback(() => {
    _setPreference((prev) => {
      if (prev === 'auto') return 'dark';
      if (prev === 'dark') return 'light';
      return 'auto';
    });
  }, []);

  return {
    colorMode,
    toggleColorMode,
    isDark: colorMode === 'dark',
    themePreference,
    setThemePreference,
  };
};
