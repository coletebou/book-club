import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { BookDetail, Publication } from '@bookclub/shared';
import { browserAs, makeClub, putProgress, uploadBook } from '../helpers/api';

/**
 * Brief stretch 6: "a very long EPUB (War and Peace) opens quickly at a saved position". The book
 * is Project Gutenberg #2600 (WAR_AND_PEACE or .cache/downloads/war-and-peace/war-and-peace.epub).
 * Measured: ingest; then opening the reader at a place three quarters in, twice (the second time
 * the page counts are cached on the device): until the page is on screen, and until the
 * book-wide page numbers are there.
 */
const BOOK = process.env.WAR_AND_PEACE ?? path.resolve(import.meta.dirname, '../../.cache/downloads/war-and-peace/war-and-peace.epub');

async function openAndTime(page: Page, url: string) {
  const started = Date.now();
  await page.goto(url);
  const reader = page.getByTestId('reader');
  await expect(reader).not.toHaveAttribute('data-start', '', { timeout: 120_000 });
  const firstPage = Date.now() - started;
  // Turning a page while the pages are still being counted.
  let pageTurn: number | null = null;
  if ((await page.getByTestId('page-number').getAttribute('data-ready')) !== 'true') {
    const before = await reader.getAttribute('data-start');
    const tapped = Date.now();
    await page.getByTestId('next-page').click();
    await expect(reader).not.toHaveAttribute('data-start', before ?? '', { timeout: 10_000 });
    pageTurn = Date.now() - tapped;
  }
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 600_000 });
  const numbers = Date.now() - started;
  const label = await page.getByTestId('page-number').textContent();
  return { firstPage, pageTurn, numbers, label };
}

test('War and Peace opens at a saved place', async ({ browser }, info) => {
  const club = await makeClub([]);
  const ingestStart = Date.now();
  const book: BookDetail = await uploadBook(club.owner, club.id, 'epub', [{ name: 'war-and-peace.epub', path: BOOK, type: 'application/epub+zip', role: 'main' }], { title: 'War and Peace', author: 'Leo Tolstoy' });
  const ingest = Date.now() - ingestStart;
  const epub = book.editions[0]!;
  const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as Publication;
  // A saved place three quarters through the book.
  const target = Math.floor(pub.sections.length * 0.75);
  const place = { kind: 'epub' as const, section: target, offset: Math.floor(pub.sections[target]!.textLength / 2) };
  await putProgress(club.owner, book.id, epub.id, place, [{ from: { ...place, offset: 0 }, to: place }]);

  const ctx = await browserAs(browser, club.owner);
  const page = await ctx.newPage();
  const url = `/books/${book.id}/read?edition=${epub.id}`;
  const first = await openAndTime(page, url);
  expect(Number(await page.getByTestId('reader').getAttribute('data-section'))).toBe(target);
  const second = await openAndTime(page, url);
  // On a phone's network (Chromium can emulate one): 150 ms round trips, 9 Mbit/s down, on a
  // device that has not counted this book's pages yet (a fresh context).
  let slowNetwork: Awaited<ReturnType<typeof openAndTime>> | null = null;
  if (info.project.name.startsWith('chromium')) {
    const slowCtx = await browserAs(browser, club.owner);
    const slow = await slowCtx.newPage();
    const cdp = await slowCtx.newCDPSession(slow);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 });
    slowNetwork = await openAndTime(slow, url);
    await slowCtx.close();
  }
  const result = {
    project: info.project.name,
    sections: pub.sections.length,
    characters: pub.sections.reduce((n, s) => n + s.textLength, 0),
    ingestMs: ingest,
    firstOpen: first,
    secondOpen: second,
    slowNetwork,
  };
  console.log(JSON.stringify(result));
  mkdirSync(path.resolve(import.meta.dirname, '../reports'), { recursive: true });
  writeFileSync(path.resolve(import.meta.dirname, `../reports/perf-long-book-${info.project.name}.json`), JSON.stringify(result, null, 1));
  await ctx.close();
});
