/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] };

/*
 * The service worker. Four jobs:
 *  1. The app shell is precached, so the app opens with no network.
 *  2. API reads are network-first with a cached fallback (`bc-api`), so the library, the book and
 *     its notes are there offline.
 *  3. Book files are answered from per-edition caches (`bc-ed-<edition>`) filled by "save offline"
 *     or by opening a book; byte-range requests (audio seeking) are cut from the cached file.
 *  4. pdf.js's decoders, fonts and maps (/assets/pdfjs-<version>/) are answered from `bc-pdfjs`,
 *     where keeping a PDF puts them all (lib/pdf-resources.ts) and anything fetched is kept.
 * Writes never touch the cache: offline progress is queued in IndexedDB by the page.
 */

self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

const API_CACHE = 'bc-api';
const COVER_CACHE = 'bc-covers';
/** pdf.js's resources (lib/pdf-resources.ts PDFJS_CACHE): their path changes with pdf.js's version, so a kept copy is good for good. */
const PDFJS_CACHE = 'bc-pdfjs';
const NETWORK_TIMEOUT_MS = 4000;

let shell: ReturnType<typeof createHandlerBoundToURL> | null = null;
try {
  shell = createHandlerBoundToURL('/index.html');
} catch {
  shell = null;
}

function offlineJson(message: string): Response {
  return new Response(JSON.stringify({ error: { code: 'offline', message } }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function fromEditionCaches(request: Request): Promise<Response | undefined> {
  const names = (await caches.keys()).filter((n) => n.startsWith('bc-ed-'));
  for (const name of names) {
    const cache = await caches.open(name);
    const hit = await cache.match(request.url, { ignoreVary: true });
    if (hit) return hit;
  }
  return undefined;
}

/** Serve `Range: bytes=a-b` from a cached full response (media elements seek this way). */
async function rangeFrom(response: Response, rangeHeader: string): Promise<Response> {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  // A range we do not understand gets the whole file (its body is still unread).
  if (!m || (m[1] === '' && m[2] === '')) return response;
  const blob = await response.blob();
  const size = blob.size;
  let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] === '' ? size - 1 : m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  start = Math.max(0, start);
  end = Math.max(start, end);
  const headers = new Headers(response.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(blob.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}

async function media(request: Request): Promise<Response> {
  const cached = await fromEditionCaches(request);
  if (cached) {
    const range = request.headers.get('range');
    return range ? rangeFrom(cached, range) : cached;
  }
  const url = new URL(request.url);
  const isCover = /^\/media\/books\/[^/]+\/cover$/.test(url.pathname);
  const started = generation;
  try {
    const response = await fetch(request);
    // As for API answers: a cover fetched before a wipe is not kept after it.
    if (isCover && response.ok && started === generation) {
      const cache = await caches.open(COVER_CACHE);
      if (started === generation) void cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (isCover) {
      const hit = await caches.match(request, { cacheName: COVER_CACHE });
      if (hit) return hit;
    }
    return new Response(null, { status: 504, statusText: 'Offline' });
  }
}

/** A file pdf.js fetches (from its worker, as the page's): kept from the first time, answered from there for good. */
async function pdfjsResource(request: Request): Promise<Response> {
  const cached = await caches.match(request.url, { cacheName: PDFJS_CACHE });
  if (cached) return cached;
  const started = generation;
  try {
    const response = await fetch(request);
    if (response.ok && started === generation) {
      const cache = await caches.open(PDFJS_CACHE);
      if (started === generation) void cache.put(request.url, response.clone());
    }
    return response;
  } catch {
    return new Response(null, { status: 504, statusText: 'Offline' });
  }
}

/** Bumped by every wipe: an answer fetched before it must not be cached after it. */
let generation = 0;

/** Nobody is signed in on this device any more: forget every cached club file and answer. */
async function forgetEverything(): Promise<void> {
  generation++;
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith('bc-')).map((n) => caches.delete(n)));
}

async function signedOut(response: Response): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as { user?: unknown };
    return body.user === null;
  } catch {
    return false;
  }
}

async function apiRead(request: Request): Promise<Response> {
  const isSession = new URL(request.url).pathname === '/api/session';
  const started = generation;
  const network = fetch(request).then(async (response) => {
    if (isSession && response.ok && (await signedOut(response))) {
      await forgetEverything();
      return response;
    }
    if (started !== generation) return response;
    const cache = await caches.open(API_CACHE);
    if (response.ok) await cache.put(request, response.clone());
    else if (response.status === 401) {
      // Signed out elsewhere: forget what this device has.
      await cache.delete(request);
    }
    return response;
  });
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), NETWORK_TIMEOUT_MS));
  const cached = async () => (await caches.match(request, { cacheName: API_CACHE })) ?? (await fromEditionCaches(request));
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== 'timeout') return first;
    return (await cached()) ?? (await network);
  } catch {
    return (await cached()) ?? offlineJson('You are offline and this has not been saved on this device.');
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Uploads stream; signing in through the upstream account is a chain of redirects to follow live.
  if (url.pathname.startsWith('/api/uploads') || url.pathname.startsWith('/api/auth/')) return;
  if (url.pathname.startsWith('/media/')) {
    event.respondWith(media(request));
    return;
  }
  if (url.pathname.startsWith('/assets/pdfjs-')) {
    event.respondWith(pdfjsResource(request));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(apiRead(request));
    return;
  }
  if (request.mode === 'navigate' && shell) {
    const handle = shell;
    event.respondWith(fetch(request).catch(() => handle({ request, event, url })));
  }
});

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === 'wipe') event.waitUntil(forgetEverything());
});
