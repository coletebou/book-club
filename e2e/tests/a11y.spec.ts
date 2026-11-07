import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { type Person, browserAs, clubWithAlice, postComment, putProgress, readAlong } from '../helpers/api';
import { listenFromThisPage, openBookSettings, openFromBookPage } from '../helpers/open';

/** Zero serious or critical WCAG 2.1 A/AA violations on the page as rendered. */
async function expectAccessible(page: Page, label: string) {
  // Let entrance animations finish: contrast is measured on what is finally shown.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity || a.playState === 'finished'),
  );
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`),
    `${label} has serious or critical accessibility violations`,
  ).toEqual([]);
}

const at = (section: number, offset: number) => ({ kind: 'epub' as const, section, offset });

/** An iPhone 15's screen, in both projects: where a club of seven no longer fits across. */
const PHONE = { viewport: { width: 393, height: 659 }, isMobile: true, hasTouch: true };

/**
 * A club some weeks in, as a reviewer found the bar in one: seven members, four of them on one
 * page of chapter II (one marker of three dots and "+1"), and notes a few lines apart, which the
 * club bar gathers into groups that show each reaction with its count: one the owner has read
 * (😂 2, and a dot for the 2 in words), one ahead of her (😱 2 ❤️ 1 +2). A note of hers and one
 * of a friend far ahead stand alone.
 */
async function livedInClub() {
  const { club, book } = await clubWithAlice(['Ana', 'Ben', 'Cleo', 'Dee', 'Eli', 'Finn'], { pdf: true, audio: 'tiny' });
  const epub = book.editions.find((e) => e.kind === 'epub')!;
  const { Ana, Ben, Cleo, Dee, Eli, Finn } = club.members;
  const readTo = (who: Person, section: number) => putProgress(who, book.id, epub.id, at(section, 900), [{ from: at(2, 0), to: at(section, 900) }]);
  for (const who of [Ana!, Ben!, Cleo!, Dee!]) await readTo(who, 3);
  await readTo(club.owner, 6);
  await readTo(Finn!, 9);
  await readTo(Eli!, 12);
  const note = (who: Person, place: ReturnType<typeof at>, body: { text?: string; reaction?: string }) =>
    postComment(who, book.id, { editionId: epub.id, locator: place, ...body });
  await note(Ana!, at(3, 300), { reaction: '😂', text: 'Opening out like the largest telescope' });
  await note(Ben!, at(3, 340), { reaction: '😂' });
  await note(Cleo!, at(3, 380), { text: 'Curiouser and curiouser' });
  await note(Dee!, at(3, 420), { text: 'Good-bye, feet!' });
  // Far enough from the groups to stand alone on a phone's bar too.
  await note(club.owner, at(6, 300), { reaction: '😢', text: 'Poor little Bill' });
  await note(Finn!, at(9, 300), { reaction: '😱' });
  await note(Eli!, at(9, 330), { reaction: '😱', text: 'Off with their heads' });
  await note(Finn!, at(9, 360), { reaction: '❤️' });
  await note(Eli!, at(9, 390), { reaction: '🤯' });
  await note(Finn!, at(9, 420), { text: 'Flamingos for mallets' });
  await note(Eli!, at(12, 300), { text: 'Who stole the tarts?' });
  return { club, book };
}

/** The club bar shows the groups: two of notes, and four friends on one page under one marker. */
async function expectGroupsOnTheBar(page: Page) {
  await expect(page.getByTestId('bar-comment-group')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId('bar-comment-group').filter({ hasText: '+2' })).toHaveCount(1);
  await expect(page.getByTestId('member-group').filter({ hasText: '+1' })).toBeVisible();
  await expect(page.getByTestId('bar-comment')).toHaveCount(2);
}

test.describe('accessibility (axe) on every page', () => {
  test('sign-in and join pages', async ({ page }) => {
    await page.goto('/signin');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expectAccessible(page, 'sign in');
    const { club } = await clubWithAlice([]);
    await page.goto(`/join/${club.invite}`);
    await expect(page.getByRole('heading', { name: /^Join / })).toBeVisible();
    await expectAccessible(page, 'join');
  });

  test('library, book page and settings', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    await expect(page.getByTestId('book-card')).toHaveCount(1);
    await expectAccessible(page, 'library');
    await page.goto(`/books/${book.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page, 'book');
    // Book settings (D198): the book's formats and Add a format, off the book page's one Continue.
    await openBookSettings(page);
    await expectAccessible(page, 'book settings');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Book settings' })).toHaveCount(0);
    // The next stop (D53): its dialog, then the book page and the library with one set.
    await page.getByTestId('meeting-set').click();
    await expect(page.getByRole('dialog', { name: 'The next stop' })).toBeVisible();
    await expectAccessible(page, 'next stop dialog');
    await page.getByTestId('meeting-save').click();
    await expect(page.getByTestId('meeting-headline')).toBeVisible();
    await expectAccessible(page, 'book with a next stop');
    await page.goto(`/clubs/${club.id}`);
    await expect(page.getByTestId('meeting-line')).toBeVisible();
    await expectAccessible(page, 'library with a next stop');
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expectAccessible(page, 'settings');
    await page.goto(`/clubs/${club.id}/settings`);
    await expect(page.getByRole('heading', { level: 1, name: 'Club settings' })).toBeVisible();
    await expectAccessible(page, 'club settings');
    await ctx.close();
  });

  test('the EPUB reader, its panels and the PDF reader', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expectAccessible(page, 'epub reader');
    await page.getByTestId('open-settings').click();
    await expectAccessible(page, 'reader settings');
    await page.keyboard.press('Escape');
    await page.getByTestId('open-toc').click();
    await expectAccessible(page, 'contents');
    await page.keyboard.press('Escape');
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', '91', { timeout: 30_000 });
    await expectAccessible(page, 'pdf reader');
    await ctx.close();
  });

  test('the audiobook player and the upload dialog', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    // The full player of a book with a text: a device where Settings allows it (D198).
    const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen`);
    await expect(page.getByTestId('play-pause')).toBeVisible();
    await page.getByTestId('toggle-tracks').click();
    await expectAccessible(page, 'listen');
    await page.goto(`/clubs/${club.id}`);
    await page.getByRole('button', { name: 'Add a book' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectAccessible(page, 'upload dialog');
    await ctx.close();
  });

  test('a dialog keeps the field you type in while live updates re-render the page behind it (v1 modal bug)', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}&at=0.2`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await page.getByTestId('add-note').click();
    const field = page.getByTestId('note-text');
    await field.click();
    await expect(field).toBeFocused();
    // Ana reads on while Olive types: every report of hers re-renders the reader around the dialog.
    let section = 2;
    let typing = true;
    const ana = (async () => {
      while (typing) {
        const at = { kind: 'epub' as const, section: section++, offset: 0 };
        await putProgress(club.members.Ana!, book.id, epub.id, at, [{ from: at, to: { ...at, offset: 300 } }]);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    })();
    const text = 'Curiouser and curiouser, typed one key at a time';
    await field.pressSequentially(text, { delay: 40 });
    typing = false;
    await ana;
    expect(section).toBeGreaterThan(4);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(text);
    await ctx.close();
  });

  test('a conversation under a note, the notifications panel, club pages and the listen page reading along', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { audio: 'librivox' });
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    const at = { kind: 'epub' as const, section: 3, offset: 100 };
    await putProgress(club.members.Ana!, book.id, epub.id, at, [{ from: { ...at, offset: 0 }, to: { ...at, offset: 900 } }]);
    // The owner writes where they are reading, as the reader records before a note is posted.
    await putProgress(club.owner, book.id, epub.id, at, [{ from: { ...at, offset: 0 }, to: { ...at, offset: 900 } }]);
    const note = await postComment(club.owner, book.id, { editionId: epub.id, locator: at, text: 'Down the rabbit hole' });
    await club.members.Ana!.api.post(`/api/comments/${note.id}/replies`, { data: { text: 'Falling for ages' } });
    await readAlong(club.owner, book, audio.id);
    // The listen page below is the full player: a device where Settings allows it (D198).
    const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await page.locator(`#note-${note.id}`).getByTestId('reply-open').click();
    await expect(page.locator(`#note-${note.id}`).getByTestId('reply')).toHaveCount(1);
    await expectAccessible(page, 'book page with a conversation and a reply being written');
    await page.getByTestId('bell').click();
    await expect(page.getByTestId('bell-panel')).toBeVisible();
    await expectAccessible(page, 'notifications panel');
    await page.goto(`/clubs/${club.id}/settings`);
    await expect(page.getByRole('heading', { level: 1, name: 'Club settings' })).toBeVisible();
    await expectAccessible(page, 'club settings');
    await page.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await expect(page.getByTestId('readalong')).toBeVisible();
    await expectAccessible(page, 'listen page reading along');
    await ctx.close();
    // A member's page of the club.
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/settings`);
    await expect(ana.getByTestId('leave-club')).toBeVisible();
    await expectAccessible(ana, 'about this club');
    await anaCtx.close();
  });

  test('dialogs trap focus and give it back (v1 modal bug)', async ({ browser }) => {
    const { club } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    const opener = page.getByRole('button', { name: 'Invite' });
    await opener.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Focus stays inside while the dialog re-renders (typing, live updates).
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.waitForTimeout(800);
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await ctx.close();
  });

  test('a club of seven on a phone: the members’ strip scrolls sideways, and the keyboard reaches it', async ({ browser }) => {
    const { club } = await clubWithAlice(['Ana', 'Ben', 'Cleo', 'Dee', 'Eli', 'Finn']);
    const ctx = await browserAs(browser, club.owner, PHONE);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    await expect(page.getByTestId('book-card')).toHaveCount(1);
    const strip = page.getByTestId('members-panel');
    await expect(strip.locator('.presence-item')).toHaveCount(7);
    await expect(strip).toHaveAttribute('data-more', 'right');
    await expectAccessible(page, 'library of seven on a phone');
    // The next stop for the Tab key after the club's own buttons, and the arrow keys scroll it.
    await page.getByRole('link', { name: 'Club settings' }).focus();
    await page.keyboard.press('Tab');
    await expect(strip).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await strip.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect(strip).toHaveAttribute('data-more', 'left');
    await expectAccessible(page, 'library of seven on a phone, the strip scrolled to its end');
    await ctx.close();
    // Where all seven fit, the strip does not scroll, and it is no stop for the Tab key.
    const wideCtx = await browserAs(browser, club.owner, { viewport: { width: 1280, height: 860 }, isMobile: false, hasTouch: false });
    const wide = await wideCtx.newPage();
    await wide.goto(`/clubs/${club.id}`);
    await expect(wide.getByTestId('book-card')).toHaveCount(1);
    const fits = wide.getByTestId('members-panel');
    await expect(fits.locator('.presence-item')).toHaveCount(7);
    expect(await fits.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await expect(fits).toHaveAttribute('data-more', 'none');
    await expect(fits).not.toHaveAttribute('tabindex');
    await expectAccessible(wide, 'library of seven on a wide screen');
    await wideCtx.close();
  });

  test('a lived-in club’s book page: notes close together and friends on one page, gathered on the club bar', async ({ browser }) => {
    const { club, book } = await livedInClub();
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectGroupsOnTheBar(page);
    await expectAccessible(page, 'book page with groups on the club bar');
    await ctx.close();
  });

  test('a lived-in club’s EPUB reader: the club bar’s groups of notes and of friends', async ({ browser }) => {
    const { club, book } = await livedInClub();
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expectGroupsOnTheBar(page);
    await expectAccessible(page, 'epub reader with groups on the club bar');
    // And in each of the reader's other themes, the light ones too: the bar's counts read on the page.
    for (const theme of ['Dusk', 'Sepia', 'Vellum']) {
      await page.getByTestId('open-settings').click();
      // The swatch is the radio's label, as a reader taps it.
      await page.getByRole('dialog', { name: 'Reading settings' }).locator('label.swatch', { hasText: theme }).click();
      await expect(page.getByRole('radio', { name: theme })).toBeChecked();
      await page.keyboard.press('Escape');
      await expectGroupsOnTheBar(page);
      await expectAccessible(page, `epub reader with groups on the club bar, ${theme} theme`);
    }
    await ctx.close();
  });

  test('the audiobook’s controls in the reader’s footer stand out from the page in every theme', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    // Reading, with the audiobook playing over the page (D197, D198): its controls are in the reader's footer.
    await openFromBookPage(page, book, { label: 'Open', kind: 'epub' });
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await listenFromThisPage(page);
    const controls = page.locator('.footer-player .icon-btn').first();
    await expect(controls).toBeVisible();
    /** Contrast of the controls' colour with the page's, as WCAG reckons it (non-text: 3 to 1 at least). */
    const contrast = () =>
      page.evaluate(() => {
        const rgb = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
        const lum = (c: string) => {
          const [r, g, b] = rgb(c).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const fg = lum(getComputedStyle(document.querySelector('.footer-player .icon-btn')!).color);
        const bg = lum(getComputedStyle(document.querySelector('[data-testid="reader"]')!).backgroundColor);
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      });
    for (const theme of ['Lucerna', 'Dusk', 'Sepia', 'Vellum']) {
      await page.getByTestId('open-settings').click();
      await page.getByRole('dialog', { name: 'Reading settings' }).locator('label.swatch', { hasText: theme }).click();
      await page.keyboard.press('Escape');
      expect(await contrast(), `the footer's audiobook controls on the ${theme} page`).toBeGreaterThanOrEqual(3);
      await expectAccessible(page, `epub reader with the audiobook playing, ${theme} theme`);
    }
    await ctx.close();
  });

  test('a lived-in club’s PDF reader: the club bar’s groups of notes and of friends', async ({ browser }) => {
    const { club, book } = await livedInClub();
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', '91', { timeout: 30_000 });
    await expectGroupsOnTheBar(page);
    await expectAccessible(page, 'pdf reader with groups on the club bar');
    await ctx.close();
  });

  test('a lived-in club’s listen page: the club bar’s groups of notes and of friends', async ({ browser }) => {
    const { club, book } = await livedInClub();
    const audio = book.editions.find((e) => e.kind === 'audio')!;
    // The full player of a book with a text: a device where Settings allows it (D198).
    const ctx = await browserAs(browser, club.owner, { audioOnlyView: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/listen?edition=${audio.id}`);
    await expect(page.getByTestId('play-pause')).toBeVisible();
    await expectGroupsOnTheBar(page);
    await expectAccessible(page, 'listen page with groups on the club bar');
    await ctx.close();
  });
});
