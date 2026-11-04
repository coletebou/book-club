import { useEffect, useState } from 'react';

/**
 * Calls `back` whenever the browser says the network is back, or the page is seen again while it
 * has one (a phone wakes a page it put to sleep in the background), until the function returned
 * is called. What waits for the connection goes on then, instead of waiting out its back-off.
 */
export function onConnectionBack(back: () => void): () => void {
  const online = () => back();
  const seen = () => {
    if (document.visibilityState === 'visible' && navigator.onLine !== false) back();
  };
  window.addEventListener('online', online);
  document.addEventListener('visibilitychange', seen);
  return () => {
    window.removeEventListener('online', online);
    document.removeEventListener('visibilitychange', seen);
  };
}

/** Whether the browser has a network, as it tells the page (the header's Offline chip, your own status). */
export function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
