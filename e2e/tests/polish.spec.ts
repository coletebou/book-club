import { readdirSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import type { BookDetail, CommentView } from '@bookclub/shared';
import { ALICE_EPUB, ALICE_PDF, ALICE_TINY_DIR, browserAs, clubWithAlice, makeClub, makeOutsider, postComment, putProgress, signUp } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';

/**
 * Fidelity review round 14's rough edges, end to end: questions asked in the app's own dialog, the
 * home page with two clubs, an invite opened by a member, the upload dialog on a phone, and a
 * notification landing on its note.
 */

const at = (section: number, offset: number) => ({ kind: 'epub' as const, section, offset });

/** An iPhone 15's screen, in both projects. */
const PHONE = { viewport: { width: 393, height: 659 }, isMobile: true, hasTouch: true };

/** Zero serious or critical WCAG 2.1 A/AA violations on the page as rendered (as tests/a11y.spec.ts). */
async function expectAccessible(page: Page, label: string) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity || a.playState === 'finished'));
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`),
    `${label} has serious or critical accessibility violations`,
  ).toEqual([]);
}

/** Every dialog the browser itself shows on the page (there should be none). */
function nativeDialogs(page: Page): string[] {
  const shown: string[] = [];
  page.on('dialog', (d) => {
    shown.push(d.message());
    void d.dismiss();
  });
  return shown;
}

test.describe('asking before something is done for good, in the app’s own dialog', () => {
  test('the safe answer has the focus, Escape and the close button answer no, the keyboard stays in it, and a yes from the keyboard does it', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    const native = nativeDialogs(page);
    const deletes: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'DELETE' && r.url().includes('/api/editions/')) deletes.push(r.url());
    });
    await page.goto(`/books/${book.id}`);
    const pdfRow = page.getByTestId('edition').filter({ hasText: 'PDF' });
    const question = page.getByRole('alertdialog', { name: `Delete the PDF of “${book.title}”?` });
    const ask = async () => {
      await pdfRow.getByTestId('format-menu').click();
      await pdfRow.getByRole('button', { name: 'Delete the PDF' }).click();
      await expect(question).toBeVisible();
    };
    await ask();
    await expect(question).toHaveAccessibleDescription('The book and its notes stay.');
    await expect(question.getByRole('button', { name: 'Keep' })).toBeFocused();
    await expectAccessible(page, 'a question before deleting a format');
    // The keyboard goes round its buttons and stays in it.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      expect(await question.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(question).toHaveCount(0);
    await ask();
    await question.getByRole('button', { name: 'Close' }).click();
    await expect(question).toHaveCount(0);
    await ask();
    await question.getByRole('button', { name: 'Keep' }).click();
    await expect(question).toHaveCount(0);
    await expect(page.getByTestId('edition')).toHaveCount(2);
    expect(deletes).toEqual([]);
    // Yes, from the keyboard: the PDF goes; the book and its EPUB stay.
    await ask();
    await question.getByRole('button', { name: 'Delete' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('edition')).toHaveCount(1);
    await expect(page.getByTestId('edition')).toHaveAttribute('data-kind', 'epub');
    expect(deletes).toHaveLength(1);
    expect(native).toEqual([]);
    await ctx.close();
  });

  test('over the contents, Escape answers the question alone, and the contents keep the keyboard', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await postComment(club.members.Ana!, book.id, { editionId: epub.id, locator: at(4, 50), text: 'Caucus race!' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    const native = nativeDialogs(page);
    await page.goto(`/books/${book.id}/read?edition=${epub.id}&at=0.5`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await page.getByTestId('open-toc').click();
    const contents = page.getByRole('dialog', { name: 'Contents' });
    await page.getByTestId('read-up-to-here').click();
    const question = page.getByRole('alertdialog', { name: 'Mark everything up to this page as read?' });
    await expect(question).toHaveAccessibleDescription('Friends’ notes before here will show in full.');
    await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(question).toHaveCount(0);
    await expect(contents).toBeVisible();
    // Nothing was marked: Ana's note is still closed.
    const closed = (await (await page.request.get(`/api/books/${book.id}/comments`)).json()) as CommentView[];
    expect(closed[0]!.hidden).toBe(true);
    // The contents have the keyboard again: Escape closes them.
    await page.keyboard.press('Escape');
    await expect(contents).toHaveCount(0);
    // And a yes marks it.
    await page.getByTestId('open-toc').click();
    await page.getByTestId('read-up-to-here').click();
    await answerQuestion(page, 'Mark everything up to this page as read?', 'Mark as read');
    await expect(page.getByText('1 note before here is now open to you.')).toBeVisible();
    expect(native).toEqual([]);
    await ctx.close();
  });

  test('an answer under a note, a member and the club itself go only when their question is answered yes', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const { Ana, Ben } = club.members;
    await putProgress(Ana!, book.id, epub.id, at(3, 0), [{ from: at(3, 0), to: at(3, 900) }]);
    const note = await postComment(Ana!, book.id, { editionId: epub.id, locator: at(3, 200), text: 'Down, down, down' });
    await putProgress(Ben!, book.id, epub.id, at(3, 0), [{ from: at(3, 0), to: at(3, 900) }]);
    expect((await Ben!.api.post(`/api/comments/${note.id}/replies`, { data: { text: 'The marmalade jar!' } })).status()).toBe(201);

    // Ben takes his answer back, once he says so.
    const benCtx = await browserAs(browser, Ben!);
    const ben = await benCtx.newPage();
    const native = nativeDialogs(ben);
    await ben.goto(`/books/${book.id}`);
    const reply = ben.locator(`#note-${note.id}`).getByTestId('reply');
    await reply.getByRole('button', { name: 'Delete' }).click();
    await answerQuestion(ben, 'Delete your reply?', 'Keep');
    await expect(reply).toContainText('The marmalade jar!');
    await reply.getByRole('button', { name: 'Delete' }).click();
    await answerQuestion(ben, 'Delete your reply?', 'Delete');
    await expect(reply).toHaveCount(0);
    expect(native).toEqual([]);
    await benCtx.close();

    // The owner removes Ben, told what follows; Ana leaves, told she can come back.
    const ownerCtx = await browserAs(browser, club.owner);
    const owner = await ownerCtx.newPage();
    const ownerNative = nativeDialogs(owner);
    await owner.goto(`/clubs/${club.id}/settings`);
    const benRow = owner.locator('.member-admin li').filter({ hasText: 'Ben' });
    await benRow.getByRole('button', { name: 'Remove' }).click();
    const removing = owner.getByRole('alertdialog', { name: `Remove Ben from ${club.name}?` });
    await expect(removing).toHaveAccessibleDescription('Their notes stay. The invite link is replaced, so the one they had no longer works.');
    await removing.getByRole('button', { name: 'Cancel' }).click();
    await expect(benRow).toBeVisible();
    await benRow.getByRole('button', { name: 'Remove' }).click();
    await answerQuestion(owner, `Remove Ben from ${club.name}?`, 'Remove');
    await expect(benRow).toHaveCount(0);
    expect((await Ben!.api.get(`/api/clubs/${club.id}`)).status()).toBe(404);
    expect(ownerNative).toEqual([]);
    await ownerCtx.close();

    const anaCtx = await browserAs(browser, Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/settings`);
    await ana.getByTestId('leave-club').click();
    const leaving = ana.getByRole('alertdialog', { name: `Leave ${club.name}?` });
    await expect(leaving).toHaveAccessibleDescription('Your notes stay for the others. You can come back with the club’s invite link.');
    await leaving.getByRole('button', { name: 'Stay' }).click();
    await expect(leaving).toHaveCount(0);
    expect((await Ana!.api.get(`/api/clubs/${club.id}`)).status()).toBe(200);
    await anaCtx.close();
  });

  test('stopping an upload is asked first, and the question goes by itself once the upload is through', async ({ browser }) => {
    const club = await makeClub([]);
    // The service worker stays out, so that the slow connection below reaches every request.
    const ctx = await browserAs(browser, club.owner, { serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const native = nativeDialogs(page);
    // Hotel Wi-Fi: each piece of an upload takes three seconds to go (to the real server).
    let pieces = 0;
    await page.route('**/api/uploads**', async (route) => {
      pieces++;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue().catch(() => undefined);
    });
    await page.goto(`/clubs/${club.id}`);
    const upload = page.getByRole('dialog', { name: 'Add a book' });
    await page.getByRole('button', { name: 'Add a book' }).click();
    await page.getByTestId('file-input').setInputFiles(ALICE_EPUB);
    await page.getByTestId('upload-start').click();
    await expect(page.getByTestId('upload-progress')).toBeVisible();
    // A stray tap on Cancel: asked, and it keeps going.
    await upload.getByRole('button', { name: 'Cancel' }).click();
    await answerQuestion(page, 'Stop this upload?', 'Keep uploading');
    await expect(page.getByTestId('upload-progress')).toBeVisible();
    // Asked again and left: once the upload is through, the question goes and the book opens.
    await upload.getByRole('button', { name: 'Close' }).click();
    const question = page.getByRole('alertdialog', { name: 'Stop this upload?' });
    await expect(question).toHaveAccessibleDescription('What was sent so far is discarded.');
    await expect(page).toHaveURL(/\/books\/[^/]+$/, { timeout: 60_000 });
    await expect(question).toHaveCount(0);
    const bookId = page.url().split('/books/')[1]!;

    // Another one, stopped: what was sent is discarded, and the book gains no format.
    await page.goto(`/clubs/${club.id}`);
    await page.getByRole('button', { name: 'Add a book' }).click();
    await page.getByTestId('file-input').setInputFiles(ALICE_PDF);
    await expect(page.getByTestId('upload-title')).not.toHaveValue('');
    const before = pieces;
    await page.getByTestId('upload-start').click();
    await expect(page.getByTestId('upload-progress')).toBeVisible();
    // Under way, its files on their way to the server.
    await expect.poll(() => pieces).toBeGreaterThan(before);
    const discarded = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/imports/'));
    await upload.getByRole('button', { name: 'Cancel' }).click();
    await answerQuestion(page, 'Stop this upload?', 'Stop');
    await expect(upload).toHaveCount(0);
    expect((await discarded).status()).toBe(204);
    const books = (await (await page.request.get(`/api/clubs/${club.id}/books`)).json()) as unknown[];
    expect(books).toHaveLength(1);
    const detail = (await (await page.request.get(`/api/books/${bookId}`)).json()) as BookDetail;
    expect(detail.editions.map((e) => e.kind)).toEqual(['epub']);
    expect(native).toEqual([]);
    await ctx.close();
  });
});

test.describe('opening the app with two clubs', () => {
  test('a member of two clubs reaches the place they read or heard last in one tap, whichever club it is in', async ({ browser }) => {
    const thursday = await clubWithAlice(['Ana']);
    const poetry = await clubWithAlice([], { audio: 'tiny' });
    const epub = thursday.book.editions.find((e) => e.kind === 'epub')!;
    const audio = poetry.book.editions.find((e) => e.kind === 'audio')!;
    // Two friends in both clubs: Pat listened last (in the second club), Quinn read last (in the first).
    const pat = await signUp(thursday.club.invite, 'Pat');
    const quinn = await signUp(thursday.club.invite, 'Quinn');
    for (const who of [pat, quinn]) expect((await who.api.post(`/api/invites/${poetry.club.invite}/accept`)).ok()).toBe(true);
    const read = (who: typeof pat) => putProgress(who, thursday.book.id, epub.id, at(6, 0), [{ from: at(2, 0), to: at(6, 0) }]);
    const listen = (who: typeof pat) =>
      putProgress(who, poetry.book.id, audio.id, { kind: 'audio', track: 2, ms: 1500 }, [{ from: { kind: 'audio', track: 0, ms: 0 }, to: { kind: 'audio', track: 2, ms: 1500 } }]);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
    await read(pat);
    await pause();
    await listen(pat);
    await listen(quinn);
    await pause();
    await read(quinn);

    // Ana, in one club only, still goes straight into it; she is reading its book now.
    const anaCtx = await browserAs(browser, thursday.club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto('/');
    await expect(ana).toHaveURL(new RegExp(`/clubs/${thursday.club.id}$`));
    await ana.goto(`/books/${thursday.book.id}/read`);
    await expect(ana.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });

    const patCtx = await browserAs(browser, pat);
    const page = await patCtx.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Your clubs' })).toBeVisible();
    const banner = page.getByTestId('continue-banner');
    // On the first screen, whatever the phone: the audiobook, in the club it is in.
    await expect(banner).toBeInViewport({ ratio: 1 });
    await expect(banner).toContainText(poetry.book.title);
    await expect(banner).toContainText(poetry.club.name);
    await expect(banner).toContainText('Listen on');
    // Under each club, its books, and who is reading what.
    const first = page.locator(`[data-testid="club-card"][data-club="${thursday.club.id}"]`);
    const second = page.locator(`[data-testid="club-card"][data-club="${poetry.club.id}"]`);
    await expect(first.getByRole('link', { name: thursday.book.title })).toHaveAttribute('href', `/books/${thursday.book.id}`);
    await expect(first.getByTestId('club-now')).toHaveText(`Ana is reading “${thursday.book.title}” now`, { timeout: 10_000 });
    await expect(second.getByTestId('shelf-book')).toHaveCount(1);
    // Quinn has begun the club's audiobook too: the second club says so.
    await expect(second.getByTestId('club-now')).toHaveText(`Quinn is listening to “${poetry.book.title}”`);
    await expect(second.getByRole('img', { name: poetry.book.title })).toBeVisible();
    await expectAccessible(page, 'home with two clubs');
    // One tap: the player, at the place.
    await banner.click();
    const player = page.getByTestId('listen-page');
    await expect(player).toHaveAttribute('data-track', '2', { timeout: 15_000 });
    expect(Math.abs(Number(await player.getAttribute('data-ms')) - 1500)).toBeLessThan(1000);
    await patCtx.close();

    // Quinn read last, in the other club: one tap opens the reader at the page.
    const quinnCtx = await browserAs(browser, quinn);
    const other = await quinnCtx.newPage();
    await other.goto('/');
    const hers = other.getByTestId('continue-banner');
    await expect(hers).toBeInViewport({ ratio: 1 });
    await expect(hers).toContainText(thursday.club.name);
    await expect(hers).toContainText('Read on');
    await hers.click();
    await expect(other.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(other.getByTestId('reader')).toHaveAttribute('data-section', '6');
    await Promise.all([quinnCtx.close(), anaCtx.close()]);
  });
});

test.describe('an invite link opened by someone already in the club', () => {
  test('says they are in it, and opens the club in one tap, joining nothing', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    const accepts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/accept')) accepts.push(r.url());
    });
    await page.goto(`/join/${club.invite}`);
    await expect(page.getByRole('heading', { level: 1, name: `You are already in ${club.name}` })).toBeVisible();
    await expect(page.getByText('This invite is for a club you are in: there is nothing to join.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Join/ })).toHaveCount(0);
    await expectAccessible(page, 'an invite opened by a member');
    await page.getByRole('link', { name: 'Open the club' }).click();
    await expect(page).toHaveURL(new RegExp(`/clubs/${club.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: club.name })).toBeVisible();
    expect(accepts).toEqual([]);
    const detail = (await (await club.owner.api.get(`/api/clubs/${club.id}`)).json()) as { memberCount: number };
    expect(detail.memberCount).toBe(2);
    await ctx.close();
  });

  test('others see it as before: someone signed in joins in one tap, a newcomer makes an account', async ({ browser }) => {
    const club = await makeClub(['Ana']);
    const sam = await makeOutsider('Sam');
    const ctx = await browserAs(browser, sam);
    const page = await ctx.newPage();
    await page.goto(`/join/${club.invite}`);
    await expect(page.getByRole('heading', { level: 1, name: `Join ${club.name}` })).toBeVisible();
    await expect(page.getByText(/invited you to read with/)).toBeVisible();
    await page.getByRole('button', { name: 'Join as Sam' }).click();
    await expect(page).toHaveURL(new RegExp(`/clubs/${club.id}$`));
    await ctx.close();
    const newcomer = await browser.newContext();
    const fresh = await newcomer.newPage();
    await fresh.goto(`/join/${club.invite}`);
    await expect(fresh.getByRole('heading', { level: 1, name: `Join ${club.name}` })).toBeVisible();
    await expect(fresh.getByRole('button', { name: 'Join the club' })).toBeVisible();
    await expect(fresh.getByText(/You are already in/)).toHaveCount(0);
    await newcomer.close();
  });
});

