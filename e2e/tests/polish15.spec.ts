import AxeBuilder from '@axe-core/playwright';
import { type BrowserContextOptions, type Locator, type Page, type TestInfo, expect, test } from '@playwright/test';
import type { BookDetail } from '@bookclub/shared';
import { type Person, aliceEpub, browserAs, clubWithAlice, expectInFooter, makeClub, postComment, putProgress, uploadBook } from '../helpers/api';
import { answerQuestion } from '../helpers/confirm';

/**
 * Fidelity review round 15's rough edges, end to end (D89 to D92): a toast that can be used ("Show") and
 * never covers what you need, an opened answer told only in its conversation and by name, your own
 * marker on the club bar with friends at your place, the way back from a look off the club bar,
 * and the next stop naming whose note it offers and each chapter's title.
 */

const at = (section: number, offset: number) => ({ kind: 'epub' as const, section, offset });

/** An iPhone 15's screen and a computer's, in both projects. */
const PHONE: BrowserContextOptions = { viewport: { width: 393, height: 659 }, isMobile: true, hasTouch: true };
const COMPUTER: BrowserContextOptions = { viewport: { width: 1280, height: 860 }, isMobile: false, hasTouch: false };

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

async function ready(page: Page) {
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

/** Alice's chapters by their numerals: each one's spine section, and where it ends. */
async function chapters(owner: Person, publicationUrl: string) {
  const pub = (await (await owner.api.get(publicationUrl)).json()) as { sections: { textLength: number }[]; toc: { title: string; section: number }[] };
  const section = (n: string) => pub.toc.find((e) => e.title.startsWith(`CHAPTER ${n}.`))!.section;
  return { section, end: (n: string) => at(section(n), pub.sections[section(n)]!.textLength) };
}

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(l: Locator): Promise<Box> {
  const box = await l.boundingBox();
  expect(box, 'on screen').not.toBeNull();
  return box!;
}

/** Whether two boxes share more than a hair. */
function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
}

/** Nothing is drawn over the middle of it: a finger there reaches it. */
async function expectUncovered(l: Locator, what: string) {
  const reached = await l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!top && (top === el || el.contains(top));
  });
  expect(reached, `${what} is covered`).toBe(true);
}

/** A tap on a touch screen, a click with a mouse. */
const press = (touch: boolean | undefined, l: Locator) => (touch ? l.tap() : l.click());
const touchOf = (testInfo: TestInfo) => !!testInfo.project.use.hasTouch;

