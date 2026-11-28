import path from 'node:path';
import { expect, test } from '@playwright/test';
import { allowCal, FIXTURES, aliceEpub, browserAs, makeClub, putProgress, serverPlace, uploadBook } from '../helpers/api';

test('the reader’s Now Playing uses in-file chapters, speed and sleep, and Cal keeps the saved place during a look', async ({ browser }) => {
  const club = await makeClub([]);
  await allowCal(club.owner);
  const printed = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: 'A Tale in Three Chapters', author: 'Ada Tone' });
  const name = 'tale-in-three-chapters.m4b';
  const book = await uploadBook(club.owner, club.id, 'audio', [{ name, path: path.join(FIXTURES, 'audio/m4b', name), type: 'audio/mp4', role: 'track' }], { title: printed.title, author: printed.author, bookId: printed.id });
  const edition = book.editions.find((item) => item.kind === 'audio')!;
  expect(edition.tracks).toHaveLength(1);
  const saved = { kind: 'audio' as const, track: 0, ms: 1_000 };
  await putProgress(club.owner, book.id, edition.id, saved, []);
  const ctx = await browserAs(browser, club.owner, { serviceWorkers: 'block' });
  let releaseSave!: () => void;
  const holdSave = new Promise<void>((resolve) => { releaseSave = resolve; });

  try {
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('listen-here').click();
    const dock = page.getByRole('group', { name: /^Now playing:/ });
    await expect(dock.getByTestId('footer-play')).toHaveAttribute('data-playing', 'true');
    await dock.getByTestId('footer-play').click();
    await dock.getByTestId('dock-expand').click();
    const sheet = page.getByRole('dialog', { name: 'Now in this book' });
    const audio = page.getByTestId('audio-element');
    const position = () => audio.evaluate((element: HTMLAudioElement) => element.currentTime);
    await expect.poll(position).toBeLessThan(4);

    const next = sheet.getByRole('button', { name: 'Next chapter' });
    await next.click();
    await expect.poll(position).toBeCloseTo(4);
    await sheet.getByRole('button', { name: 'Previous chapter' }).click();
    await expect.poll(position).toBeCloseTo(0);
    await sheet.getByTestId('sheet-scrubber').fill('1');
    await expect.poll(() => serverPlace(page, book.id)).toEqual(saved);

    await sheet.getByTestId('speed').click();
    const speed = page.getByRole('dialog', { name: 'Playback speed' });
    await speed.getByTestId('speed-preset-1.25').click();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.25);
    await page.keyboard.press('Escape');
    await expect(speed).toHaveCount(0);
    const sleep = sheet.getByRole('combobox', { name: 'Sleep timer' });
    await sleep.selectOption('30');
    await expect(sleep).toHaveValue('on');
    await sleep.selectOption('off');
    await expect(sleep).toHaveValue('off');

    await sheet.getByRole('button', { name: 'Chapters', exact: true }).click();
    const chapterList = sheet.getByRole('region', { name: 'Chapters' });
    await expect(chapterList.getByRole('button')).toHaveCount(3);
    const last = chapterList.getByRole('button', { name: /The End/ });
    const progressUrl = `**/api/books/${book.id}/progress`;
    let unavailable = true;
    await page.route(progressUrl, async (route) => {
      if (route.request().method() === 'PUT') {
        if (unavailable) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
        await holdSave;
      }
      await route.continue();
    });
    await last.click();
    await expect.poll(position).toBeCloseTo(8);
    await expect(last).toHaveAttribute('aria-current', 'true');
    expect(await serverPlace(page, book.id)).toEqual(saved);

    const ask = sheet.getByRole('button', { name: 'Ask Cal', exact: true });
    const cal = page.getByRole('dialog', { name: 'Ask Cal' });
    await ask.click();
    await expect(page.getByText('Could not sync your listening position. Try again.')).toBeVisible();
    await expect(cal).toHaveCount(0);
    unavailable = false;
    await ask.click();
    await expect(ask).toHaveAttribute('aria-disabled', 'true');
    await expect(cal).toHaveCount(0);
    releaseSave();
    await expect(cal).toBeVisible();
    expect(await serverPlace(page, book.id)).toEqual(saved);
    await page.unroute(progressUrl);
    await page.keyboard.press('Escape');
    await sheet.getByRole('button', { name: 'Back to saved place' }).click();
    await expect.poll(position).toBeCloseTo(1);
    await last.click();
    await expect.poll(position).toBeCloseTo(8);
    await sheet.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(sheet.getByTestId('sheet-play')).toHaveAttribute('data-playing', 'true');
    await expect.poll(position).toBeGreaterThanOrEqual(8);
    await expect(sheet.getByRole('button', { name: 'Back to saved place' })).toHaveCount(0);
  } finally {
    releaseSave();
    await ctx.close();
  }
});
