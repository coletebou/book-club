import { type BrowserContextOptions, type Page, expect, test } from '@playwright/test';
import { browserAs, chooseSpeed, clubWithAlice, readAlong } from '../helpers/api';

/*
 * The book is its text, the audiobook played over it (D194, D197): Listen in the reader's footer
 * starts it at your page, in that tap, docked under the page, with Now in this book over it and Stop
 * to put it away; the full player is a step aside, and Show the text comes back; one obvious Play
 * where the browser refuses to start it without a tap.
 */

const PHONE: BrowserContextOptions = { viewport: { width: 393, height: 659 }, isMobile: true, hasTouch: true };

const audioTime = (page: Page) => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.currentTime);
const audioSrc = (page: Page) => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.getAttribute('src') ?? '');

/** Read from chapter III: the contents, then "Read from here". */
async function readFromChapterThree(page: Page) {
  const reader = page.getByTestId('reader');
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  const before = await reader.getAttribute('data-section');
  await page.getByTestId('open-toc').click();
  await page.getByRole('button', { name: /CHAPTER III\./ }).click();
  await expect(reader).not.toHaveAttribute('data-section', before ?? '');
  await page.getByTestId('read-from-here').click();
  await expect(page.getByTestId('look-chip')).toHaveCount(0);
  return (await reader.getAttribute('data-section'))!;
}

async function aliceReadingAlong() {
  const { club, book } = await clubWithAlice([], { audio: 'librivox' });
  const audio = book.editions.find((e) => e.kind === 'audio')!;
  const lined = await readAlong(club.owner, book, audio.id);
  return { club, book: lined, audio, epub: lined.editions.find((e) => e.kind === 'epub')! };
}

