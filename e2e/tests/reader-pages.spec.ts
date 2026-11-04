import { type Page, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice, placeSaved, postComment, serverPlace } from '../helpers/api';

interface PageState {
  page: number;
  total: number;
  chapterPage: number;
  chapterTotal: number;
  percent: number;
  section: number;
  start: number;
  end: number;
}

async function pageState(page: Page): Promise<PageState> {
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  const num = page.getByTestId('page-number');
  const ch = page.getByTestId('chapter-page');
  const reader = page.getByTestId('reader');
  const n = async (loc: ReturnType<Page['getByTestId']>, attr: string) => Number(await loc.getAttribute(attr));
  return {
    page: await n(num, 'data-page'),
    total: await n(num, 'data-total'),
    chapterPage: await n(ch, 'data-page'),
    chapterTotal: await n(ch, 'data-total'),
    percent: await n(page.getByTestId('percent'), 'data-value'),
    section: await n(reader, 'data-section'),
    start: await n(reader, 'data-start'),
    end: await n(reader, 'data-end'),
  };
}

/** Text of the section between two offsets, read from the rendered book frame. */
async function textAt(page: Page, start: number, length: number): Promise<string> {
  const frame = (await (await page.locator('iframe.epub-frame').elementHandle()).contentFrame())!;
  return frame.evaluate(
    ([s, len]) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let text = '';
      for (let n = walker.nextNode(); n; n = walker.nextNode()) text += (n as Text).data;
      return text.slice(s, s + len);
    },
    [start, length] as const,
  );
}

/** Is the character at `offset` drawn inside the visible page? (independent of the app's state) */
async function onScreen(page: Page, offset: number): Promise<boolean> {
  const frame = (await (await page.locator('iframe.epub-frame').elementHandle()).contentFrame())!;
  const rect = await frame.evaluate((o) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let at = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      if (at + t.data.length > o) {
        for (let i = Math.max(0, o - at); i < t.data.length; i++) {
          const r = document.createRange();
          r.setStart(t, i);
          r.setEnd(t, i + 1);
          const box = r.getClientRects()[0];
          if (box && box.width > 0) return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        }
      }
      at += t.data.length;
    }
    return null;
  }, offset);
  if (!rect) return false;
  const iframe = await page.locator('iframe.epub-frame').boundingBox();
  const viewport = await page.locator('.epub-viewport').boundingBox();
  if (!iframe || !viewport) return false;
  const x = iframe.x + rect.x;
  const y = iframe.y + rect.y;
  return x >= viewport.x && x <= viewport.x + viewport.width && y >= viewport.y && y <= viewport.y + viewport.height;
}

async function openReader(page: Page, bookId: string) {
  await page.goto(`/books/${bookId}`);
  await page.getByTestId('open-epub').click();
  await expect(page).toHaveURL(/\/read/);
  return pageState(page);
}

/** Jump to a chapter from the contents, and wait until the reader is showing its first page. */
async function goToChapter(page: Page, title: RegExp) {
  const reader = page.getByTestId('reader');
  const before = await reader.getAttribute('data-section');
  await page.getByTestId('open-toc').click();
  await page.getByRole('button', { name: title }).click();
  await expect(reader).not.toHaveAttribute('data-section', before ?? '');
  await expect(page.getByTestId('chapter-page')).toHaveAttribute('data-page', '1');
}

