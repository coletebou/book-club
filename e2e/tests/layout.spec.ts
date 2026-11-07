import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { type DeviceSettings, browserAs, clubWithAlice, postComment, putProgress } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';
import { openBookSettings } from '../helpers/open';

/** iPhone SE and iPhone 15: the narrowest phone in use and the usual one. */
const PHONES = [
  { width: 375, height: 667 },
  { width: 393, height: 659 },
] as const;

const at = (section: number, offset: number) => ({ kind: 'epub' as const, section, offset });

/** The strips meant to scroll sideways: the members' row, and a PDF page zoomed in. */
const SIDEWAYS = '.members-panel, .pdf-area.is-zoomed';

/**
 * Nothing on the page runs off a phone's screen: the page does not slide sideways under the
 * thumb; nothing that scrolls up and down (a dialog, a panel, the player) is wider inside than
 * its box; and no button, link, field or line of text is cut at the screen's edge (unless it is
 * in a strip meant to scroll sideways).
 */
async function fitsTheScreen(page: Page, label: string) {
  // Let entrance animations finish: a sliding panel is measured where it comes to rest.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity || a.playState === 'finished'),
  );
  const width = page.viewportSize()!.width;
  const found = await page.evaluate(({ w, sideways }) => {
    const name = (el: Element) => {
      const text = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''} "${text}"`;
    };
    const cut: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const o = getComputedStyle(el).overflowX;
      if ((o === 'auto' || o === 'scroll') && !el.matches(sideways) && el.scrollWidth > el.clientWidth + 1 && el.checkVisibility()) {
        cut.push(`${name(el)} is ${el.scrollWidth} px wide inside, in ${el.clientWidth}`);
      }
    }
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="slider"], h1, h2, h3, p, li, label')) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || el.closest(sideways)) continue;
      if (r.left < -1 || r.right > w + 1) cut.push(`${name(el)} ${Math.round(r.left)}..${Math.round(r.right)}`);
      // A button's label and icon fit inside its pill, not over its edge.
      if (el.matches('.btn') && el.scrollWidth > el.clientWidth + 1) cut.push(`${name(el)} holds ${el.scrollWidth} px in ${el.clientWidth}`);
    }
    return { scrollWidth: document.documentElement.scrollWidth, cut: cut.slice(0, 8) };
  }, { w: width, sideways: SIDEWAYS });
  expect(found.scrollWidth, `${label} at ${width} px is wider than the screen`).toBeLessThanOrEqual(width);
  expect(found.cut, `${label} at ${width} px cuts these at the screen's edge`).toEqual([]);
}

async function phoneAs(browser: Parameters<typeof browserAs>[0], person: Parameters<typeof browserAs>[1], size: { width: number; height: number }, settings: DeviceSettings = {}): Promise<BrowserContext> {
  return browserAs(browser, person, { viewport: size, isMobile: true, hasTouch: true, ...settings });
}

test.describe('every page fits a phone', () => {
  test('the check itself catches a page that slides sideways, and a dialog wider inside than its box', async ({ browser }) => {
    const { club } = await clubWithAlice([]);
    const ctx = await phoneAs(browser, club.owner, PHONES[0]);
    const page = await ctx.newPage();
    const wideButton = (where: string) =>
      page.evaluate((selector) => {
        const b = document.createElement('button');
        b.textContent = 'Far too wide';
        b.style.cssText = 'display: block; width: 600px';
        document.querySelector(selector)!.append(b);
      }, where);
    await page.goto(`/clubs/${club.id}`);
    await expect(page.getByTestId('book-card')).toHaveCount(1);
    await fitsTheScreen(page, 'library');
    await wideButton('main');
    await expect(fitsTheScreen(page, 'library with a wide button')).rejects.toThrow(/wider than the screen|cuts these/);
    // A button too narrow for its label, on screen though it is.
    await page.reload();
    await expect(page.getByTestId('book-card')).toHaveCount(1);
    await page.evaluate(() => {
      const b = document.createElement('a');
      b.className = 'btn';
      b.href = '#';
      b.textContent = 'Continue in the PDF';
      b.style.cssText = 'width: 90px; white-space: nowrap';
      document.querySelector('main')!.prepend(b);
    });
    await expect(fitsTheScreen(page, 'library with a squeezed button')).rejects.toThrow(/holds \d+ px in/);
    // Inside a dialog, which scrolls up and down: the page itself stays as wide as the screen.
    await page.reload();
    await page.getByRole('button', { name: 'Add a book' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await fitsTheScreen(page, 'upload dialog');
    await wideButton('.modal');
    await expect(fitsTheScreen(page, 'upload dialog with a wide button')).rejects.toThrow(/cuts these/);
    await ctx.close();
  });

  test('the club pages, the book page and their dialogs, for the owner', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { pdf: true, audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    // Something in each part of the book page: a next stop, a note with an answer, friends' progress.
    await putProgress(club.members.Ana!, book.id, epub.id, at(3, 0), [{ from: at(3, 0), to: at(3, 900) }]);
    await putProgress(club.owner, book.id, epub.id, at(3, 0), [{ from: at(3, 0), to: at(3, 900) }]);
    const note = await postComment(club.members.Ana!, book.id, { editionId: epub.id, locator: at(3, 200), text: 'Down, down, down: would the fall never come to an end?', reaction: '😱' });
    expect((await club.owner.api.post(`/api/comments/${note.id}/replies`, { data: { text: 'Never, it seems, and the marmalade jar was empty' } })).status()).toBe(201);
    for (const size of PHONES) {
      const ctx = await phoneAs(browser, club.owner, size);
      const page = await ctx.newPage();
      await page.goto('/');
      await expect(page.getByTestId('book-card')).toHaveCount(1);
      await fitsTheScreen(page, 'home');
      await page.goto(`/clubs/${club.id}`);
      await expect(page.getByTestId('book-card')).toHaveCount(1);
      await fitsTheScreen(page, 'library');
      await page.getByTestId('bell').click();
      await expect(page.getByTestId('bell-panel')).toBeVisible();
      await fitsTheScreen(page, 'notifications');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Add a book' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      // A touch screen has nothing to drop: it is told to choose.
      await expect(page.getByText('Choose an EPUB, a PDF, or all of an audiobook’s tracks at once')).toBeVisible();
      await expect(page.getByText('Drop an EPUB, a PDF, or audiobook tracks here')).toBeHidden();
      await fitsTheScreen(page, 'upload dialog');
      await page.keyboard.press('Escape');

      await page.goto(`/books/${book.id}`);
      await expect(page.locator(`#note-${note.id}`).getByTestId('reply')).toBeVisible();
      await fitsTheScreen(page, 'book page');
      // The book's formats and their owner's menus, in Book settings (D198).
      const formats = await openBookSettings(page);
      await expect(formats.getByTestId('edition')).toHaveCount(3);
      await fitsTheScreen(page, 'book settings');
      for (const menu of await formats.getByTestId('format-menu').all()) {
        await menu.click();
        await expect(menu).toHaveAttribute('aria-expanded', 'true');
        await fitsTheScreen(page, 'a format’s menu');
        // Its own button closes it (Escape here would close Book settings with it).
        await menu.click();
        await expect(menu).toHaveAttribute('aria-expanded', 'false');
      }
      await page.keyboard.press('Escape');
      await expect(formats).toHaveCount(0);
      await page.getByTestId('meeting-set').click();
      await expect(page.getByRole('dialog', { name: 'The next stop' })).toBeVisible();
      await fitsTheScreen(page, 'next stop dialog');
      await page.getByTestId('meeting-save').click();
      await expect(page.getByTestId('meeting-headline')).toBeVisible();
      await fitsTheScreen(page, 'book page with a next stop');
      // Clear the stop for the next phone's turn.
      await page.getByTestId('meeting-clear').click();
      await answerQuestion(page, 'Clear the next stop?', 'Clear');
      await expect(page.getByTestId('meeting-set')).toBeVisible();

      await page.goto(`/clubs/${club.id}/settings`);
      await expect(page.getByRole('heading', { level: 1, name: 'Club settings' })).toBeVisible();
      await fitsTheScreen(page, 'club settings');
      await page.goto('/settings');
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      await fitsTheScreen(page, 'settings');
      await ctx.close();
    }
  });

  test('a club of seven still fits: the members’ strip scrolls sideways, and shows that it does', async ({ browser }) => {
    const { club } = await clubWithAlice(['Ana', 'Ben', 'Cleo', 'Dee', 'Eli', 'Finn']);
    for (const size of PHONES) {
      const ctx = await phoneAs(browser, club.owner, size);
      const page = await ctx.newPage();
      await page.goto(`/clubs/${club.id}`);
      await expect(page.getByTestId('book-card')).toHaveCount(1);
      const strip = page.getByTestId('members-panel');
      await expect(strip.locator('.presence-item')).toHaveCount(7);
      await fitsTheScreen(page, 'library with seven members');
      // It fades out where more members are, until scrolled there.
      await expect(strip).toHaveAttribute('data-more', 'right');
      await strip.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
      await expect(strip).toHaveAttribute('data-more', 'left');
      await fitsTheScreen(page, 'library with seven members, the strip scrolled');
      await ctx.close();
    }
  });

  test('the readers, their panels and the player', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { pdf: true, audio: 'tiny' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    await putProgress(club.members.Ana!, book.id, epub.id, at(3, 0), [{ from: at(3, 0), to: at(3, 900) }]);
    for (const size of PHONES) {
      // The player too: the full player, which this phone allows (Settings, D198).
      const ctx = await phoneAs(browser, club.owner, size, { audioOnlyView: true });
      const page = await ctx.newPage();
      await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
      await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
      await fitsTheScreen(page, 'EPUB reader');
      await page.getByTestId('open-toc').click();
      await fitsTheScreen(page, 'contents');
      await page.keyboard.press('Escape');
      await page.getByTestId('open-settings').click();
      await fitsTheScreen(page, 'reader settings');
      await page.keyboard.press('Escape');
      await page.getByTestId('add-note').click();
      await expect(page.getByTestId('note-text')).toBeVisible();
      await fitsTheScreen(page, 'note composer');
      await page.keyboard.press('Escape');

      await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
      await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', '91', { timeout: 30_000 });
      await fitsTheScreen(page, 'PDF reader');

      await page.goto(`/books/${book.id}/listen?edition=${audio.id}`);
      await expect(page.getByTestId('play-pause')).toBeVisible();
      await fitsTheScreen(page, 'player');
      await page.getByTestId('toggle-tracks').click();
      await expect(page.locator('.track-item').first()).toBeVisible();
      await fitsTheScreen(page, 'player with its track list');
      await ctx.close();
    }
  });

  test('on its side, the player keeps Play on the first screen, and fits', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    for (const size of [{ width: 734, height: 343 }, { width: 667, height: 375 }]) {
      // The full player of a book with a text, which this phone allows (Settings, D198).
      const ctx = await phoneAs(browser, club.owner, size, { audioOnlyView: true });
      const page = await ctx.newPage();
      await page.goto(`/books/${book.id}/listen?edition=${audio.id}`);
      await expect(page.getByTestId('play-pause')).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('slider', { name: 'Position in this track' })).toBeInViewport({ ratio: 1 });
      await fitsTheScreen(page, `player on its side (${size.width}×${size.height})`);
      await ctx.close();
    }
  });

  test('signing in, joining by invite, and a page that does not exist', async ({ browser }) => {
    const { club } = await clubWithAlice([]);
    for (const size of PHONES) {
      const ctx = await browser.newContext({ viewport: size, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      await page.goto('/signin');
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      await fitsTheScreen(page, 'sign in');
      await page.goto(`/join/${club.invite}`);
      await expect(page.getByRole('heading', { name: /^Join / })).toBeVisible();
      await fitsTheScreen(page, 'join');
      await ctx.close();
      const signedIn = await phoneAs(browser, club.owner, size);
      const missing = await signedIn.newPage();
      await missing.goto('/no/such/page');
      await expect(missing.getByRole('heading', { level: 1 })).toBeVisible();
      await fitsTheScreen(missing, 'not found');
      await signedIn.close();
    }
  });
});

test.describe('the club bar', () => {
  test('its notes and groups of notes never cover each other, however close friends wrote them (D31)', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben'], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    // In the project's own screen: a phone in WebKit, a computer in Chromium.
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    const track = page.locator('.reader-bar .club-bar-track');
    await expect(track).toBeVisible({ timeout: 30_000 });
    const width = (await track.boundingBox())!.width;
    // About one note for every 30 px of bar, at pages picked by a fixed seed: close together and
    // apart, as a club's notes are, so that groups form next to single notes.
    let seed = 20261024;
    const next = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const reactions = ['😂', '😢', '🤯', '❤️', '😱'];
    const writers = [club.owner, club.members.Ana!, club.members.Ben!];
    const count = Math.max(10, Math.min(40, Math.round(width / 30)));
    for (let i = 0; i < count; i++) {
      const notePage = 2 + Math.floor(next() * (pdf.pageCount! - 4));
      await postComment(writers[i % writers.length]!, book.id, { editionId: pdf.id, locator: { kind: 'pdf', page: notePage, y: next() }, reaction: reactions[Math.floor(next() * reactions.length)]! });
    }
    await page.reload();
    const targets = page.locator('.reader-bar').locator('[data-testid="bar-comment"], [data-testid="bar-comment-group"]');
    // Every note is on the bar, alone or in a group.
    await expect
      .poll(async () => {
        const groups = await targets.evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-count') ?? 1)));
        return groups.reduce((sum, n) => sum + n, 0);
      }, { timeout: 20_000 })
      .toBe(count);
    const boxes = (await targets.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, label: el.getAttribute('aria-label') }; }))).sort((a, b) => a.left - b.left);
    expect(await page.getByTestId('bar-comment-group').count(), 'some notes are close enough to group').toBeGreaterThan(0);
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.left, `${boxes[i - 1]!.label} | ${boxes[i]!.label}`).toBeGreaterThanOrEqual(boxes[i - 1]!.right - 0.5);
    }
    await ctx.close();
  });
});