test.describe('the audiobook over the text', () => {
  test('in the book, Listen starts the audiobook at your page in that tap and docks it; Stop puts it away, and the page stays', async ({ browser }) => {
    const { club, book } = await aliceReadingAlong();
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    const section = await readFromChapterThree(page);
    const reader = page.getByTestId('reader');
    await expect(page.getByTestId('listen-here')).toBeVisible();
    await expect(page.getByTestId('mini-player')).toHaveCount(0);

    await page.getByTestId('listen-here').click();
    // Playing at once, from chapter III (its track, the third), in the footer's docked player.
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    await expect.poll(() => audioSrc(page)).toMatch(/\/tracks\/2(\?|$)/);
    await expect(page.locator('.reader-dock')).toBeVisible();
    await expect(page.getByTestId('listen-here')).toHaveCount(0);
    await expect(page.getByTestId('along-start')).toHaveCount(0);
    // The narrator is in chapter III, where you are: the page is still there.
    await expect(reader).toHaveAttribute('data-section', section);

    // The dock's own controls.
    await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(1);
    const t = await audioTime(page);
    await page.getByTestId('footer-skip-forward').click();
    await expect.poll(() => audioTime(page)).toBeGreaterThan(t + 20);
    await chooseSpeed(page, 1.5);
    await expect.poll(() => page.getByTestId('audio-element').evaluate((a: HTMLAudioElement) => a.playbackRate)).toBe(1.5);

    // Stop: the audiobook stops (its place saved) and the dock goes; the page stays, Listen back.
    const start = await reader.getAttribute('data-start');
    await page.getByTestId('dock-stop').click();
    await expect(page.getByTestId('mini-player')).toHaveCount(0);
    await expect(page.getByTestId('listen-here')).toBeVisible();
    await expect.poll(() => audioSrc(page)).toBe('');
    await expect(reader).toHaveAttribute('data-section', section);
    // Laid out again without the dock, the passage you were on is still on screen.
    const end = Number(await reader.getAttribute('data-end'));
    expect(Number(start)).toBeLessThan(end);
    await ctx.close();
  });

  test('Now in this book: the player over the page, and from it the full player, playing on', async ({ browser }) => {
    const { club, book, audio } = await aliceReadingAlong();
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    await readFromChapterThree(page);
    await page.getByTestId('listen-here').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });

    await page.getByTestId('dock-expand').click();
    const sheet = page.getByRole('dialog', { name: 'Now in this book' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('now-playing-title')).toContainText('CHAPTER III');
    await expect(sheet.getByTestId('sheet-play')).toHaveAttribute('data-playing', 'true');
    // Reading along, without a link back into the book it is over.
    await expect(sheet.getByTestId('readalong')).toBeVisible();
    await expect(sheet.getByTestId('readalong-open')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    // Closing it changed nothing: still docked, still playing.
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook');

    await page.getByTestId('dock-expand').click();
    await sheet.getByTestId('open-full-player').click();
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}/listen\\?edition=${audio.id}`));
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', '2');
    await expect(page.getByTestId('show-text')).toBeVisible();
    await ctx.close();
  });

  test('from the full player, Show the text opens the book where the narrator is and follows, the audiobook going on', async ({ browser }) => {
    const { club, book, epub } = await aliceReadingAlong();
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen`);
    const listen = page.getByTestId('listen-page');
    await page.getByTestId('next-track').click();
    await page.getByTestId('next-track').click();
    await expect(listen).toHaveAttribute('data-track', '2');
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'true');
    await page.getByTestId('show-text').click();
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}/read\\?edition=${epub.id}`));
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    // Following the narrator in chapter III (before its text: the page where it begins).
    const reader = page.getByTestId('reader');
    await expect.poll(async () => (await page.getByTestId('narration-before').count()) > 0 || (await reader.getAttribute('data-narrated')) !== '', { timeout: 20_000 }).toBe(true);
    await expect(page.locator('.reader-chapter')).toContainText(/CHAPTER III/i, { timeout: 20_000 });

    // Paused in the player, Show the text opens the book there with the audiobook docked, paused.
    await page.getByTestId('dock-expand').click();
    await page.getByRole('dialog', { name: 'Now in this book' }).getByTestId('open-full-player').click();
    await expect(listen).toHaveAttribute('data-track', '2');
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'false');
    await page.getByTestId('show-text').click();
    await expect(page.locator('.reader-dock')).toBeVisible();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Play the audiobook');
    await expect(page.locator('.reader-chapter')).toContainText(/CHAPTER III/i);
    await ctx.close();
  });

  test('where the browser refuses to start the audiobook without a tap, one obvious Play over the page, and its tap reads along', async ({ browser }) => {
    const { club, book, audio, epub } = await aliceReadingAlong();
    const ctx = await browserAs(browser, club.owner);
    // The browser's rule, as iOS applies it to a page opened cold: play() outside a tap is refused.
    // (Only the browser's policy is stood in for, read from the taps the page sees;
    // the server and the audio are real.)
    await ctx.addInitScript(() => {
      // A tap is a pointer or key press in the last second (as transient activation is reckoned).
      let tapped = -Infinity;
      for (const type of ['pointerdown', 'pointerup', 'click', 'keydown', 'touchend']) addEventListener(type, () => (tapped = performance.now()), true);
      const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play')!.value as (this: HTMLMediaElement) => Promise<void>;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        if (performance.now() - tapped > 1000) return Promise.reject(new DOMException('play() can only be initiated by a user gesture.', 'NotAllowedError'));
        return real.call(this);
      };
    });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}&along=${audio.id}`);
    const start = page.getByTestId('along-start');
    await expect(start).toBeVisible({ timeout: 20_000 });
    await expect(start).toContainText('Read along from here');
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Play the audiobook');
    await start.click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    await expect(start).toHaveCount(0);
    // A pause later is a pause: no prompt comes back.
    await page.getByTestId('footer-play').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Play the audiobook');
    await expect(start).toHaveCount(0);
    await ctx.close();
  });

  test('on a phone, the docked player keeps every control whole, inside the screen and clear of the page', async ({ browser }, info) => {
    const { club, book } = await aliceReadingAlong();
    const ctx = await browserAs(browser, club.owner, info.project.name === 'webkit-iphone' ? {} : PHONE);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    // Reading: Listen between the page arrows, on one line with the page numbers.
    const footer = page.locator('.reader-footer');
    const readBoxes = await footer.evaluate((f) => [...f.querySelectorAll('button, .page-info')].map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })));
    const middle = (b: { top: number; bottom: number }) => (b.top + b.bottom) / 2;
    expect(Math.max(...readBoxes.map(middle)) - Math.min(...readBoxes.map(middle))).toBeLessThan(8);

    await page.getByTestId('listen-here').click();
    await expect(page.getByTestId('footer-play')).toHaveAttribute('aria-label', 'Pause the audiobook', { timeout: 15_000 });
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    // Measured where it settles: the dock rises in (16 px over a third of a second), and a box
    // taken while it rises is that much lower than the dock will be.
    await page.locator('.reader-dock').evaluate((dock) => Promise.all(dock.getAnimations({ subtree: true }).map((a) => a.finished)));
    const boxes = await page.evaluate(() => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { id: (el as HTMLElement).dataset.testid ?? el.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const controls = [...document.querySelectorAll('.reader-dock button, .reader-dock select, .reader-dock input')].map(box);
      return { controls, area: box(document.querySelector('.reader-area')!), dock: box(document.querySelector('.reader-dock')!), width: innerWidth, height: innerHeight };
    });
    for (const c of boxes.controls) {
      expect(c.left, `${c.id} inside the screen`).toBeGreaterThanOrEqual(0);
      expect(c.right, `${c.id} inside the screen`).toBeLessThanOrEqual(boxes.width + 0.5);
      expect(c.bottom, `${c.id} inside the screen`).toBeLessThanOrEqual(boxes.height + 0.5);
    }
    // No two controls overlap.
    const whole = boxes.controls;
    for (const [i, a] of whole.entries()) {
      for (const b of whole.slice(i + 1)) {
        const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        expect(overlap, `${a.id} and ${b.id} overlap`).toBe(false);
      }
    }
    // The page ends where the dock begins: nothing of it is under the player.
    expect(boxes.area.bottom).toBeLessThanOrEqual(boxes.dock.top + 1);
    // Every control is a 44 px target, or near it.
    for (const id of ['footer-play', 'footer-skip-back', 'footer-skip-forward', 'dock-expand', 'dock-stop', 'prev-page', 'next-page']) {
      const r = await page.getByTestId(id).boundingBox();
      expect(r!.width, id).toBeGreaterThanOrEqual(43);
      expect(r!.height, id).toBeGreaterThanOrEqual(43);
    }
    await ctx.close();
  });
});
