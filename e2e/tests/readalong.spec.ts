import { type Page, expect, test } from '@playwright/test';
import type { ReadAlongTrack } from '@bookclub/shared';
import { LIBRIVOX_TRANSCRIPT, browserAs, chooseSpeed, clubWithAlice, readAlong } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';

/** The text of the book frame between two offsets of its section, whitespace folded. */
async function frameText(page: Page, offset: number, length: number): Promise<string> {
  const frame = (await (await page.locator('iframe.epub-frame').elementHandle()).contentFrame())!;
  const text = await frame.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let all = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) all += (n as Text).data;
    return all;
  });
  return text.slice(offset, offset + length).replace(/\s+/g, ' ').trim();
}

const audioTime = (page: Page) => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.currentTime);

test.describe('a club owner gives an audiobook its transcript', () => {
  test('from the book page: it reads along, and can stop again', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    const row = page.locator('[data-testid=edition][data-kind=audio]');
    await expect(row).not.toContainText('reads along');
    await row.getByTestId('format-menu').click();
    const chooser = page.waitForEvent('filechooser');
    await row.getByRole('button', { name: 'Add a transcript…' }).click();
    await (await chooser).setFiles(LIBRIVOX_TRANSCRIPT);
    await expect(page.getByText('Transcript added: lining the audiobook up with the text now.')).toBeVisible();
    // Lined up on the server, the page hears of it and says so.
    await expect(row).toContainText('reads along', { timeout: 60_000 });
    await page.goto(`/books/${book.id}/listen`);
    await expect(page.getByTestId('readalong')).toBeVisible();
    // And it can stop again: back to following the book by chapters.
    await page.goto(`/books/${book.id}`);
    await row.getByTestId('format-menu').click();
    await row.getByRole('button', { name: 'Remove the transcript' }).click();
    await answerQuestion(page, 'Remove the transcript?', 'Remove');
    await expect(row).not.toContainText('reads along', { timeout: 30_000 });
    await ctx.close();
  });
});