test.describe('EPUB book-wide page numbers', () => {
  test('shows page X of Y, the page within the chapter and the percentage', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    const first = await openReader(page, book.id);
    expect(first.page).toBe(1);
    expect(first.total).toBeGreaterThan(40);
    await goToChapter(page, /CHAPTER III\./);
    const ch3 = await pageState(page);
    expect(ch3.chapterPage).toBe(1);
    expect(ch3.chapterTotal).toBeGreaterThan(1);
    expect(ch3.page).toBeGreaterThan(first.page);
    expect(ch3.percent).toBeGreaterThan(0.1);
    await expect(page.getByTestId('page-number')).toHaveText(`Page ${ch3.page} of ${ch3.total}`);
    await page.getByTestId('next-page').click();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', String(ch3.page + 1));
    const next = await pageState(page);
    expect(next.chapterPage).toBe(2);
    expect(next.chapterTotal).toBe(ch3.chapterTotal);
    expect(next.total).toBe(ch3.total);
    expect(next.percent).toBeGreaterThan(ch3.percent);
    await expect(page.getByTestId('chapter-page')).toContainText(/2 of \d+ in chapter|Last page in chapter/);
    await ctx.close();
  });

  test('numbers do not restart at chapter boundaries (v1 fallback bug)', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openReader(page, book.id);
    await goToChapter(page, /CHAPTER II\./);
    const ch2 = await pageState(page);
    await goToChapter(page, /CHAPTER III\./);
    const ch3 = await pageState(page);
    expect(ch3.page).toBe(ch2.page + ch2.chapterTotal);
    expect(ch3.page).toBeGreaterThan(ch2.chapterTotal);
    await ctx.close();
  });

  test('the same page has the same numbers after a reload', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openReader(page, book.id);
    await goToChapter(page, /CHAPTER V\./);
    for (let i = 0; i < 3; i++) await page.getByTestId('next-page').click();
    const before = await pageState(page);
    const passage = await textAt(page, before.start, 60);
    await placeSaved(page, book.id);
    await page.reload();
    const after = await pageState(page);
    expect(after).toEqual(before);
    expect(await textAt(page, after.start, 60)).toBe(passage);
    await ctx.close();
  });

  test('a font-size change recomputes the totals once, never doubling, and keeps the passage on screen', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openReader(page, book.id);
    await goToChapter(page, /CHAPTER VII\./);
    for (let i = 0; i < 2; i++) await page.getByTestId('next-page').click();
    const base = await pageState(page);
    const passage = await textAt(page, base.start, 50);
    expect(await onScreen(page, base.start)).toBe(true);

    await page.getByTestId('open-settings').click();
    await page.getByTestId('font-larger').click();
    await page.getByTestId('font-larger').click();
    await expect(page.getByTestId('font-scale')).toHaveText('120%');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('page-number')).not.toHaveAttribute('data-total', String(base.total), { timeout: 30_000 });
    const larger = await pageState(page);
    // More pages with bigger text, but a recount, not an append to the old count.
    expect(larger.total).toBeGreaterThan(base.total);
    expect(larger.total).toBeLessThan(base.total * 1.8);
    // The passage that was at the top of the page is still on screen.
    expect(larger.start).toBeLessThanOrEqual(base.start);
    expect(larger.end).toBeGreaterThan(base.start);
    expect(await onScreen(page, base.start)).toBe(true);
    expect(await textAt(page, base.start, 50)).toBe(passage);

    // Back to the original size: exactly the original totals (no accumulation).
    await page.getByTestId('open-settings').click();
    await page.getByTestId('font-smaller').click();
    await page.getByTestId('font-smaller').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', String(base.total), { timeout: 30_000 });
    expect(await onScreen(page, base.start)).toBe(true);

    // And up again: the larger total, not a doubled one.
    await page.getByTestId('open-settings').click();
    await page.getByTestId('font-larger').click();
    await page.getByTestId('font-larger').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-total', String(larger.total), { timeout: 30_000 });
    await ctx.close();
  });

  test('a reload at the larger font size shows the recomputed numbers', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openReader(page, book.id);
    await page.getByTestId('open-settings').click();
    await page.getByTestId('font-larger').click();
    await page.keyboard.press('Escape');
    await goToChapter(page, /CHAPTER IV\./);
    // Read on there, which makes it the place (a chapter from the contents is a look until then;
    // past where you have read, until three pages are read there: D72).
    for (let i = 0; i < 3; i++) await page.getByTestId('next-page').click();
    await expect(page.getByTestId('chapter-page')).toHaveAttribute('data-page', '4');
    const before = await pageState(page);
    await placeSaved(page, book.id);
    await page.reload();
    const after = await pageState(page);
    expect(after.total).toBe(before.total);
    expect(after.page).toBe(before.page);
    expect(after.chapterPage).toBe(before.chapterPage);
    await ctx.close();
  });

  test('reopened at a larger font, going back down returns to the very page it was on', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openReader(page, book.id);
    await goToChapter(page, /CHAPTER II\./);
    for (let i = 0; i < 3; i++) await page.getByTestId('next-page').click();
    await placeSaved(page, book.id);
    const small = await pageState(page);
    const fontStep = async (testId: 'font-larger' | 'font-smaller') => {
      await page.getByTestId('open-settings').click();
      await page.getByTestId(testId).click();
      await page.getByTestId(testId).click();
      await page.keyboard.press('Escape');
    };
    // Two sizes up, and the book opened again there.
    await fontStep('font-larger');
    await expect.poll(async () => (await pageState(page)).total, { timeout: 30_000 }).not.toBe(small.total);
    await page.reload();
    const large = await pageState(page);
    expect(large.total).not.toBe(small.total);
    // Two sizes down: the same page as before, to the character.
    await fontStep('font-smaller');
    await expect.poll(async () => (await pageState(page)).total, { timeout: 30_000 }).toBe(small.total);
    const back = await pageState(page);
    expect([back.page, back.section, back.start]).toEqual([small.page, small.section, small.start]);
    await ctx.close();
  });

  test('chapter navigation lands on the chapter even when TOC and spine paths differ', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openReader(page, book.id);
    for (const [title, words] of [
      [/CHAPTER IX\./, 'The Mock Turtle’s Story'],
      [/CHAPTER XII\./, 'Alice’s Evidence'],
      [/CHAPTER I\. /, 'Down the Rabbit-Hole'],
    ] as const) {
      await goToChapter(page, title);
      await expect(page.frameLocator('iframe.epub-frame').getByRole('heading', { name: new RegExp(words) })).toBeVisible();
      expect((await pageState(page)).chapterPage).toBe(1);
    }
    await ctx.close();
  });

  test('keyboard and tap zones turn pages', async ({ browser }, testInfo) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    const start = await openReader(page, book.id);
    if (testInfo.project.name.includes('iphone')) {
      const box = (await page.locator('.epub-viewport').boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
    } else {
      await page.keyboard.press('ArrowRight');
    }
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', String(start.page + 1));
    await page.getByTestId('prev-page').click();
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-page', String(start.page));
    await ctx.close();
  });

  test('themes change colours without changing pages', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await openReader(page, book.id);
    await goToChapter(page, /CHAPTER II\./);
    const before = await pageState(page);
    await page.getByTestId('open-settings').click();
    await page.locator('label.swatch', { hasText: 'Sepia' }).click();
    await expect(page.getByRole('radio', { name: 'Sepia' })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('reader')).toHaveClass(/theme-sepia/);
    const after = await pageState(page);
    expect(after.page).toBe(before.page);
    expect(after.total).toBe(before.total);
    await ctx.close();
  });
});

