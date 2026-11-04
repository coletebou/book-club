import AxeBuilder from '@axe-core/playwright';
import { type BrowserContextOptions, type Locator, type Page, expect, test } from '@playwright/test';
import { type BookDetail, type Edition, type EpubLocator, tToLocator } from '@bookclub/shared';
import { type Person, browserAs, clubWithAlice, expectInFooter, postComment, putProgress, signUp } from '../helpers/api';

/**
 * Fidelity review round 16's rough edges, end to end: a toast that covers no control in the reader
 * or the player (FR143), the question asked as you answer from further on only when a friend is
 * behind you, and the place you had read to named rightly (FR144), and the words of a reaction
 * alone and of the next stop's card (FR147).
 */

const at = (section: number, offset: number): EpubLocator => ({ kind: 'epub', section, offset });
const timeline = (edition: Edition) => ({ geometry: edition.geometry!, sync: edition.sync! });

/** An iPhone 15's screen and a computer's, in both projects. */
const PHONE: BrowserContextOptions = { viewport: { width: 393, height: 659 }, isMobile: true, hasTouch: true };
const COMPUTER: BrowserContextOptions = { viewport: { width: 1280, height: 860 }, isMobile: false, hasTouch: false };
/** A small laptop's window: the header's four buttons leave the toast less room between them. */
const NARROW: BrowserContextOptions = { viewport: { width: 760, height: 800 }, isMobile: false, hasTouch: false };
const SIZES = [
  ['a phone', PHONE],
  ['a computer', COMPUTER],
] as const;

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

/** Alice's chapters by their numerals: each one's spine section. */
async function chapters(owner: Person, publicationUrl: string) {
  const pub = (await (await owner.api.get(publicationUrl)).json()) as { toc: { title: string; section: number }[] };
  return (n: string) => pub.toc.find((e) => e.title.startsWith(`CHAPTER ${n}.`))!.section;
}

/**
 * Every control of the reader or the player that is on screen, and what a finger at its centre
 * reaches if not it: the header's buttons, a look's, the club bar's, the page arrows, the footer's
 * player, the notes' markers, the PDF's view panel, the player's own. Empty: all of them reach.
 */
async function coveredControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('.reader, .listen-page');
    if (!root) return ['no reader or player'];
    const covered: string[] = [];
    let seen = 0;
    for (const el of root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [role="button"]')) {
      if (el.closest('[inert], [hidden]')) continue;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      // Scrolled out of what holds it (the player's tracks under its club bar): not on screen.
      let clipped = false;
      for (let p = el.parentElement; p && p !== root.parentElement && !clipped; p = p.parentElement) {
        if (!/auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowY)) continue;
        const b = p.getBoundingClientRect();
        clipped = x < b.left || x > b.right || y < b.top || y > b.bottom;
      }
      if (clipped) continue;
      seen++;
      const top = document.elementFromPoint(x, y);
      if (top && (top === el || el.contains(top))) continue;
      const by = top?.closest('.toast-region') ? 'a toast' : (top?.closest('[data-testid]')?.getAttribute('data-testid') ?? top?.tagName ?? 'nothing');
      covered.push(`${el.getAttribute('aria-label') ?? el.getAttribute('data-testid') ?? el.textContent?.trim()} is under ${by}`);
    }
    return seen > 3 ? covered : [`only ${seen} controls found`];
  });
}

/** The toasts' region says where it put them (toast-place.ts): over the app's top bar, the header, the foot or the page. */
const region = (page: Page) => page.getByRole('region', { name: 'Messages' });

/** A tap on a touch screen, a click with a mouse. */
const press = (size: BrowserContextOptions, l: Locator) => (size.hasTouch ? l.tap() : l.click());

/** A toast held while it is measured, as it is while it has the focus (D89). */
async function hold(toast: Locator) {
  const dismiss = toast.getByRole('button', { name: 'Dismiss' });
  await dismiss.focus();
  await expect(dismiss).toBeFocused();
  return dismiss;
}

