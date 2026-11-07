import { expect, test } from '@playwright/test';
import type { BookDetail } from '@bookclub/shared';
import { browserAs, clubWithAlice, postComment, putProgress, serverPlace } from '../helpers/api';

function chapterRange(book: BookDetail, roman: string): [number, number] {
  const i = book.chapters.findIndex((c) => c.title.startsWith(`CHAPTER ${roman}.`));
  return [book.chapters[i]!.t, book.chapters[i + 1]?.t ?? 1];
}

test.describe('one book, read and heard, on one timeline', () => {
  test('a reader and a listener see each other on the same club bar, in the same chapter', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben'], { audio: 'librivox' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const [c3start, c3end] = chapterRange(book, 'III');

    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ana.getByTestId('open-toc').click();
    await ana.getByRole('button', { name: /CHAPTER III\./ }).click();
    await expect(ana.getByTestId('chapter-page')).toHaveAttribute('data-page', '1', { timeout: 30_000 });
    // She reads on there (a chapter from the contents is a look until then; past where she has
    // read, until three pages are read there: D72).
    for (let i = 0; i < 3; i++) await ana.getByTestId('next-page').click();
    await expect(ana.getByTestId('chapter-page')).toHaveAttribute('data-page', '4');

    // Ben listens in the full player, which his device allows (Settings, D198).
    const benCtx = await browserAs(browser, club.members.Ben!, { audioOnlyView: true });
    const ben = await benCtx.newPage();
    await ben.goto(`/books/${book.id}/listen`);
    await ben.getByTestId('toggle-tracks').click();
    await ben.locator('.track-item').nth(2).click();
    await expect(ben.getByTestId('listen-page')).toHaveAttribute('data-track', '2');
    // A chapter from the list is a look until Play (D72): he listens there.
    await ben.getByTestId('play-pause').click();
    await expect(ben.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await ben.getByTestId('scrubber').fill('500');

    // Ben, listening to chapter III, is inside chapter III on Ana's bar, and vice versa.
    const benOnAna = ana.locator(`[data-testid=member-marker][data-user="${club.members.Ben!.id}"]`);
    await expect(benOnAna).toHaveAttribute('data-live', 'true', { timeout: 5000 });
    await expect.poll(async () => Number(await benOnAna.getAttribute('data-t')), { timeout: 5000 }).toBeGreaterThan(c3start);
    expect(Number(await benOnAna.getAttribute('data-t'))).toBeLessThan(c3end);
    const anaOnBen = ben.locator(`[data-testid=member-marker][data-user="${club.members.Ana!.id}"]`);
    await expect(anaOnBen).toHaveAttribute('data-live', 'true', { timeout: 5000 });
    const anaT = Number(await anaOnBen.getAttribute('data-t'));
    expect(anaT).toBeGreaterThanOrEqual(c3start - 1e-6);
    expect(anaT).toBeLessThan(c3end);
    await anaCtx.close();
    await benCtx.close();
  });

  test('a note written in the EPUB is heard at the matching moment of the audiobook, and back', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ben'], { audio: 'librivox' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    // Olive comments half-way through chapter V of the EPUB.
    const ch5 = book.chapters.findIndex((c) => c.title.startsWith('CHAPTER V.'));
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { sections: { textLength: number }[]; toc: { title: string; section: number }[] };
    const sectionIndex = pub.toc.find((e) => e.title.startsWith('CHAPTER V.'))!.section;
    const mid = Math.floor(pub.sections[sectionIndex]!.textLength / 2);
    const written = await postComment(club.owner, book.id, { editionId: epub.id, locator: { kind: 'epub', section: sectionIndex, offset: mid }, text: 'The Caterpillar is so rude', reaction: '😡' });
    expect(written.t).toBeGreaterThan(book.chapters[ch5]!.t);

    // Ben listens to track 5 (chapter V): the note sits on track 5's scrubber, near the middle.
    // In the full player, which his device allows (Settings, D198).
    const benCtx = await browserAs(browser, club.members.Ben!, { audioOnlyView: true });
    const ben = await benCtx.newPage();
    await ben.goto(`/books/${book.id}/listen`);
    await ben.getByTestId('toggle-tracks').click();
    await ben.locator('.track-item').nth(4).click();
    await expect(ben.getByTestId('listen-page')).toHaveAttribute('data-track', '4');
    const mark = ben.locator('.scrub-mark').first();
    await expect(mark).toHaveText('😡');
    const left = await mark.evaluate((el) => parseFloat((el as HTMLElement).style.left));
    expect(left).toBeGreaterThan(30);
    expect(left).toBeLessThan(70);

    // Ben reacts while listening early in chapter VII; Olive finds it on the matching EPUB page.
    await ben.locator('.track-item').nth(6).click();
    await ben.getByTestId('scrubber').fill('60');
    await expect.poll(() => ben.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(59);
    await ben.getByRole('button', { name: 'Laughing at this moment' }).click();
    await expect(ben.getByText(/😂 pinned at/)).toBeVisible();

    const comments = (await (await club.owner.api.get(`/api/books/${book.id}/comments`)).json()) as { id: string; editionId: string; t: number; reaction: string }[];
    const benNote = comments.find((c) => c.editionId === audio.id)!;
    const [c7start, c7end] = chapterRange(book, 'VII');
    expect(benNote.t).toBeGreaterThan(c7start);
    expect(benNote.t).toBeLessThan(c7end);
    const oliveCtx = await browserAs(browser, club.owner);
    const olive = await oliveCtx.newPage();
    await olive.goto(`/books/${book.id}/read?edition=${epub.id}&at=${benNote.t}`);
    await expect(olive.getByTestId('chapter-page')).toBeVisible();
    await expect(olive.locator('.reader-chapter')).toContainText('A Mad Tea-Party', { timeout: 30_000 });
    await expect(olive.getByTestId('margin-marker').filter({ hasText: '😂' })).toBeVisible();
    await benCtx.close();
    await oliveCtx.close();
  });

  test('switching from listening to reading opens the page that matches the audio position', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'librivox' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    // Listening in the full player, which this device allows (Settings, D198).
    const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen`);
    await page.getByTestId('toggle-tracks').click();
    await page.locator('.track-item').nth(8).click();
    await page.getByTestId('scrubber').fill('30');
    await page.getByTestId('play-pause').click();
    await page.waitForTimeout(1500); // listening for a moment
    await page.getByTestId('play-pause').click();
    await expect.poll(async () => {
      const l = await serverPlace(page, book.id);
      return l?.kind === 'audio' && l.track === 8;
    }, { timeout: 20_000 }).toBe(true);
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(page.locator('.reader-chapter')).toContainText('The Mock Turtle', { timeout: 30_000 });
    await ctx.close();
  });
});

test.describe('a note goes with you into the format you use', () => {
  test('a reader tapping “Go to passage” on a listener’s note opens it in the book, not in the player', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ben', 'Cleo'], { audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    // Cleo reads the EPUB and has read chapter I; Ben, listening, leaves a note early in track 1.
    const pub = (await (await club.owner.api.get(epub.publicationUrl!)).json()) as { toc: { title: string; section: number }[] };
    const ch1 = pub.toc.find((e) => e.title.startsWith('CHAPTER I.'))!.section;
    await putProgress(club.members.Cleo!, book.id, epub.id, { kind: 'epub', section: ch1, offset: 0 }, [{ from: { kind: 'epub', section: ch1, offset: 0 }, to: { kind: 'epub', section: ch1 + 1, offset: 0 } }]);
    const note = await postComment(club.members.Ben!, book.id, { editionId: audio.id, locator: { kind: 'audio', track: 0, ms: 1500 }, text: 'Heard it on the bus' });
    const ctx = await browserAs(browser, club.members.Cleo!);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await page.locator(`#note-${note.id}`).getByRole('button', { name: 'Go to passage' }).click();
    // In the reader, at the note's place, with the note open.
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}/read\\?edition=${epub.id}`));
    await expect(page.getByTestId('sheet-note-text')).toHaveText('Heard it on the bus');
    await ctx.close();
  });
});