test.describe('reading along: the audiobook lined up with the text, sentence by sentence', () => {
  test('while listening, the sentence being read is shown with its neighbours, and a tap plays one again', async ({ browser }) => {
    const { club, book: uploaded } = await clubWithAlice([], { audio: 'librivox' });
    const audio = uploaded.editions.find((e) => e.kind === 'audio')!;
    await readAlong(club.owner, uploaded, audio.id);
    const track = (await (await club.owner.api.get(`/api/editions/${audio.id}/readalong?track=0`)).json()) as ReadAlongTrack;
    const textAt = (ms: number) => {
      let i = 0;
      while (i + 1 < track.sentences.length && track.sentences[i + 1]![3] <= ms) i++;
      return track.text[i]!;
    };

    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${uploaded.id}/listen?edition=${audio.id}`);
    await page.getByTestId('scrubber').fill('60');
    await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(59);
    const current = page.getByTestId('readalong-current');
    await expect(current).toHaveText(textAt(Math.round((await audioTime(page)) * 1000)));
    // It moves on with the narrator.
    const first = Number(await page.getByTestId('readalong').getAttribute('data-sentence'));
    await page.getByTestId('play-pause').click();
    await expect.poll(async () => Number(await page.getByTestId('readalong').getAttribute('data-sentence')), { timeout: 30_000 }).toBeGreaterThan(first);
    // A tap on the sentence before plays it again from its start. Paused first, so the sentence
    // read here is still the one shown when the tap lands.
    await page.getByTestId('play-pause').click();
    await expect.poll(() => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
    const lines = page.locator('.readalong-line');
    const before = Number(await page.getByTestId('readalong').getAttribute('data-sentence')) - 1;
    await lines.first().click();
    await expect.poll(async () => Math.abs((await audioTime(page)) * 1000 - track.sentences[before]![3]), { timeout: 10_000 }).toBeLessThan(1500);
    await ctx.close();
  });

  test('in the book, the narrated sentence is marked and the pages follow the narrator until you turn one', async ({ browser }) => {
    const { club, book: uploaded } = await clubWithAlice([], { audio: 'librivox' });
    const audio = uploaded.editions.find((e) => e.kind === 'audio')!;
    await readAlong(club.owner, uploaded, audio.id);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${uploaded.id}/listen?edition=${audio.id}`);
    await page.getByTestId('scrubber').fill('40');
    await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(39);
    await page.getByTestId('play-pause').click();
    await page.getByTestId('readalong-open').click();
    const reader = page.getByTestId('reader');
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });

    // The sentence being read is on screen, marked, and it is the text the narrator reads.
    await expect(reader).not.toHaveAttribute('data-narrated', '');
    await expect(page.getByTestId('readalong-mark').first()).toBeVisible();
    const [section, offset, length] = (await reader.getAttribute('data-narrated'))!.split(':').map(Number) as [number, number, number];
    expect(Number(await reader.getAttribute('data-section'))).toBe(section);
    expect(await frameText(page, offset, length)).toMatch(/\p{L}{3,}/u);
    const sentence = (await (await club.owner.api.get(`/api/editions/${audio.id}/readalong?track=0`)).json()) as ReadAlongTrack;
    const row = sentence.sentences.findIndex(([s, o]) => s === section && o === offset);
    expect(row).toBeGreaterThanOrEqual(0);
    expect(await frameText(page, offset, length)).toBe(sentence.text[row]);

    // The narrator jumps ahead (as a skip would): the page follows.
    await page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => {
      a.currentTime = 400;
    });
    // The narrated sentence is (at least partly) on the page shown.
    const narratedOnPage = async () => {
      const [s, o, l] = (await reader.getAttribute('data-narrated'))!.split(':').map(Number) as [number, number, number];
      const start = Number(await reader.getAttribute('data-start'));
      const end = Number(await reader.getAttribute('data-end'));
      return Number(await reader.getAttribute('data-section')) === s && o < end && o + l > start;
    };
    await expect.poll(async () => Number((await reader.getAttribute('data-narrated'))!.split(':')[1]), { timeout: 20_000 }).toBeGreaterThan(offset + 1000);
    await expect.poll(narratedOnPage, { timeout: 15_000 }).toBe(true);

    // Turning a page yourself stops following; the chip brings you back to the narrator.
    await page.getByTestId('prev-page').click();
    await page.getByTestId('prev-page').click();
    await expect(page.getByTestId('follow-audio')).toBeVisible();
    await page.getByTestId('follow-audio').click();
    await expect.poll(narratedOnPage, { timeout: 15_000 }).toBe(true);
    await ctx.close();
  });
});