test.describe('a toast covers no control in the reader or the player (fidelity review round 16)', () => {
  for (const kind of ['epub', 'pdf'] as const) {
    for (const [name, size] of SIZES) {
      test(`in the ${kind === 'epub' ? 'EPUB' : 'PDF'} reader on ${name}: a friend’s answer, during a look, and a place read on elsewhere`, async ({ browser }) => {
        const { club, book } = await clubWithAlice(['Ana'], { pdf: kind === 'pdf', audio: 'tiny' });
        const ana = club.members.Ana!;
        const epub = book.editions.find((e) => e.kind === 'epub')!;
        const section = await chapters(club.owner, epub.publicationUrl!);
        const [ch1, ch5, ch7] = [section('I'), section('V'), section('VII')];
        // Olive reads chapter I, with Ana's note at the top of her page and one of her own a few pages
        // on; Ana is in chapter V.
        await putProgress(club.owner, book.id, epub.id, at(ch1, 300), [{ from: at(ch1, 0), to: at(ch1, 4500) }]);
        await putProgress(ana, book.id, epub.id, at(ch5, 100), [{ from: at(ch1, 0), to: at(ch5, 100) }]);
        await postComment(ana, book.id, { editionId: epub.id, locator: at(ch1, 5), text: 'Down the rabbit-hole', reaction: '🤯' });
        const olives = await postComment(club.owner, book.id, { editionId: epub.id, locator: at(ch1, 4000), text: 'The rabbit with a watch' });
        // Only about the passage: it opens with the note, its words in the toast and the sheet.
        const answer = async (text: string) => expect((await ana.api.post(`/api/comments/${olives.id}/replies`, { data: { text, aboutHere: true } })).status()).toBe(201);

        const ctx = await browserAs(browser, club.owner, size);
        const page = await ctx.newPage();
        await page.goto(`/books/${book.id}`);
        await expect(page.getByTestId('live-dot')).toHaveClass(/is-on/);
        await page.getByTestId(`open-${kind}`).click();
        if (kind === 'epub') await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
        else await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', '91', { timeout: 30_000 });
        await expect(page.getByTestId('margin-marker').first()).toBeVisible();
        // Nothing covers anything before a toast comes.
        expect(await coveredControls(page)).toEqual([]);

        // A friend's answer: it covers none of the header's buttons (Back, Listen, Contents, Reading
        // settings, Leave a note), the club bar, the page arrows or the notes' markers.
        await answer('A pocket watch!');
        const toast = page.getByTestId('toast').filter({ hasText: 'Ana replied' });
        await expect(toast).toBeVisible({ timeout: 5000 });
        await hold(toast);
        await expect(region(page)).toHaveAttribute('data-place', size === PHONE ? 'page' : 'header');
        expect(await coveredControls(page)).toEqual([]);
        await expectAccessible(page, `a toast in the ${kind} on ${name}`);
        // And it is there to use.
        await press(size, toast.getByRole('button', { name: 'Show' }));
        await expect(page.getByTestId('marker-sheet').getByTestId('reply')).toContainText('A pocket watch!');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);

        // During a look: "Read from here" and the way back are whole too, wherever they are (D91).
        await press(size, page.getByTestId('open-toc'));
        await press(size, page.getByRole('button', { name: /CHAPTER IV\./ }));
        // (On a phone the look's two buttons are laid out apart, the group around them has no box.)
        await expect(page.getByTestId('back-to-reading')).toBeVisible();
        await expect(page.getByTestId('read-from-here')).toBeVisible();
        await answer('And a waistcoat-pocket.');
        const again = page.getByTestId('toast').filter({ hasText: 'waistcoat' });
        await expect(again).toBeVisible({ timeout: 5000 });
        await hold(again);
        await expect(region(page)).toHaveAttribute('data-place', size === PHONE ? 'page' : 'foot');
        expect(await coveredControls(page)).toEqual([]);
        await expectAccessible(page, `a toast during a look in the ${kind} on ${name}`);
        await press(size, again.getByRole('button', { name: 'Dismiss' }));
        await expect(again).toHaveCount(0);
        await press(size, page.getByTestId('back-to-reading'));
        await expect(page.getByTestId('look-chip')).toHaveCount(0);

        // Read on on another device: "Continue at …" and "Stay here" stay whole for the toast's few seconds.
        await putProgress(club.owner, book.id, epub.id, at(ch7, 0), [{ from: at(ch1, 0), to: at(ch7, 0) }]);
        const elsewhere = page.getByTestId('toast').filter({ hasText: /You read on to .+ on another device\./ });
        await expect(elsewhere).toBeVisible({ timeout: 10_000 });
        await expect(page.getByTestId('look-chip')).toHaveAttribute('data-elsewhere', 'true');
        await expect(region(page)).toHaveAttribute('data-place', size === PHONE ? 'page' : 'foot');
        expect(await coveredControls(page)).toEqual([]);
        await expect(page.getByTestId('read-from-here')).toHaveText('Stay here');
        await ctx.close();
      });
    }
  }

  test('in the PDF on a phone, with its view panel open, a toast comes in under the panel', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { pdf: true });
    const ana = club.members.Ana!;
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const section = await chapters(club.owner, epub.publicationUrl!);
    await putProgress(club.owner, book.id, epub.id, at(section('I'), 300), [{ from: at(section('I'), 0), to: at(section('I'), 300) }]);
    await putProgress(ana, book.id, epub.id, at(section('V'), 100), [{ from: at(section('I'), 0), to: at(section('V'), 100) }]);
    const olives = await postComment(club.owner, book.id, { editionId: epub.id, locator: at(section('I'), 100), text: 'The rabbit with a watch' });
    const ctx = await browserAs(browser, club.owner, PHONE);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await expect(page.getByTestId('live-dot')).toHaveClass(/is-on/);
    await page.getByTestId('open-pdf').click();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', '91', { timeout: 30_000 });
    await page.getByTestId('pdf-view').tap();
    await expect(page.getByTestId('pdf-view-panel')).toBeVisible();
    expect((await ana.api.post(`/api/comments/${olives.id}/replies`, { data: { text: 'A pocket watch!' } })).status()).toBe(201);
    const toast = page.getByTestId('toast').filter({ hasText: 'Ana replied' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await hold(toast);
    const panel = (await page.getByTestId('pdf-view-panel').boundingBox())!;
    expect((await toast.boundingBox())!.y).toBeGreaterThanOrEqual(panel.y + panel.height);
    // The panel lies over the club bar while it is open, as it always has: none of it, and nothing
    // else, is under the toast.
    expect((await coveredControls(page)).filter((c) => c.endsWith('under a toast'))).toEqual([]);
    for (const id of ['zoom-in', 'zoom-out', 'pdf-view', 'open-toc', 'add-note']) await expect(page.getByTestId(id)).toBeVisible();
    await ctx.close();
  });

  test('on a small laptop the header’s fifth button, Listen from your place, stays whole, a toast beside it or over the page', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { audio: 'tiny' });
    const ana = club.members.Ana!;
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const section = await chapters(club.owner, epub.publicationUrl!);
    await putProgress(club.owner, book.id, epub.id, at(section('I'), 300), [{ from: at(section('I'), 0), to: at(section('I'), 300) }]);
    await putProgress(ana, book.id, epub.id, at(section('V'), 100), [{ from: at(section('I'), 0), to: at(section('V'), 100) }]);
    const olives = await postComment(club.owner, book.id, { editionId: epub.id, locator: at(section('I'), 100), text: 'The rabbit with a watch' });
    const ctx = await browserAs(browser, club.owner, NARROW);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await expect(page.getByTestId('live-dot')).toHaveClass(/is-on/);
    await page.getByTestId('open-epub').click();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    expect((await ana.api.post(`/api/comments/${olives.id}/replies`, { data: { text: 'A pocket watch!' } })).status()).toBe(201);
    const toast = page.getByTestId('toast').filter({ hasText: 'Ana replied' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await hold(toast);
    // Ask Cal (D170) shares the header with Contents, Reading settings, Leave a note and Chat
    // (Listen from your place is the footer's, D194, D197): at this width the toast does not
    // fit beside them, and goes over the page instead — every button stays whole either way.
    await expect(region(page)).toHaveAttribute('data-place', 'page');
    await expect(page.getByTestId('listen-here')).toBeVisible();
    expect(await coveredControls(page)).toEqual([]);
    await ctx.close();
  });

  test('on a computer during a look while the audiobook is in the reader’s footer, a toast leaves its controls whole', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana'], { audio: 'tiny' });
    const ana = club.members.Ana!;
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const section = await chapters(club.owner, epub.publicationUrl!);
    await putProgress(club.owner, book.id, epub.id, at(section('I'), 300), [{ from: at(section('I'), 0), to: at(section('I'), 300) }]);
    await putProgress(ana, book.id, epub.id, at(section('V'), 100), [{ from: at(section('I'), 0), to: at(section('V'), 100) }]);
    const olives = await postComment(club.owner, book.id, { editionId: epub.id, locator: at(section('I'), 100), text: 'The rabbit with a watch' });
    const ctx = await browserAs(browser, club.owner, COMPUTER);
    const page = await ctx.newPage();
    // The audiobook in the player first: it stays in the reader's footer.
    await page.goto(`/books/${book.id}/listen`);
    await expect(page.getByTestId('play-pause')).toBeVisible();
    await page.getByRole('link', { name: /^Back to Alice/ }).click();
    await expect(page.getByTestId('live-dot')).toHaveClass(/is-on/);
    await page.getByTestId('open-epub').click();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await expect(page.locator('.reader-footer').getByTestId('footer-play')).toBeVisible();
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER IV\./ }).click();
    await expect(page.getByTestId('back-to-reading')).toBeVisible();
    expect((await ana.api.post(`/api/comments/${olives.id}/replies`, { data: { text: 'A pocket watch!' } })).status()).toBe(201);
    const toast = page.getByTestId('toast').filter({ hasText: 'Ana replied' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await hold(toast);
    await expect(region(page)).toHaveAttribute('data-place', 'page');
    expect(await coveredControls(page)).toEqual([]);
    await ctx.close();
  });

  for (const [name, size] of SIZES) {
    test(`in the player on ${name}: a friend’s answer covers none of its controls`, async ({ browser }) => {
      const { club, book } = await clubWithAlice(['Ana'], { audio: 'tiny' });
      const ana = club.members.Ana!;
      const epub = book.editions.find((e) => e.kind === 'epub')!;
      const section = await chapters(club.owner, epub.publicationUrl!);
      await putProgress(ana, book.id, epub.id, at(section('V'), 100), [{ from: at(section('I'), 0), to: at(section('V'), 100) }]);
      const olives = await postComment(club.owner, book.id, { editionId: epub.id, locator: at(section('I'), 100), text: 'The rabbit with a watch' });
      const ctx = await browserAs(browser, club.owner, size);
      const page = await ctx.newPage();
      await page.goto(`/books/${book.id}`);
      await expect(page.getByTestId('live-dot')).toHaveClass(/is-on/);
      // The full player: the book's text first, the audiobook over it (D197), then a step aside.
      await page.getByTestId('open-audio').click();
      await page.getByTestId('dock-expand').click();
      await page.getByRole('dialog', { name: 'Now in this book' }).getByTestId('open-full-player').click();
      await expect(page.getByTestId('play-pause')).toBeVisible();
      // Paused, as the player stood before listening started from the book page's tap (D197):
      // a playing player's scrubber moves on, and the page never settles for the toast's measure.
      await page.getByTestId('play-pause').click();
      await expect(page.getByTestId('play-pause')).toHaveAttribute('data-playing', 'false');
      expect(await coveredControls(page)).toEqual([]);
      expect((await ana.api.post(`/api/comments/${olives.id}/replies`, { data: { text: 'A pocket watch!' } })).status()).toBe(201);
      const toast = page.getByTestId('toast').filter({ hasText: 'Ana replied' });
      await expect(toast).toBeVisible({ timeout: 5000 });
      await hold(toast);
      // Between the header's two buttons, over the title, on a phone too: Ask Cal (D170) is the
      // floating launcher there instead (CalLauncher.tsx); Chat (D173, no floating form of its
      // own) moves into the player's own content there instead (live.spec.ts), so the header
      // still has only Back and Track list for the toast to sit beside.
      await expect(region(page)).toHaveAttribute('data-place', 'header');
      expect(await coveredControls(page)).toEqual([]);
      await expectAccessible(page, `a toast in the player on ${name}`);
      // Scrolled down to its tracks, it covers none of them either.
      await press(size, page.getByTestId('toggle-tracks'));
      await page.locator('.listen-main').evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await expect(page.locator('.track-item').last()).toBeInViewport();
      expect(await coveredControls(page)).toEqual([]);
      await ctx.close();
    });
  }
});