test.describe('one place, whatever the screen', () => {
  test('sideways and back: the page fits the screen again, the same numbers return, and your place stays put', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const ctx = await browserAs(browser, club.owner, { viewport: { width: 393, height: 659 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await openReader(page, book.id);
    await goToChapter(page, /CHAPTER III\./);
    for (let i = 0; i < 3; i++) await page.getByTestId('next-page').click();
    await placeSaved(page, book.id);
    const upright = await pageState(page);
    const place = await serverPlace(page, book.id);
    // Sideways: another layout, other numbers.
    await page.setViewportSize({ width: 734, height: 343 });
    await expect.poll(async () => Number(await page.getByTestId('page-number').getAttribute('data-total')), { timeout: 30_000 }).not.toBe(upright.total);
    // Upright again: the reader is as wide as the screen, its buttons are on it, and the numbers come back.
    await page.setViewportSize({ width: 393, height: 659 });
    await expect.poll(async () => (await page.locator('.epub-viewport').boundingBox())!.width, { timeout: 30_000 }).toBeLessThanOrEqual(393);
    await expect(page.getByTestId('next-page')).toBeInViewport();
    await expect(page.getByTestId('open-toc')).toBeInViewport();
    await expect.poll(async () => (await pageState(page)).total, { timeout: 30_000 }).toBe(upright.total);
    expect((await pageState(page)).page).toBe(upright.page);
    // Laying the page out twice did not move your place back.
    await page.waitForTimeout(1500);
    expect(await serverPlace(page, book.id)).toEqual(place);
    await ctx.close();
  });

  test('opening the book on a bigger screen, without reading, leaves your place where the phone had it', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ben']);
    const phoneCtx = await browserAs(browser, club.owner, { viewport: { width: 393, height: 659 }, hasTouch: true, isMobile: true });
    const phone = await phoneCtx.newPage();
    await openReader(phone, book.id);
    await goToChapter(phone, /CHAPTER III\./);
    for (let i = 0; i < 3; i++) await phone.getByTestId('next-page').click();
    await placeSaved(phone, book.id);
    const onPhone = await pageState(phone);
    const place = await serverPlace(phone, book.id);
    expect(place).toMatchObject({ kind: 'epub', section: onPhone.section, offset: onPhone.start });
    // Ben's note just past the phone's page: not read yet.
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    await postComment(club.members.Ben!, book.id, { editionId: epub.id, locator: { kind: 'epub', section: onPhone.section, offset: onPhone.end + 30 }, text: 'Just past the phone’s page' });

    // The laptop's bigger page starts earlier in the chapter, and holds the phone's place.
    const laptopCtx = await browserAs(browser, club.owner, { viewport: { width: 1280, height: 800 } });
    const laptop = await laptopCtx.newPage();
    const saved = laptop.waitForResponse((r) => r.url().endsWith(`/api/books/${book.id}/progress`) && r.request().method() === 'PUT', { timeout: 30_000 });
    const onLaptop = await openReader(laptop, book.id);
    expect(onLaptop.section).toBe(onPhone.section);
    expect(onLaptop.start).toBeLessThan(onPhone.start);
    expect(onLaptop.end).toBeGreaterThan(onPhone.end + 30);
    // Its first report is in: it counted the page it showed (Ben's note on it opens at once, as a
    // note on the page in front of you does), and did not move the place back.
    expect((await saved).ok()).toBe(true);
    await expect(laptop.getByTestId('margin-marker')).toHaveAttribute('data-hidden', 'false', { timeout: 10_000 });
    expect(await serverPlace(laptop, book.id)).toEqual(place);

    // Back on the phone, the same page.
    await phone.reload();
    await expect.poll(async () => (await pageState(phone)).start, { timeout: 30_000 }).toBe(onPhone.start);
    expect((await pageState(phone)).page).toBe(onPhone.page);
    await Promise.all([phoneCtx.close(), laptopCtx.close()]);
  });
});