test.describe('the upload dialog on a phone', () => {
  test('“Is this another format…” sits inside its box, never crossed by its border', async ({ browser }) => {
    const { club } = await clubWithAlice([]);
    for (const width of [393, 375]) {
      const ctx = await browserAs(browser, club.owner, { ...PHONE, viewport: { width, height: 700 } });
      const page = await ctx.newPage();
      await page.goto(`/clubs/${club.id}`);
      await page.getByRole('button', { name: 'Add a book' }).click();
      await page.getByTestId('file-input').setInputFiles(readdirSync(ALICE_TINY_DIR).filter((f) => !f.endsWith('.txt')).map((f) => path.join(ALICE_TINY_DIR, f)));
      // Still named by its heading, for a screen reader.
      const box = page.getByRole('group', { name: 'Is this another format of a book you already have?' });
      await expect(box).toBeVisible();
      const legend = box.locator('legend');
      const choice = box.locator('label').first();
      const [b, l, c] = [(await box.boundingBox())!, (await legend.boundingBox())!, (await choice.boundingBox())!];
      // Two lines at a phone's width, as the reviewer saw it.
      const lineHeight = await legend.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
      expect(l.height).toBeGreaterThan(1.5 * lineHeight);
      // The whole heading below the box's top border, inside its sides, and above its first choice.
      expect(l.y).toBeGreaterThanOrEqual(b.y + 2);
      expect(l.x).toBeGreaterThanOrEqual(b.x + 2);
      expect(l.x + l.width).toBeLessThanOrEqual(b.x + b.width - 2);
      expect(l.y + l.height).toBeLessThanOrEqual(c.y);
      await ctx.close();
    }
  });
});