test.describe('answering from further on (fidelity review round 16)', () => {
  test('with every friend past you there is nothing to ask; the answer is named where you were; a friend behind you is named in the question', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben', 'Cleo', 'Cole']);
    const [ana, ben, cleo, cole] = [club.members.Ana!, club.members.Ben!, club.members.Cleo!, club.members.Cole!];
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const place = (t: number) => tToLocator(timeline(epub), t) as EpubLocator;
    const readTo = (p: Person, t: number) => putProgress(p, book.id, epub.id, place(t), [{ from: at(0, 0), to: place(t) }]);
    const detail = (await (await club.owner.api.get(`/api/books/${book.id}`)).json()) as BookDetail;
    const chapter3 = detail.chapters.find((c) => c.title.startsWith('CHAPTER III.'))!.t;
    // Cleo's note at 13 % (Chapter 2); Cole at 16 %, just into Chapter 3; Ana at 58 %, Ben at 18 %,
    // Cleo at 71 %, and Olive, the organiser, past him too: all of them further than he is.
    await readTo(cleo, 0.14);
    const note = await postComment(cleo, book.id, { editionId: epub.id, locator: place(0.13), text: 'The Pool of Tears' });
    for (const [p, t] of [[cleo, 0.71], [ana, 0.58], [ben, 0.18], [club.owner, 0.3], [cole, 0.16]] as const) await readTo(p, t);
    expect(0.16).toBeGreaterThan(chapter3);

    const ctx = await browserAs(browser, cole);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    const thread = page.locator(`#note-${note.id}`);
    await thread.getByTestId('reply-open').click();
    await thread.getByTestId('reply-text').fill('Alice swims in her own tears');
    // Nothing to ask: one Send.
    await expect(thread.getByTestId('reply-from-further')).toHaveCount(0);
    await expect(thread.getByTestId('reply-send-about-here')).toHaveCount(0);
    await thread.getByTestId('reply-send').click();
    const mine = thread.getByTestId('reply').filter({ hasText: 'Alice swims in her own tears' });
    await expect(mine).toBeVisible();
    // Where he was is Chapter 3, as the book names it, not a page back in Chapter 2 (FR144). The
    // writer is no longer told this on the page itself (Cole did not want it, fidelity feedback);
    // the horizon it is held for is still real, so read it from the API.
    const afterSend = (await (await page.request.get(`/api/books/${book.id}/comments`)).json()) as { text: string | null; horizon?: string | null }[];
    expect(afterSend.find((r) => r.text === 'Alice swims in her own tears')?.horizon).toBe('Chapter 3');

    // Fern joins and reads to Cleo's note: the answer waits for her, and says from where.
    const fern = await signUp(club.invite, 'Fern');
    await readTo(fern, 0.135);
    const ferns = await browserAs(browser, fern);
    const fernPage = await ferns.newPage();
    await fernPage.goto(`/books/${book.id}`);
    await expect(fernPage.locator(`#note-${note.id}`).getByTestId('reply-held')).toContainText('Cole replied from Chapter 3 · it opens when you get there');
    await ferns.close();

    // Now a friend has not read as far as Cole: he is asked, and told who.
    await page.reload();
    await thread.getByTestId('reply-open').click();
    await thread.getByTestId('reply-text').fill('The mouse swims too');
    await expect(thread.getByTestId('reply-from-further')).toHaveText('Fern has not read as far as you: your answer waits until they have, unless it is only about this passage.');
    await expectAccessible(page, 'the reply form, a friend behind you');
    await thread.getByTestId('reply-send-about-here').click();
    await expect(thread.getByTestId('reply').filter({ hasText: 'The mouse swims too' })).toBeVisible();
    // Sent "only about this passage": it waits for nobody, so it carries no horizon at all.
    const afterAboutHere = (await (await page.request.get(`/api/books/${book.id}/comments`)).json()) as { text: string | null; horizon?: string | null }[];
    expect(afterAboutHere.find((r) => r.text === 'The mouse swims too')?.horizon).toBeFalsy();
    await ctx.close();
  });
});

