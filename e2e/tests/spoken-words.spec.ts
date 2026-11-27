import { readFileSync } from 'node:fs';
import type { Transcript } from '@bookclub/shared';
import { expect, test } from '@playwright/test';
import { LIBRIVOX_DIR, LIBRIVOX_TRANSCRIPT, audioFolder, browserAs, makeClub, uploadBook } from '../helpers/api';

test('audiobook-only words follow, highlight and seek without a text edition', async ({ browser }) => {
  const club = await makeClub(['Ana']);
  const book = await uploadBook(club.owner, club.id, 'audio', audioFolder(LIBRIVOX_DIR).slice(0, 1), { title: 'Alice', author: 'Lewis Carroll' });
  const edition = book.editions[0]!;
  expect(edition.readAlong).toBeNull();
  const doc = JSON.parse(readFileSync(LIBRIVOX_TRANSCRIPT, 'utf8')) as Transcript;
  const first = doc.tracks[0]!;
  const uploaded = await club.owner.api.put(`/api/editions/${edition.id}/transcript`, { data: { ...doc, tracks: [first] } });
  expect(uploaded.status()).toBe(202);

  const ctx = await browserAs(browser, club.members.Ana!);
  try {
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen?edition=${edition.id}`);
    const panel = page.getByRole('region', { name: 'Audiobook transcript' });
    const audio = page.getByTestId('audio-element');
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration)).toBeGreaterThan(320);
    const show = panel.getByRole('button', { name: 'Show words' });
    await expect(show).toBeVisible();
    await expect(panel.getByRole('region', { name: 'Narrated words' })).toHaveCount(0);
    await show.click();
    const seek = async (ms: number) => { await audio.evaluate((el: HTMLAudioElement, at: number) => { el.currentTime = at / 1000; }, ms); };
    for (const lower of [40_000, 308_000]) {
      if (lower === 308_000) {
        const nextWindow = page.waitForResponse((response) => response.url().includes('spoken-words?track=0&window=1') && response.ok());
        await seek(295_000);
        await nextWindow;
        await panel.getByTestId('readalong-current').focus();
      }
      const match = first.words.find(([from, to, word]) => from > lower && to - from > 260 && /^[a-z]{4,}$/i.test(word));
      expect(match).toBeDefined();
      const [start, end, word] = match!;
      await seek((start + end) / 2);
      await expect(panel.getByTestId('readalong-word')).toHaveText(word);
    }
    await expect(panel.getByRole('region', { name: 'Narrated words' })).toBeFocused();
    const current = panel.getByTestId('readalong-current');
    await expect(current).toBeVisible();
    const before = await audio.evaluate((el: HTMLAudioElement) => el.currentTime);
    await current.click();
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeLessThan(before);
    await expect(panel.getByRole('link', { name: 'Follow in the book' })).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