/** Every message the toasts say on this page, recorded as they come (some go before a test looks). */
async function recordToasts(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const told: string[] = [];
    (window as unknown as { told: string[] }).told = told;
    new MutationObserver(() => {
      for (const t of document.querySelectorAll('.toast-text')) if (!told.includes(t.textContent ?? '')) told.push(t.textContent ?? '');
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  return () => page.evaluate(() => (window as unknown as { told: string[] }).told);
}

test.describe('a toast you can use, where it covers nothing (D89)', () => {
  test('a friend’s answer reaches you in the reader: it stays to be used, and Show opens the conversation there', async ({ browser }, testInfo) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const [ana, ben] = [club.members.Ana!, club.members.Ben!];
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await putProgress(ana, book.id, epub.id, at(3, 0), [{ from: at(3, 0), to: at(3, 900) }]);
    const note = await postComment(ana, book.id, { editionId: epub.id, locator: at(3, 200), text: 'Down, down, down: would the fall never come to an end?' });
    await putProgress(ben, book.id, epub.id, at(3, 0), [{ from: at(3, 0), to: at(3, 900) }]);
    const answer = async (text: string) => expect((await ben.api.post(`/api/comments/${note.id}/replies`, { data: { text } })).status()).toBe(201);

    const ctx = await browserAs(browser, ana);
    const page = await ctx.newPage();
    // Live, and still live as she opens the book.
    await page.goto(`/books/${book.id}`);
    await expect(page.getByTestId('live-dot')).toHaveClass(/is-on/);
    await page.getByTestId('open-epub').click();
    await ready(page);

    await answer('Me too, the marmalade jar!');
    const toast = page.getByTestId('toast').filter({ hasText: 'Ben replied' });
    // In the reader of the book, which book goes without saying.
    await expect(toast.locator('.toast-text')).toHaveText('Ben replied: “Me too, the marmalade jar!”', { timeout: 5000 });
    const arrived = Date.now();
    // Said politely, in a region of its own.
    await expect(page.getByRole('region', { name: 'Messages' })).toHaveAttribute('aria-live', 'polite');
    // Never over the club bar or the reader's foot; over the page only on a phone, whose header has
    // no room for it: just under the club bar, over the top of the page (fidelity review round 16).
    const box = await boxOf(toast);
    const area = await boxOf(page.locator('.reader-area'));
    if (touchOf(testInfo)) expect(box.y + box.height, 'over more than the top of the page').toBeLessThanOrEqual(area.y + 56);
    else expect(overlap(box, area), 'over the page').toBe(false);
    expect(overlap(box, await boxOf(page.locator('.reader-footer'))), 'over the footer').toBe(false);
    for (const target of await page.locator('.reader-bar .club-bar').getByRole('button').all()) {
      expect(overlap(box, await boxOf(target)), `over ${await target.getAttribute('aria-label')}`).toBe(false);
    }
    // Longer than the 3.5 s toasts had: it has something to do.
    await page.waitForTimeout(Math.max(0, arrived + 4500 - Date.now()));
    await expect(toast).toBeVisible();

    // Reached with the keyboard, which holds it there; its Show opens the note's conversation, here
    // in the reader.
    const show = toast.getByRole('button', { name: 'Show' });
    await show.focus();
    await expect(show).toBeFocused();
    await expectAccessible(page, 'the reader with a toast to act on');
    await expect(toast).toBeVisible();
    await page.keyboard.press('Enter');
    const sheet = page.getByTestId('marker-sheet');
    await expect(sheet.getByTestId('sheet-note-text')).toHaveText('Down, down, down: would the fall never come to an end?');
    await expect(sheet.getByTestId('reply')).toContainText('Me too, the marmalade jar!');
    await expect(toast).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/books/${book.id}/read`));

    // Another answer while the sheet is open: above it, never over it, and it answers a tap.
    await answer('Orange marmalade, and empty.');
    const again = page.getByTestId('toast').filter({ hasText: 'Orange marmalade' });
    await expect(again).toBeVisible({ timeout: 5000 });
    expect(overlap(await boxOf(again), await boxOf(page.getByRole('dialog'))), 'over the sheet').toBe(false);
    await press(touchOf(testInfo), again.getByRole('button', { name: 'Show' }));
    await expect(again).toHaveCount(0);
    await expect(sheet.getByTestId('reply')).toHaveCount(2);
    await ctx.close();
  });

  test('an answer that opens as you read on is told to those in its conversation, by name, and to nobody else', async ({ browser }, testInfo) => {
    const { club, book } = await clubWithAlice(['Ana', 'Cole', 'Dora']);
    const [ana, cole, dora] = [club.members.Ana!, club.members.Cole!, club.members.Dora!];
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const { section, end } = await chapters(club.owner, epub.publicationUrl!);
    const ch1 = section('I');
    // Cole writes in chapter I, where he is reading; Dora has read it too.
    await putProgress(cole, book.id, epub.id, at(ch1, 0), [{ from: at(ch1, 0), to: at(ch1, 900) }]);
    const note = await postComment(cole, book.id, { editionId: epub.id, locator: at(ch1, 200), text: 'Down, down, down: I love this bit' });
    await putProgress(dora, book.id, epub.id, at(ch1, 0), [{ from: at(ch1, 0), to: at(ch1, 900) }]);
    // Ana, who has read to the end of chapter IX, answers it: her words wait for each of them to
    // read as far (D69).
    await putProgress(ana, book.id, epub.id, end('IX'), [{ from: at(ch1, 0), to: end('IX') }]);
    const words = 'The Mock Turtle sobs about his schooling';
    const reply = await ana.api.post(`/api/comments/${note.id}/replies`, { data: { text: words } });
    expect(reply.status()).toBe(201);
    const answerId = ((await reply.json()) as { id: string }).id;

    /** In the reader, to chapter X, and "I've already read up to here": past where Ana wrote from. */
    const readPastIt = async (who: Person) => {
      const ctx = await browserAs(browser, who);
      const page = await ctx.newPage();
      const told = await recordToasts(page);
      await page.goto(`/books/${book.id}/read?edition=${epub.id}`);
      await ready(page);
      // The note's marker: the book's notes and their answers are in.
      await expect(page.getByTestId('bar-comment')).toHaveCount(1);
      await page.getByTestId('open-toc').click();
      await page.getByRole('button', { name: /CHAPTER X\./ }).click();
      await expect(page.getByTestId('reader')).toHaveAttribute('data-section', String(section('X')));
      await page.getByTestId('open-toc').click();
      await page.getByTestId('read-up-to-here').click();
      await answerQuestion(page, 'Mark everything up to this page as read?', 'Mark as read');
      await expect.poll(told, { timeout: 10_000 }).toContain('1 answer before here is now open to you.');
      return { ctx, page, told };
    };

    // Cole, whose note it is, is told, by whose note and where, with a way to it.
    const coles = await readPastIt(cole);
    const toast = coles.page.getByTestId('toast').filter({ hasText: 'answer to your note' });
    await expect(toast.locator('.toast-text')).toHaveText('Ana’s answer to your note in Chapter 1 is open now.', { timeout: 15_000 });
    await expectAccessible(coles.page, 'an answer open now, told');
    await press(touchOf(testInfo), toast.getByRole('button', { name: 'Show' }));
    const sheet = coles.page.getByTestId('marker-sheet');
    await expect(sheet.getByTestId('sheet-note-text')).toHaveText('Down, down, down: I love this bit');
    await expect(sheet.locator(`[data-comment="${answerId}"]`)).toContainText(words);

    // Dora reads as far: the answer is open to her too, but the conversation is not hers, and
    // nothing is said of it. (Under the toast of what she marked read, as Cole's did, it would be on
    // screen once that one had gone.)
    const doras = await readPastIt(dora);
    await expect(doras.page.getByTestId('toast').filter({ hasText: 'now open to you' })).toHaveCount(0, { timeout: 10_000 });
    await doras.page.waitForTimeout(1500);
    expect((await doras.told()).filter((t) => /’s answer/.test(t))).toEqual([]);
    expect((await coles.told()).filter((t) => /’s answer/.test(t))).toEqual(['Ana’s answer to your note in Chapter 1 is open now.']);
    const theirs = (await (await dora.api.get(`/api/books/${book.id}/comments`)).json()) as { id: string; hidden: boolean; text?: string }[];
    expect(theirs.find((c) => c.id === answerId)).toMatchObject({ hidden: false, text: words });
    await Promise.all([coles.ctx.close(), doras.ctx.close()]);
  });
});

test.describe('the club bar with friends at your place, and during a look (D90, D91)', () => {
  test('straight after an upload, with everyone at the new book’s start, your own marker is apart and answers a tap', async ({ browser }, testInfo) => {
    const club = await makeClub(['Ana', 'Ben', 'Cleo', 'Dee']);
    const book = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
    const touch = touchOf(testInfo);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    const check = async (where: string) => {
      const bar = page.getByTestId('club-bar');
      const own = bar.locator(`[data-testid="member-marker"][data-user="${club.owner.id}"]`);
      const friends = bar.getByTestId('member-group');
      await expect(own).toBeVisible({ timeout: 15_000 });
      await expect(own).toHaveAttribute('aria-label', /^You: /);
      // Four friends there: three dots and "+1", beside your marker, not over it.
      await expect(friends).toHaveText('+1');
      const label = (await friends.getAttribute('aria-label'))!;
      for (const name of ['Ana', 'Ben', 'Cleo', 'Dee']) expect(label).toContain(`${name}: `);
      expect(label).not.toContain('You');
      expect(overlap(await boxOf(own), await boxOf(friends)), `${where}: your marker and your friends’`).toBe(false);
      await expectUncovered(own, `${where}: your marker`);
      await expectUncovered(friends, `${where}: your friends’ marker`);
      // Each says its own.
      const tip = bar.getByTestId('bar-tip');
      await press(touch, own);
      await expect(tip).toHaveText(/^You · /);
      await press(touch, own);
      await expect(tip).toHaveCount(0);
      await press(touch, friends);
      for (const name of ['Ana', 'Ben', 'Cleo', 'Dee']) await expect(tip).toContainText(name);
      await expect(tip).not.toContainText('You');
      await press(touch, friends);
      await expect(tip).toHaveCount(0);
    };
    await page.goto(`/books/${book.id}`);
    await check('the book page');
    await expectAccessible(page, 'the book page, everyone at its start');
    await page.getByTestId('open-epub').click();
    await ready(page);
    await check('the reader');
    await ctx.close();
  });

  for (const kind of ['epub', 'pdf'] as const) {
    for (const [name, size] of [['a phone', PHONE], ['a computer', COMPUTER]] as const) {
      test(`during a look in the ${kind === 'epub' ? 'EPUB' : 'PDF'} reader on ${name}, the way back, “Read from here” and the club bar are all whole and tappable`, async ({ browser }) => {
        const { club, book } = await clubWithAlice(['Ana'], { pdf: kind === 'pdf' });
        const ana = club.members.Ana!;
        const epub = book.editions.find((e) => e.kind === 'epub')!;
        const { section } = await chapters(club.owner, epub.publicationUrl!);
        const [ch1, ch2, ch5] = [section('I'), section('II'), section('V')];
        // Olive reads chapter I; Ana is in chapter V, with a note in chapter II, and answers Olive's
        // note in chapter I while Olive looks elsewhere.
        await putProgress(club.owner, book.id, epub.id, at(ch1, 300), [{ from: at(ch1, 0), to: at(ch1, 300) }]);
        await putProgress(ana, book.id, epub.id, at(ch5, 100), [{ from: at(ch1, 0), to: at(ch5, 100) }]);
        await postComment(ana, book.id, { editionId: epub.id, locator: at(ch2, 200), text: 'Curiouser and curiouser!', reaction: '🤯' });
        const olives = await postComment(club.owner, book.id, { editionId: epub.id, locator: at(ch1, 100), text: 'The rabbit with a watch' });
        const ctx = await browserAs(browser, club.owner, size);
        const page = await ctx.newPage();
        await page.goto(`/books/${book.id}`);
        await expect(page.getByTestId('live-dot')).toHaveClass(/is-on/);
        await page.getByTestId(`open-${kind}`).click();
        if (kind === 'epub') await ready(page);
        else await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', '91', { timeout: 30_000 });
        await page.getByTestId('open-toc').click();
        await page.getByRole('button', { name: /CHAPTER IV\./ }).click();
        const back = page.getByTestId('back-to-reading');
        const stay = page.getByTestId('read-from-here');
        await expect(back).toContainText(kind === 'epub' ? 'Back to Chapter 1' : 'Back to page');
        const bar = page.locator('.reader-bar .club-bar');
        const targets = await bar.getByRole('button').all();
        // Olive, Ana, and the notes.
        expect(targets.length, "the bar's targets").toBeGreaterThanOrEqual(3);
        const text = await boxOf(page.locator('.reader-area'));
        for (const [what, l] of [['the way back', back], ['“Read from here”', stay]] as const) {
          const b = await boxOf(l);
          expect(overlap(b, await boxOf(bar)), `${what} is over the club bar`).toBe(false);
          expect(overlap(b, text), `${what} is over the page`).toBe(false);
          await expectUncovered(l, what);
          // Whole: on the screen, and its words inside it.
          expect(b.x, what).toBeGreaterThanOrEqual(0);
          expect(b.x + b.width, what).toBeLessThanOrEqual(size.viewport!.width);
          expect(await l.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${what} is cut`).toBe(true);
        }
        for (const t of targets) await expectUncovered(t, `${await t.getAttribute('aria-label')} on the bar`);
        // The header's buttons and the page arrows are all there to use.
        for (const id of ['open-toc', kind === 'epub' ? 'open-settings' : 'pdf-view', 'add-note', 'prev-page', 'next-page']) await expectUncovered(page.getByTestId(id), id);
        await expectUncovered(page.getByRole('link', { name: /^Back to Alice/ }), 'the way to the book page');
        await expectAccessible(page, `a look in the ${kind}, on ${name}`);

        // A friend's marker on the bar answers a tap during the look.
        const anaOnBar = bar.locator(`[data-testid="member-marker"][data-user="${ana.id}"]`);
        await press(size.hasTouch, anaOnBar);
        await expect(bar.getByTestId('bar-tip')).toContainText('Ana');
        await press(size.hasTouch, anaOnBar);
        await expect(bar.getByTestId('bar-tip')).toHaveCount(0);

        // A friend's answer meanwhile: its toast covers neither the bar nor the way back, nor "Read
        // from here" (on a phone it covered that, in its header, until fidelity review round 16).
        expect((await ana.api.post(`/api/comments/${olives.id}/replies`, { data: { text: 'A pocket watch!' } })).status()).toBe(201);
        const toast = page.getByTestId('toast').filter({ hasText: 'Ana replied' });
        await expect(toast).toBeVisible({ timeout: 5000 });
        // Held while it is measured, as it is while it has the focus (D89): measuring every target
        // on a loaded machine can take longer than a toast stays by itself.
        const dismiss = toast.getByRole('button', { name: 'Dismiss' });
        await dismiss.focus();
        await expect(dismiss).toBeFocused();
        const t = await boxOf(toast);
        expect(overlap(t, await boxOf(back)), 'the toast is over the way back').toBe(false);
        expect(overlap(t, await boxOf(stay)), 'the toast is over “Read from here”').toBe(false);
        // Over the page only on a phone, at its top, under the club bar.
        if (size.hasTouch) expect(t.y + t.height, 'the toast is over more than the top of the page').toBeLessThanOrEqual(text.y + 56);
        else expect(overlap(t, text), 'the toast is over the page').toBe(false);
        for (const target of targets) expect(overlap(t, await boxOf(target)), `the toast is over ${await target.getAttribute('aria-label')}`).toBe(false);
        await expectUncovered(back, 'the way back, with a toast');
        await expectUncovered(stay, '“Read from here”, with a toast');
        await press(size.hasTouch, dismiss);
        await expect(toast).toHaveCount(0);

        // And the way back takes her back.
        await press(size.hasTouch, back);
        await expect(page.getByTestId('look-chip')).toHaveCount(0);
        await ctx.close();
      });
    }
  }
});