test.describe('the words of a reaction alone and of the next stop (fidelity review round 16)', () => {
  test('a reaction with no words ahead of you says whose and which it is, and promises nothing more', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana']);
    const ana = club.members.Ana!;
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const section = await chapters(club.owner, epub.publicationUrl!);
    await putProgress(ana, book.id, epub.id, at(section('IX'), 0), [{ from: at(section('I'), 0), to: at(section('IX'), 0) }]);
    const reaction = await postComment(ana, book.id, { editionId: epub.id, locator: at(section('VIII'), 400), quote: 'Off with her head!', reaction: '😱' });
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    const line = page.locator(`#note-${reaction.id} .note-locked`);
    await expect(line).toHaveText('Ana reacted 😱 here, with no words.');
    await expect(page.locator(`#note-${reaction.id}`)).not.toContainText('when you get there');
    // On the bar, its sheet says the same, with nothing to open.
    await page.getByTestId('bar-comment').filter({ hasText: '😱' }).click();
    const sheet = page.getByTestId('marker-sheet');
    await expect(sheet.getByTestId('sheet-reaction-alone')).toHaveText('Ana reacted 😱 here, with no words.');
    await expect(sheet).not.toContainText('Off with her head!');
    await expect(sheet.getByTestId('sheet-read-here')).toHaveCount(0);
    await expectAccessible(page, 'a reaction alone, ahead of you');
    await ctx.close();
  });

  test('on a phone the next stop’s card says all of it', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben', 'Cleo']);
    const [ana, ben, cleo] = [club.members.Ana!, club.members.Ben!, club.members.Cleo!];
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const section = await chapters(club.owner, epub.publicationUrl!);
    const [ch1, ch2] = [section('I'), section('II')];
    await putProgress(ana, book.id, epub.id, at(ch1, 300), [{ from: at(ch1, 0), to: at(ch1, 300) }]);
    await postComment(ana, book.id, { editionId: epub.id, locator: at(ch1, 300), text: 'Down the rabbit-hole we go', reaction: '🤯' });
    for (const p of [ana, cleo]) await putProgress(p, book.id, epub.id, at(ch2, 300), [{ from: at(ch1, 0), to: at(ch2, 300) }]);
    await putProgress(ben, book.id, epub.id, at(ch1, 0), [{ from: at(ch1, 0), to: at(ch1, 600) }]);
    const detail = (await (await club.owner.api.get(`/api/books/${book.id}`)).json()) as BookDetail;
    const end1 = detail.chapters.find((c) => c.title.startsWith('CHAPTER II.'))!.t;
    expect((await ana.api.put(`/api/books/${book.id}/meeting`, { data: { t: end1, on: null } })).status()).toBe(200);
    const ctx = await browserAs(browser, ben, PHONE);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    const reader = page.getByTestId('reader');
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER II\./ }).click();
    await expect(reader).toHaveAttribute('data-section', String(ch2), { timeout: 15_000 });
    await page.getByTestId('prev-page').tap();
    await expect(reader).toHaveAttribute('data-section', String(ch1));
    await page.getByTestId('read-from-here').tap();
    await page.getByTestId('next-page').tap();
    const card = page.getByTestId('meeting-reached');
    await expect(card).toContainText('You’re at the next stop, with Ana and Cleo.');
    await expect(card.getByTestId('meeting-show-notes')).toHaveText('Show Ana’s note');
    // All of it said: nothing cut at the card's edge (it was cut at "Ana and Cleo are…"), inside the footer.
    const line = card.locator('span').first();
    expect(await line.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expectInFooter(page, card);
    await expectAccessible(page, 'the next stop’s card on a phone');
    await ctx.close();
  });
});