test.describe('a notification takes you to its note', () => {
  /** Ana's note in chapter 2, after six of Cleo's; Ben has read to it (Ana is told) and answered it (told again). */
  async function conversation() {
    const { club, book } = await clubWithAlice(['Ana', 'Ben', 'Cleo']);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const { Ana, Ben, Cleo } = club.members;
    await putProgress(Cleo!, book.id, epub.id, at(2, 0), [{ from: at(2, 0), to: at(2, 900) }]);
    for (let i = 0; i < 6; i++) await postComment(Cleo!, book.id, { editionId: epub.id, locator: at(2, 100 + i * 100), text: `Cleo’s note ${i + 1}, about the rabbit hole and how long it goes on for` });
    await putProgress(Ana!, book.id, epub.id, at(3, 0), [{ from: at(3, 0), to: at(3, 900) }]);
    const note = await postComment(Ana!, book.id, { editionId: epub.id, locator: at(3, 200), text: 'Down, down, down: I love this bit' });
    await putProgress(Ben!, book.id, epub.id, at(3, 0), [{ from: at(2, 0), to: at(3, 900) }]);
    const res = await Ben!.api.post(`/api/comments/${note.id}/replies`, { data: { text: 'Me too, the marmalade jar!' } });
    expect(res.status()).toBe(201);
    const reply = (await res.json()) as CommentView;
    return { club, book, note, reply };
  }

  test('tapping one brings the note, or the answer in its conversation, into view, marked in gold and focused', async ({ browser }) => {
    const { club, book, note, reply } = await conversation();
    const ctx = await browserAs(browser, club.members.Ana!);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    const bell = page.getByTestId('bell');
    await expect(bell).toHaveAttribute('data-unread', '2');

    // "Ben replied": the answer, in its note's conversation.
    await bell.click();
    await page.getByTestId('notification').filter({ hasText: 'Ben replied' }).click();
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}#note-${note.id}$`));
    const answer = page.locator(`#note-${note.id} [data-comment="${reply.id}"]`);
    await expect(answer).toContainText('Me too, the marmalade jar!');
    await expect(answer).toBeInViewport();
    await expect(answer).toHaveAttribute('data-arrived', 'true');
    await expect(answer).toBeFocused();
    // Marked: a gold ring around it, over a wash of gold that fades.
    const mark = await answer.evaluate((el) => {
      const s = getComputedStyle(el);
      return { ring: `${s.outlineStyle} ${s.outlineWidth}`, fading: s.animationName };
    });
    expect(mark).toEqual({ ring: 'solid 2px', fading: 'arrive' });
    await expectAccessible(page, 'the book page at a notification’s answer');

    // "Ben got to your note": the note itself, from the same page; the answer's mark goes.
    await bell.click();
    await page.getByTestId('notification').filter({ hasText: 'Ben got to your note' }).click();
    const target = page.locator(`#note-${note.id}`);
    await expect(target).toHaveAttribute('data-arrived', 'true');
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport();
    await expect(answer).not.toHaveAttribute('data-arrived', 'true');
    // Six of Cleo's notes come first: the page did not open at the note by itself.
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    await ctx.close();
  });

  test('with less motion, the mark is there at once and stays, without a glow that fades', async ({ browser }) => {
    const { club, book, note, reply } = await conversation();
    const ctx = await browserAs(browser, club.members.Ana!, { reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await page.getByTestId('bell').click();
    await page.getByTestId('notification').filter({ hasText: 'Ben replied' }).click();
    const answer = page.locator(`#note-${note.id} [data-comment="${reply.id}"]`);
    await expect(answer).toHaveAttribute('data-arrived', 'true');
    await expect(answer).toBeFocused();
    await expect(answer).toBeInViewport();
    const style = await answer.evaluate((el) => {
      const s = getComputedStyle(el);
      return { animation: s.animationName, background: s.backgroundColor, ring: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` };
    });
    // D117 restyle: --gold-wash and --gold-dim repainted from the manuscript palette (vellum,
    // the default light theme here) — --sanguine-wash and --rule, not the old gold.
    expect(style).toEqual({ animation: 'none', background: 'rgba(184, 85, 47, 0.12)', ring: 'solid 2px rgb(180, 154, 116)' });
    await ctx.close();
  });
});