test.describe('the next stop, in words (D92)', () => {
  test('at the next stop the card names whose note it offers, a toast leaves it whole, and the choices name each chapter’s title', async ({ browser }, testInfo) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const [ana, ben] = [club.members.Ana!, club.members.Ben!];
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const { section } = await chapters(club.owner, epub.publicationUrl!);
    const [ch1, ch2] = [section('I'), section('II')];
    // Ana left a note in chapter I as she read it, and is past its end now; Ben has read some way
    // into it, and has a note of his own there.
    await putProgress(ana, book.id, epub.id, at(ch1, 300), [{ from: at(ch1, 0), to: at(ch1, 300) }]);
    await postComment(ana, book.id, { editionId: epub.id, locator: at(ch1, 300), text: 'Down the rabbit-hole we go', reaction: '🤯' });
    await putProgress(ana, book.id, epub.id, at(ch2, 300), [{ from: at(ch1, 300), to: at(ch2, 300) }]);
    await putProgress(ben, book.id, epub.id, at(ch1, 0), [{ from: at(ch1, 0), to: at(ch1, 600) }]);
    const bens = await postComment(ben, book.id, { editionId: epub.id, locator: at(ch1, 100), text: 'Orange marmalade' });
    // The stop: the end of chapter I.
    const detail = (await (await club.owner.api.get(`/api/books/${book.id}`)).json()) as BookDetail;
    const end1 = detail.chapters.find((c) => c.title.startsWith('CHAPTER II.'))!.t;
    expect((await ana.api.put(`/api/books/${book.id}/meeting`, { data: { t: end1, on: null } })).status()).toBe(200);

    const ctx = await browserAs(browser, ben);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}`);
    await expect(page.getByTestId('live-dot')).toHaveClass(/is-on/);
    await page.getByTestId('open-epub').click();
    await ready(page);
    // To chapter I's last page, and reading on from there into chapter II.
    await page.getByTestId('open-toc').click();
    await page.getByRole('button', { name: /CHAPTER II\./ }).click();
    const reader = page.getByTestId('reader');
    await expect(reader).toHaveAttribute('data-section', String(ch2), { timeout: 15_000 });
    await page.getByTestId('prev-page').click();
    await expect(reader).toHaveAttribute('data-section', String(ch1));
    await page.getByTestId('read-from-here').click();
    await expect(page.getByTestId('look-chip')).toHaveCount(0);
    await page.getByTestId('next-page').click();
    const card = page.getByTestId('meeting-reached');
    await expect(card).toContainText('You’re at the next stop, with Ana.');
    // Whose note it offers, by name.
    const showNotes = card.getByTestId('meeting-show-notes');
    await expect(showNotes).toHaveText('Show Ana’s note');
    await expectInFooter(page, card);

    // A friend answers his note just then: the toast is never over the card (on a computer it was).
    expect((await ana.api.post(`/api/comments/${bens.id}/replies`, { data: { text: 'Empty, alas' } })).status()).toBe(201);
    const toast = page.getByTestId('toast').filter({ hasText: 'Ana replied' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    expect(overlap(await boxOf(toast), await boxOf(card)), 'the toast is over the next stop’s card').toBe(false);
    for (const b of await card.getByRole('button').all()) await expectUncovered(b, `the card’s ${await b.getAttribute('aria-label') ?? await b.textContent()}`);
    await expectAccessible(page, 'the next stop’s card, with a toast');
    await press(touchOf(testInfo), showNotes);
    await expect(page.getByTestId('marker-sheet').getByTestId('sheet-note-text')).toHaveText('Down the rabbit-hole we go');
    await page.keyboard.press('Escape');

    // The stop's choices: each chapter's end with its title; the stop is saved and said by its name.
    await page.goto(`/books/${book.id}`);
    await page.getByTestId('meeting-change').click();
    const dialog = page.getByRole('dialog', { name: 'The next stop' });
    const select = dialog.getByLabel('Read up to');
    await expect(select.locator('option')).toHaveText([
      'The end of Chapter 1 · Down the Rabbit-Hole',
      'The end of Chapter 2 · The Pool of Tears',
      'The end of Chapter 3 · A Caucus-Race and a Long Tale',
      'The end of Chapter 4 · The Rabbit Sends in a Little Bill',
      'The end of Chapter 5 · Advice from a Caterpillar',
      'The end of Chapter 6 · Pig and Pepper',
      'The end of Chapter 7 · A Mad Tea-Party',
      'The end of Chapter 8 · The Queen’s Croquet-Ground',
      'The end of Chapter 9 · The Mock Turtle’s Story',
      'The end of Chapter 10 · The Lobster Quadrille',
      'The end of Chapter 11 · Who Stole the Tarts?',
      'The end of the book',
    ]);
    await expect(select).toHaveValue(String(end1));
    await expectAccessible(page, 'the next stop’s choices, with their titles');
    await select.selectOption({ label: 'The end of Chapter 7 · A Mad Tea-Party' });
    await dialog.getByTestId('meeting-save').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('meeting-headline')).toHaveText('The end of Chapter 7');
    expect(((await (await club.owner.api.get(`/api/books/${book.id}`)).json()) as BookDetail).meeting?.label).toBe('the end of Chapter 7');
    await ctx.close();
  });
});
