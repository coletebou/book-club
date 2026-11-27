import { expect, test } from '@playwright/test';
import type { ReadAlongTrack } from '@bookclub/shared';
import { browserAs, clubWithAlice, readAlong } from '../helpers/api';

test('the spoken word is highlighted in the full player and reader sheet', async ({ browser }) => {
  const { club, book } = await clubWithAlice([], { audio: 'librivox' });
  const edition = book.editions.find((e) => e.kind === 'audio')!;
  await readAlong(club.owner, book, edition.id);
  const response = await club.owner.api.get(`/api/editions/${edition.id}/readalong?track=0&words=1`);
  expect(response.ok()).toBe(true);
  const track = await response.json() as ReadAlongTrack;
  const matches = track.wordTimings?.flatMap((words, sentence) => words.map((word) => ({ word, sentence }))) ?? [];
  const match = matches.find(({ word: [offset, , from, to], sentence }) =>
    from > 20_000 && from < 150_000 && to - from > 250 && offset > 200 && track.text[sentence]!.length > 265);
  expect(match).toBeDefined();
  const { word: [offset, length, start, end], sentence } = match!;
  const wanted = track.text[sentence]!.slice(offset, offset + length);
  const milliseconds = (start + end) / 2;

  const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 350, height: 390 });
    await page.goto(`/books/${book.id}/listen?edition=${edition.id}`);
    const audio = page.getByTestId('audio-element');
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration)).toBeGreaterThan(65);
    await audio.evaluate((element: HTMLAudioElement, ms: number) => { element.currentTime = ms / 1_000; }, milliseconds);
    const panel = page.getByTestId('readalong');
    await expect(panel.getByTestId('readalong-current')).toHaveText(track.text[sentence]!);
    await panel.getByRole('button', { name: 'Show words' }).click();
    const expectWordInView = async (mark: ReturnType<typeof page.getByTestId>) => {
      await expect(mark).toHaveText(wanted);
      await expect.poll(() => mark.evaluate((word) => {
        const scroller = word.closest('.readalong-words')!;
        const bounds = scroller.getBoundingClientRect();
        const glyph = word.getBoundingClientRect();
        return glyph.top >= bounds.top && glyph.bottom <= bounds.bottom;
      })).toBe(true);
    };
    await expectWordInView(panel.getByTestId('readalong-word'));
    await page.getByTestId('show-text').click();
    await page.getByTestId('dock-expand').click();
    const sheet = page.getByRole('dialog', { name: 'Now in this book' });
    await sheet.getByRole('button', { name: 'Show words' }).click();
    await expectWordInView(sheet.getByTestId('readalong-word'));
  } finally {
    await ctx.close();
  }
});