test.describe('reading along before the text and after a look (D184)', () => {
  test('during the opening credits, reading along is there: it says the text has not begun, and the book opens where it begins', async ({ browser }) => {
    const { club, book: uploaded } = await clubWithAlice([], { audio: 'librivox' });
    const audio = uploaded.editions.find((e) => e.kind === 'audio')!;
    await readAlong(club.owner, uploaded, audio.id);
    const first = (await (await club.owner.api.get(`/api/editions/${audio.id}/readalong?track=0`)).json()) as ReadAlongTrack;
    // LibriVox's opening: its first sentence comes thirteen seconds in.
    expect(first.sentences[0]![3]).toBeGreaterThan(8_000);
    expect(first.lead).toEqual([first.sentences[0]![0], first.sentences[0]![1]]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${uploaded.id}/listen?edition=${audio.id}`);
    // Before the fix the panel, and its "Follow in the book", were missing until the first sentence.
    await expect(page.getByTestId('readalong')).toHaveAttribute('data-state', 'before');
    await expect(page.getByTestId('readalong-before')).toContainText('Before the text');
    await expect(page.getByTestId('readalong-line')).toHaveText(first.text[0]!);
    await expect(page.getByTestId('readalong-open')).toBeVisible();
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    expect(await audioTime(page)).toBeLessThan(6);
    await page.getByTestId('readalong-open').click();
    // In the book: the page where the text begins, and a word that the narrator begins here.
    const reader = page.getByTestId('reader');
    await expect(reader).toHaveAttribute('data-section', String(first.lead![0]), { timeout: 15_000 });
    await expect(page.getByTestId('narration-before')).toBeVisible();
    // Once the narrator reaches the text, the sentence is marked and the note goes.
    await expect(reader).toHaveAttribute('data-narrated', new RegExp(`^${first.lead![0]}:${first.lead![1]}:`), { timeout: 20_000 });
    await expect(page.getByTestId('narration-before')).toHaveCount(0);
    await ctx.close();
  });

  test('following again after a look follows: the chip ends the look and the pages go back to the narrator', async ({ browser }) => {
    const { club, book: uploaded } = await clubWithAlice([], { audio: 'librivox' });
    const audio = uploaded.editions.find((e) => e.kind === 'audio')!;
    await readAlong(club.owner, uploaded, audio.id);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${uploaded.id}/listen?edition=${audio.id}`);
    await page.getByTestId('scrubber').fill('40');
    await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(39);
    await page.getByTestId('play-pause').click();
    await page.getByTestId('readalong-open').click();
    const reader = page.getByTestId('reader');
    await expect(reader).not.toHaveAttribute('data-narrated', '', { timeout: 20_000 });
    const narrator = async () => Number((await reader.getAttribute('data-narrated'))!.split(':')[0]);
    await expect.poll(async () => Number(await reader.getAttribute('data-section')), { timeout: 15_000 }).toBe(await narrator());
    // A look elsewhere while listening: the contents' chapter V.
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER V\./ }).click();
    await expect.poll(async () => Number(await reader.getAttribute('data-section'))).not.toBe(await narrator());
    await expect(page.getByTestId('follow-audio')).toBeVisible();
    // Before the fix the chip went away and the look stayed: the pages never moved again.
    await page.getByTestId('follow-audio').click();
    await expect(page.getByTestId('follow-audio')).toHaveCount(0);
    await expect.poll(async () => Number(await reader.getAttribute('data-section')), { timeout: 15_000 }).toBe(await narrator());
    await expect(page.getByTestId('back-to-reading')).toHaveCount(0);
    // And it keeps following: a skip ahead, the page goes with it.
    const before = Number(await reader.getAttribute('data-start'));
    await page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => {
      a.currentTime = 400;
    });
    await expect.poll(async () => Number(await reader.getAttribute('data-start')), { timeout: 20_000 }).toBeGreaterThan(before);
    await ctx.close();
  });
});

test.describe('reading along on a phone', () => {
  test('Play is on the first screen, and the controls stay put while the narrated sentences change', async ({ browser }) => {
    const { club, book: uploaded } = await clubWithAlice([], { audio: 'librivox' });
    const audio = uploaded.editions.find((e) => e.kind === 'audio')!;
    await readAlong(club.owner, uploaded, audio.id);
    const ctx = await browserAs(browser, club.owner, { viewport: { width: 393, height: 659 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${uploaded.id}/listen?edition=${audio.id}`);
    // At 0:00 the narrator has not reached the text (LibriVox's opening, D184): the panel says so
    // and shows the sentence the text begins with.
    await expect(page.getByTestId('readalong')).toHaveAttribute('data-state', 'before');
    await expect(page.getByTestId('readalong-before')).toBeVisible();
    const play = page.getByTestId('play-pause');
    // Without scrolling: the whole button is on screen.
    await expect(play).toBeInViewport({ ratio: 1 });
    // Twice as fast, so the narrated sentence changes several times in a few seconds.
    await chooseSpeed(page, 2);
    await play.click();
    const first = (await play.boundingBox())!.y;
    const sentence = Number(await page.getByTestId('readalong').getAttribute('data-sentence'));
    await expect.poll(async () => Number(await page.getByTestId('readalong').getAttribute('data-sentence')), { timeout: 30_000 }).toBeGreaterThan(sentence + 1);
    expect((await play.boundingBox())!.y).toBe(first);
    // The track list, asked for, is brought into view.
    await page.getByTestId('toggle-tracks').click();
    await expect(page.getByRole('heading', { name: 'Tracks' })).toBeInViewport();
    await ctx.close();
  });
});
