/** Register the service worker (app shell, offline books, progress outbox replay). */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err: unknown) => {
      console.warn('service worker registration failed', err);
    });
  });
}

/** Resolves once a service worker controls this page (or after a timeout). */
export async function serviceWorkerReady(timeoutMs = 5000): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  if (navigator.serviceWorker.controller) return true;
  return Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

/**
 * Run once when a service worker first takes control of this page. A first visit is fetched
 * before that, straight from the network, so none of it was kept for offline use: what the page
 * shows is fetched again, through the worker, which keeps it.
 */
export function onFirstControl(run: () => void): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || navigator.serviceWorker.controller) return;
  navigator.serviceWorker.addEventListener('controllerchange', run, { once: true });
}
