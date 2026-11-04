import { QueryClient } from '@tanstack/react-query';
import type { BookDetail, Edition, Publication, SessionInfo, Track } from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLocalData, db } from './db';
import { editionCacheName, editionUrls, isEditionOffline, keepOffline, removeEditionOffline, saveEditionOffline, wipeDevice } from './offline';
import { bindOutbox, flushOutbox, pendingCount, saveProgress } from './outbox';
import { PDFJS_CACHE } from './pdf-resources';
import { keys } from './queries';
import { PDFJS_FILES } from 'virtual:pdfjs-resources';

function edition(kind: Edition['kind'], over: Partial<Edition> = {}): Edition {
  return {
    id: `ed_${kind}_1`,
    kind,
    status: 'ready',
    error: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    addedBy: 'user_ana',
    sizeBytes: 1000,
    geometry: null,
    sync: null,
    alignment: { method: 'none', unitToChapter: [] },
    units: [],
    publicationUrl: null,
    fileUrl: null,
    tracks: [],
    durationMs: null,
    pageCount: null,
    readAlong: null,
    ...over,
  };
}

const book: BookDetail = {
  id: 'book_alice',
  clubId: 'club_123',
  title: 'Alice',
  author: 'Lewis Carroll',
  coverUrl: '/api/books/book_alice/cover?v=3',
  hasCover: true,
  kinds: ['epub', 'pdf', 'audio'],
  createdAt: '2026-10-20T10:00:00.000Z',
  addedBy: 'user_ana',
  commentCount: 0, meeting: null,
  progress: [],
  chapters: [],
  editions: [],
  referenceEditionId: null,
};

const always = ['/api/books/book_alice', '/api/books/book_alice/comments', '/api/books/book_alice/progress', '/api/books/book_alice/cover?v=3&w=320', '/api/books/book_alice/cover?v=3&w=640'];

describe('editionUrls (what a book needs to be read offline)', () => {
  it('for an EPUB: the book, its notes, my progress, the cover, the manifest and every file of the publication', () => {
    const epub = edition('epub', { publicationUrl: '/api/editions/ed_epub_1/publication' });
    const publication: Publication = {
      editionId: 'ed_epub_1',
      baseUrl: '/media/ed_epub_1/',
      title: 'Alice',
      author: 'Lewis Carroll',
      language: 'en',
      direction: 'ltr',
      sections: [],
      toc: [],
      story: { start: 0, end: 0 },
      resources: ['OEBPS/ch1.xhtml', 'OEBPS/images/a picture #1.jpg', 'OEBPS/style.css'],
    };
    expect(editionUrls(book, epub, publication)).toEqual([
      ...always,
      '/api/editions/ed_epub_1/publication',
      '/media/ed_epub_1/OEBPS/ch1.xhtml',
      '/media/ed_epub_1/OEBPS/images/a%20picture%20%231.jpg',
      '/media/ed_epub_1/OEBPS/style.css',
    ]);
    // Before the manifest is known, at least the manifest itself.
    expect(editionUrls(book, epub)).toEqual([...always, '/api/editions/ed_epub_1/publication']);
  });

  it('for a PDF: the file', () => {
    expect(editionUrls(book, edition('pdf', { fileUrl: '/media/ed_pdf_1/alice.pdf' }))).toEqual([...always, '/media/ed_pdf_1/alice.pdf']);
  });

  it('for an audiobook: every track', () => {
    const tracks: Track[] = [0, 1, 2].map((index) => ({ index, title: `Track ${index + 1}`, durationMs: 1000, url: `/media/ed_audio_1/t${index}.mp3`, mime: 'audio/mpeg', chapter: null }));
    expect(editionUrls(book, edition('audio', { tracks }))).toEqual([...always, '/media/ed_audio_1/t0.mp3', '/media/ed_audio_1/t1.mp3', '/media/ed_audio_1/t2.mp3']);
  });

  it('keeps each edition in its own cache', () => {
    expect(editionCacheName('ed_epub_1')).toBe('bc-ed-ed_epub_1');
    expect(editionCacheName('ed_epub_1')).not.toBe(editionCacheName('ed_pdf_1'));
  });
});

