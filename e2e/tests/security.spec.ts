import { expect, request, test } from '@playwright/test';
import { BASE, browserAs, clubWithAlice, makeOutsider, postComment } from '../helpers/api';

test.describe('an outsider is denied everything of a club they are not in', () => {
  test('pages, API, files, covers, comments and progress all refuse an outsider', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny', pdf: true });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const comment = await postComment(club.owner, book.id, { editionId: epub.id, locator: { kind: 'epub', section: 3, offset: 10 }, text: 'members only' });
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { baseUrl: string; sections: { href: string }[] };
    const section = `${pub.baseUrl}${pub.sections[3]!.href}`;
    const outsider = await makeOutsider();

    const reads = [
      `/api/clubs/${club.id}`,
      `/api/clubs/${club.id}/books`,
      `/api/books/${book.id}`,
      `/api/books/${book.id}/comments`,
      `/api/books/${book.id}/progress`,
      epub.publicationUrl!,
      section,
      book.coverUrl,
      pdf.fileUrl!,
      audio.tracks[0]!.url,
    ];
    for (const url of reads) {
      const res = await outsider.api.get(url);
      expect(res.status(), url).toBe(404);
      expect(await res.text(), url).not.toContain('members only');
    }
    const writes: [string, string, unknown][] = [
      ['post', `/api/books/${book.id}/comments`, { editionId: epub.id, locator: { kind: 'epub', section: 1, offset: 0 }, text: 'hi' }],
      ['put', `/api/books/${book.id}/progress`, { editionId: epub.id, locator: { kind: 'epub', section: 1, offset: 0 }, readSpans: [], at: Date.now() }],
      ['delete', `/api/comments/${comment.id}`, undefined],
      ['delete', `/api/books/${book.id}`, undefined],
      ['post', `/api/clubs/${club.id}/imports`, { kind: 'epub', files: [{ name: 'x.epub', size: 10, type: 'application/epub+zip', role: 'main' }] }],
    ];
    for (const [method, url, data] of writes) {
      const res = await outsider.api.fetch(url, { method, ...(data ? { data } : {}) });
      expect(res.status(), `${method} ${url}`).toBe(404);
    }
    // The comment and the book are untouched.
    expect((await club.owner.api.get(`/api/books/${book.id}/comments`)).status()).toBe(200);

    // In the browser, the outsider sees "not found", never the book.
    const ctx = await browserAs(browser, outsider);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await expect(page.getByRole('heading', { name: 'Book not found' })).toBeVisible();
    await page.goto(`/books/${book.id}/read`);
    await expect(page.getByRole('heading', { name: 'This book is not available' })).toBeVisible();
    await page.goto(`/clubs/${club.id}`);
    await expect(page.getByRole('heading', { name: 'Club not found' })).toBeVisible();
    await ctx.close();
  });

  test('without a session, every book file and API read answers 401', async () => {
    const { book } = await clubWithAlice([], { audio: 'tiny' });
    const anon = await request.newContext({ baseURL: BASE });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    for (const url of [`/api/books/${book.id}`, `/api/books/${book.id}/comments`, epub.publicationUrl!, book.coverUrl, book.editions.find((e) => e.kind === 'audio')!.tracks[0]!.url]) {
      expect((await anon.get(url)).status(), url).toBe(401);
    }
    await anon.dispose();
  });

  test('a cross-site request with a member’s cookies is refused', async () => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const res = await club.owner.api.post(`/api/books/${book.id}/comments`, {
      headers: { origin: 'https://evil.example' },
      data: { editionId: epub.id, locator: { kind: 'epub', section: 1, offset: 0 }, text: 'csrf' },
    });
    expect(res.status()).toBe(403);
  });

  test('book files are only ever privately cacheable', async () => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { baseUrl: string; sections: { href: string }[] };
    for (const url of [`${pub.baseUrl}${pub.sections[2]!.href}`, book.coverUrl, book.editions.find((e) => e.kind === 'audio')!.tracks[0]!.url]) {
      const res = await club.owner.api.get(url);
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toMatch(/^private/);
      expect(res.headers()['cache-control']).not.toContain('public');
      expect(res.headers()['cross-origin-resource-policy']).toBe('same-origin');
    }
  });

  test('book content cannot run script: sections carry a CSP with no script source', async () => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { baseUrl: string; sections: { href: string }[] };
    const res = await club.owner.api.get(`${pub.baseUrl}${pub.sections[2]!.href}`);
    const csp = res.headers()['content-security-policy']!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/script-src/);
    expect(await res.text()).not.toMatch(/<script/i);
  });
});
