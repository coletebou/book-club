import { useId, useState } from 'react';
import { isNativeApp } from '../player/native-bridge';
import { Icon } from './Icon';

const HIDDEN_KEY = 'bookclub:install-hint';

/** An iPhone or an iPad (an iPad's Safari says it is a Mac, but no Mac has a touch screen). */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/**
 * Opened from the Home Screen already (or installed some other way), or the real thing already
 * (the iOS app's WebView, D131): nothing to suggest.
 */
export function runningInstalled(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    isNativeApp()
  );
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === 'hidden';
  } catch {
    return false;
  }
}

/**
 * On an iPhone, in the browser: how to put the club on the Home Screen, where it opens full
 * screen like an app (iOS has no install button of its own to offer). Once dismissed, it does not
 * come back on this device.
 */
export function InstallHint() {
  const titleId = useId();
  const [shown, setShown] = useState(() => isIos(navigator.userAgent, navigator.maxTouchPoints) && !runningInstalled() && !dismissed());
  if (!shown) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(HIDDEN_KEY, 'hidden');
    } catch {
      // no storage: hidden until the next visit
    }
    setShown(false);
  };
  return (
    <aside className="notice install-hint" aria-labelledby={titleId} data-testid="install-hint">
      <Icon name="share" size={22} />
      <p>
        <strong id={titleId}>Keep the club on your Home Screen.</strong> Tap Share, then “Add to Home Screen”: it opens full screen like an app, and the books
        you keep there read offline. (There it starts afresh: you sign in once more, and the books you open there are kept there.)
      </p>
      <button type="button" className="btn btn-small" onClick={dismiss}>
        Got it
      </button>
    </aside>
  );
}
