import { type Locator, type Page, expect, test } from '@playwright/test';
import type { ReadAlongTrack } from '@bookclub/shared';
import { browserAs, clubWithAlice, readAlong } from '../helpers/api';

function audioTime(page: Page): Promise<number> {
  return page.getByTestId('audio-element').evaluate((audio: HTMLAudioElement) => audio.currentTime * 1_000);
}

async function openWords(panel: Locator) {
  await panel.getByRole('button', { name: 'Show words' }).click();
  const words = panel.getByRole('region', { name: 'Narrated words' });
  await expect(words.getByRole('button').nth(3)).toBeAttached();
  await expect.poll(() => words.getByRole('button').count()).toBeLessThanOrEqual(24);
  await expectCurrentInWords(words);
  return words;
}

async function expectCurrentInWords(words: Locator) {
  await expect.poll(() => words.evaluate((region) => {
    const current = region.querySelector('[aria-current="true"]');
    if (!current) return false;
    const view = region.getBoundingClientRect();
    const line = current.getBoundingClientRect();
    return line.top >= view.top - 1 && line.bottom <= view.bottom + 1;
  })).toBe(true);
}

test('the words view follows playback and seeks in the full player and reader sheet', async ({ browser }) => {
  const { club, book } = await clubWithAlice([], { audio: 'librivox' });
  const edition = book.editions.find((e) => e.kind === 'audio')!;
  await readAlong(club.owner, book, edition.id);
  const response = await club.owner.api.get(`/api/editions/${edition.id}/readalong?track=0`);
  expect(response.ok()).toBe(true);
  const track = await response.json() as ReadAlongTrack;
  const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
  try {
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen?edition=${edition.id}`);
    const scrubber = page.getByTestId('scrubber');
    await expect.poll(async () => Number(await scrubber.getAttribute('max'))).toBeGreaterThan(120);
    await scrubber.fill('120');
    await expect.poll(() => audioTime(page)).toBeGreaterThan(119_000);
    const panel = page.getByTestId('readalong');
    await expect(panel).toHaveAttribute('data-state', 'reading');
    const words = await openWords(panel);
    await expect(words).toHaveCSS('scroll-behavior', 'smooth');
    await page.setViewportSize({ width: 400, height: 450 });
    await expectCurrentInWords(words);
    await panel.getByRole('button', { name: 'Later sentences' }).click();
    const follow = panel.getByRole('button', { name: 'Follow narrator' });
    await follow.focus();
    await page.keyboard.press('Enter');
    await expect(words).toBeFocused();
    await expectCurrentInWords(words);
    await panel.getByRole('button', { name: 'Later sentences' }).click();
    const target = words.getByRole('button').first();
    const sentence = track.text.indexOf(await target.innerText());
    expect(sentence).toBeGreaterThan(0);
    await target.click();
    await expect.poll(async () => Math.abs(await audioTime(page) - track.sentences[sentence]![3])).toBeLessThan(250);
    await expect(panel.getByTestId('readalong-current')).toHaveText(track.text[sentence]!);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByTestId('show-text').click();
    await page.getByTestId('dock-expand').click();
    const sheet = page.getByRole('dialog', { name: 'Now in this book' });
    const sheetPanel = sheet.getByTestId('readalong');
    await expect(sheetPanel.getByTestId('readalong-current')).toHaveText(track.text[sentence]!);
    const sheetWords = await openWords(sheetPanel);
    await expect(sheetWords).toHaveCSS('scroll-behavior', 'auto');
    const current = sheetWords.getByTestId('readalong-current');
    const next = current.locator('xpath=../following-sibling::li[1]/button');
    const nextSentence = track.text.indexOf(await next.innerText());
    expect(nextSentence).toBeGreaterThan(sentence);
    await next.click();
    await expect.poll(async () => Math.abs(await audioTime(page) - track.sentences[nextSentence]![3])).toBeLessThan(250);
    await expect(sheetPanel.getByTestId('readalong-current')).toHaveText(track.text[nextSentence]!);

    // The short final page has the same viewport as the middle of a track.
    const height = (await sheetWords.boundingBox())!.height;
    const last = track.sentences.at(-1)!;
    await sheet.getByTestId('sheet-scrubber').fill(String(Math.ceil(last[3] / 1000)));
    await expect(sheetPanel.getByTestId('readalong-current')).toHaveText(track.text.at(-1)!);
    expect((await sheetWords.boundingBox())!.height).toBe(height);
  } finally {
    await ctx.close();
  }
});
