import { readFileSync } from 'node:fs';
import type { Transcript } from '@bookclub/shared';
import { expect, test } from '@playwright/test';
import { LIBRIVOX_DIR, LIBRIVOX_TRANSCRIPT, audioFolder, browserAs, makeClub, uploadBook } from '../helpers/api';

async function audiobookWithTranscript() {
  const club = await makeClub(['Ana']);
  const book = await uploadBook(club.owner, club.id, 'audio', audioFolder(LIBRIVOX_DIR).slice(0, 1), { title: 'Alice', author: 'Lewis Carroll' });
  const edition = book.editions[0]!;
  expect(edition.readAlong).toBeNull();
  const doc = JSON.parse(readFileSync(LIBRIVOX_TRANSCRIPT, 'utf8')) as Transcript;
  const first = doc.tracks[0]!;
  const uploaded = await club.owner.api.put(`/api/editions/${edition.id}/transcript`, { data: { ...doc, tracks: [first] } });
  expect(uploaded.status()).toBe(202);
  return { club, book, edition, first };
}

test('audiobook-only words follow, highlight and seek without a text edition', async ({ browser }) => {
  const { club, book, edition, first } = await audiobookWithTranscript();
  const ctx = await browserAs(browser, club.members.Ana!, { serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    let prefetches = 0;
    await page.route(/spoken-words\?track=0&window=1$/, (route) => ++prefetches === 1
      ? route.fulfill({ status: 503, json: { error: { code: 'busy', message: 'The server is preparing other audiobook words.' } } })
      : route.continue());
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
        expect(prefetches).toBe(2);
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

test('a browsed transcript page stays in place while playback moves to the next window', async ({ browser }) => {
  const { club, book, edition } = await audiobookWithTranscript();
  const ctx = await browserAs(browser, club.members.Ana!, { serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen?edition=${edition.id}`);
    const audio = page.getByTestId('audio-element');
    const position = () => audio.evaluate((el: HTMLAudioElement) => el.currentTime);
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration)).toBeGreaterThan(320);
    const panel = page.getByRole('region', { name: 'Audiobook transcript' });
    await panel.getByRole('button', { name: 'Show words' }).click();
    const seek = (seconds: number) => audio.evaluate((el: HTMLAudioElement, at) => { el.currentTime = at; }, seconds);
    const earlier = panel.getByRole('button', { name: 'Earlier sentences' });
    const firstLine = panel.getByTestId('readalong-line').first();
    const follow = panel.getByRole('button', { name: 'Follow narrator' });
    const play = page.getByTestId('play-pause');
    for (const resume of ['follow', 'seek'] as const) {
      await seek(298);
      await expect(earlier).toBeEnabled();
      const live = await firstLine.innerText();
      await earlier.click();
      await expect(firstLine).not.toHaveText(live);
      const browsed = await firstLine.innerText();
      await expect(follow).toBeEnabled();

      await play.click();
      await expect.poll(position).toBeGreaterThan(301);
      await expect(firstLine).toHaveText(browsed);
      await expect(panel.getByTestId('readalong-current')).toHaveCount(0);
      await expect(follow).toBeEnabled();
      if (resume === 'follow') {
        await follow.click();
        await expect(firstLine).toHaveText('There was not a moment to be lost.');
      } else {
        // A cross-window scrub back into the window being browsed resumes the live page too.
        await seek(290);
        await expect.poll(position).toBeLessThan(300);
        await expect(firstLine).not.toHaveText(browsed);
      }
      await expect(panel.getByTestId('readalong-current')).toBeVisible();
      await expect(follow).toBeDisabled();
      await play.click();
    }
  } finally {
    await ctx.close();
    await club.owner.api.dispose();
    await club.members.Ana!.api.dispose();
  }
});

test('the words panel stays open while a busy transcript window is retried', async ({ browser }) => {
  const { club, book, edition, first } = await audiobookWithTranscript();
  const context = await browserAs(browser, club.members.Ana!, { serviceWorkers: 'block' });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    const page = await context.newPage();
    let requests = 0;
    await page.route(/spoken-words\?track=0&window=1$/, async (route) => {
      if (++requests === 1) {
        await held;
        await route.fulfill({ status: 503, json: { error: { code: 'busy', message: 'The server is preparing other audiobook words.' } } });
      } else await route.continue();
    });
    await page.goto(`/books/${book.id}/listen?edition=${edition.id}`);
    const panel = page.getByRole('region', { name: 'Audiobook transcript' });
    const words = panel.getByRole('region', { name: 'Narrated words' });
    const audio = page.getByTestId('audio-element');
    const seek = (seconds: number) => audio.evaluate((element: HTMLAudioElement, at: number) => { element.currentTime = at; }, seconds);
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration)).toBeGreaterThan(320);
    await panel.getByRole('button', { name: 'Show words' }).click();

    // The LibriVox word “passage,” is spoken from 299.820s to 300.200s.
    await seek(299.9);
    const mark = words.getByTestId('readalong-word');
    await expect(mark).toHaveText('passage,');
    await expect(mark).toHaveCount(1);
    const height = (await panel.boundingBox())!.height;
    const earlier = panel.getByRole('button', { name: 'Earlier sentences' });
    await expect(earlier).toBeEnabled();
    await earlier.focus();
    await seek(300.1);
    await expect(words).toHaveAttribute('aria-busy', 'true');
    await expect(words.getByRole('status')).toHaveText('Loading audiobook words…');
    await expect(earlier).toBeFocused();
    await expect(earlier).toBeDisabled();
    expect((await panel.boundingBox())!.height).toBe(height);
    await expect(mark).toHaveCount(0);

    release();
    const retry = words.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeVisible();
    expect(requests).toBe(1);
    const match = first.words.find(([from, to, text]) => from > 550_000 && from < 590_000 && to - from > 240 && /^[a-z]{4,}$/i.test(text));
    expect(match).toBeDefined();
    const [start, end, text] = match!;
    await seek((start + end) / 2_000);
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(mark).toHaveText(text);
    await expect(earlier).toBeEnabled();
    await expect(words).toBeFocused();
    await seek(300.1);
    await expect(mark).toHaveText('passage,');
    await expect(mark).toHaveCount(1);
    expect(requests).toBe(2);
    expect((await panel.boundingBox())!.height).toBe(height);
  } finally {
    release();
    await context.close();
  }
});