describe('saving books offline in a browser without Cache Storage', () => {
  beforeEach(async () => {
    await clearLocalData();
  });

  it('says it cannot, instead of pretending', async () => {
    expect('caches' in window).toBe(false);
    await expect(saveEditionOffline(book, edition('pdf', { fileUrl: '/f.pdf' }), null)).rejects.toThrow('This browser cannot keep books offline.');
    expect(await isEditionOffline('ed_pdf_1')).toBe(false);
  });

  it('still forgets an edition from the registry, and tells the app', async () => {
    await (await db()).put('offline', { editionId: 'ed_pdf_1', bookId: book.id, title: book.title, bytes: 10, savedAt: 1 });
    expect(await isEditionOffline('ed_pdf_1')).toBe(true);
    const changed = vi.fn();
    window.addEventListener('bc-offline-changed', changed);
    await removeEditionOffline('ed_pdf_1');
    window.removeEventListener('bc-offline-changed', changed);
    expect(await isEditionOffline('ed_pdf_1')).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe('wipeDevice (signing out of a shared phone)', () => {
  beforeEach(async () => {
    await clearLocalData();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forgets the person's unsent reading, places, pending uploads and resume points, and nothing else", async () => {
    const qc = new QueryClient();
    qc.setQueryData<SessionInfo>(keys.session, { user: { id: 'user_ana', displayName: 'Ana', email: null, color: '#FF6B6B', source: 'local' }, setupRequired: false, upstream: null });
    bindOutbox(qc);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await saveProgress({ bookId: book.id, editionId: 'ed_epub_1', locator: { kind: 'epub', section: 1, offset: 1 }, at: 1, spans: [] });
    await flushOutbox();
    expect(await pendingCount()).toBe(1);
    localStorage.setItem('bookclub:pending-import:club_123', '{}');
    localStorage.setItem('bookclub:reader-settings', '{}');
    localStorage.setItem('tus::bookclub-imp_abc123-0-10::x', '{}');
    localStorage.setItem('another-app:theme', 'dark');

    await wipeDevice();

    expect(await pendingCount()).toBe(0);
    expect(await (await db()).count('positions')).toBe(0);
    expect(Object.keys(localStorage)).toEqual(['another-app:theme']);
  });
});

describe('keeping a book on the device as it is opened', () => {
  /** Cache Storage in memory: jsdom has none. */
  const buckets = new Map<string, Map<string, Response>>();
  const fakeCaches = {
    open: (name: string) => {
      const bucket = buckets.get(name) ?? new Map<string, Response>();
      buckets.set(name, bucket);
      return Promise.resolve({
        match: (url: string) => Promise.resolve(bucket.get(url)),
        put: (url: string, res: Response) => Promise.resolve(void bucket.set(url, res)),
        keys: () => Promise.resolve([...bucket.keys()].map((url) => new Request(new URL(url, 'http://localhost')))),
        delete: (request: Request) => Promise.resolve(bucket.delete(new URL(request.url).pathname)),
      });
    },
    delete: (name: string) => Promise.resolve(buckets.delete(name)),
    keys: () => Promise.resolve([...buckets.keys()]),
  };
  const session = (id: string): SessionInfo => ({ user: { id, displayName: id, email: null, color: '#FF6B6B', source: 'local' }, setupRequired: false, upstream: null });
  const pdf = edition('pdf', { fileUrl: '/media/ed_pdf_1/alice.pdf' });

  beforeEach(async () => {
    await clearLocalData();
    buckets.clear();
    vi.stubGlobal('caches', fakeCaches);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads each file once, even when asked twice, and then lists the book as kept', async () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.session, session('user_ana'));
    bindOutbox(qc);
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(`body of ${url}`, { status: 200, headers: { 'content-length': '10' } })));
    vi.stubGlobal('fetch', fetchMock);
    const first = keepOffline(book, pdf, null);
    const second = keepOffline(book, pdf, null);
    expect(second).toBe(first);
    await first;
    // The PDF's own files, and once for every PDF, what pdf.js draws its pages with (fidelity review round 17).
    expect(fetchMock).toHaveBeenCalledTimes(editionUrls(book, pdf).length + PDFJS_FILES.length);
    expect(await isEditionOffline(pdf.id)).toBe(true);
    expect(buckets.get(editionCacheName(pdf.id))?.size).toBe(editionUrls(book, pdf).length);
    expect(buckets.get(PDFJS_CACHE)?.size).toBe(PDFJS_FILES.length);
    // Done: a later opening starts a new (quick) check rather than reusing the finished one.
    expect(keepOffline(book, pdf, null)).not.toBe(first);
  });

  it('keeps an EPUB without pdf.js’s resources, and a PDF only once they are kept too', async () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.session, session('user_ana'));
    bindOutbox(qc);
    const epub = edition('epub', { publicationUrl: '/api/editions/ed_epub_1/publication' });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('x', { status: 200 }))));
    await saveEditionOffline(book, epub, null);
    expect(buckets.has(PDFJS_CACHE)).toBe(false);
    // A decoder that cannot be fetched: the PDF is not listed as kept, for it would draw blank offline.
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response('x', { status: url.endsWith('.wasm') ? 503 : 200 }))));
    await expect(saveEditionOffline(book, pdf, null)).rejects.toThrow(/\.wasm \(503\)/);
    expect(await isEditionOffline(pdf.id)).toBe(false);
  });

  it('gives up, and keeps nothing, when someone else signs in while the book downloads', async () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.session, session('user_ana'));
    bindOutbox(qc);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        if (++calls === 2) qc.setQueryData(keys.session, session('user_ben'));
        return Promise.resolve(new Response('x', { status: 200 }));
      }),
    );
    await expect(saveEditionOffline(book, pdf, null)).rejects.toThrow('The signed-in person changed');
    expect(buckets.has(editionCacheName(pdf.id))).toBe(false);
    expect(await isEditionOffline(pdf.id)).toBe(false);
    // keepOffline swallows the same failure: the next opening tries again.
    qc.setQueryData(keys.session, session('user_ana'));
    calls = 0;
    await expect(keepOffline(book, pdf, null)).resolves.toBeUndefined();
  });
});
