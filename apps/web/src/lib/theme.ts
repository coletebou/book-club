import { useEffect, useState } from 'react';

/**
 * The app's own light/dark theme (D118), named after the manuscript palette: "vellum" (light) and
 * "lucerna" (lamplight, dark). "system" follows the device; the other two are the reader's choice,
 * saved under the same key /theme-init.js reads before first paint. Settings offers all three.
 */
export type AppTheme = 'system' | 'vellum' | 'lucerna';
/** What is actually painted: "system" resolves to one of these before it reaches the DOM. */
export type ResolvedTheme = 'vellum' | 'lucerna';

const KEY = 'bookclub:theme';

function systemTheme(): ResolvedTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'lucerna' : 'vellum';
}

/** The reader's saved choice, or "system" if none was saved (or storage is unavailable). */
export function loadTheme(): AppTheme {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'vellum' || raw === 'lucerna') return raw;
  } catch {
    // Storage disabled: behaves as "system" for this visit.
  }
  return 'system';
}

/** Paints `theme` on `<html>` right away (same effect as /theme-init.js, for a change made live). */
export function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme === 'system' ? systemTheme() : theme;
}

/** Saves the reader's choice (or clears it, for "system") and paints it immediately. */
export function saveTheme(theme: AppTheme): void {
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Storage full or disabled: the choice lasts for this visit (applyTheme still runs).
  }
  applyTheme(theme);
}

/**
 * The reader's theme choice, live: changes with `saveTheme` in this tab, and with the system's
 * light/dark switch while the choice is "system" (a settings page open in two tabs need not agree
 * with each other, only with what each tab's own `<html>` shows).
 */
export function useAppTheme(): [AppTheme, (theme: AppTheme) => void] {
  const [theme, setTheme] = useState<AppTheme>(() => loadTheme());
  useEffect(() => {
    if (theme !== 'system' || typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);
  return [
    theme,
    (next: AppTheme) => {
      saveTheme(next);
      setTheme(next);
    },
  ];
}
