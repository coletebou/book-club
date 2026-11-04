import { type Page, devices, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice } from '../helpers/api';

/**
 * Select one word on the visible page, on a line about half-way down: the leftmost, the middle or
 * the rightmost word of that line, as a reader's finger would.
 */
async function selectWord(page: Page, where: 'left' | 'middle' | 'right') {
  const frameEl = page.locator('iframe.epub-frame');
  const frameBox = (await frameEl.boundingBox())!;
  const view = (await page.locator('.epub-viewport').boundingBox())!;
  const frame = (await (await frameEl.elementHandle()).contentFrame())!;
  await frame.evaluate(
    ({ where, offsetX, viewLeft, viewRight, viewTop, viewBottom }) => {
      // Every word drawn inside the visible page, with its box in the app's coordinates.
      const words: { node: Text; start: number; end: number; x: number; y: number }[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text;
        for (const m of t.data.matchAll(/\p{L}{3,}/gu)) {
          const r = document.createRange();
          r.setStart(t, m.index);
          r.setEnd(t, m.index + m[0].length);
          const box = r.getClientRects()[0];
          if (!box) continue;
          const x = box.left + offsetX;
          if (x < viewLeft || x + box.width > viewRight || box.top < viewTop || box.bottom > viewBottom) continue;
          words.push({ node: t, start: m.index, end: m.index + m[0].length, x, y: Math.round(box.top) });
        }
      }
      // A line near the middle of the page, with at least three words on it.
      const lines = [...new Set(words.map((w) => w.y))].sort((a, b) => a - b);
      const mid = (viewTop + viewBottom) / 2;
      const line = lines.filter((y) => words.filter((w) => w.y === y).length >= 3).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0]!;
      const onLine = words.filter((w) => w.y === line).sort((a, b) => a.x - b.x);
      const pick = where === 'left' ? onLine[0]! : where === 'right' ? onLine[onLine.length - 1]! : onLine[Math.floor(onLine.length / 2)]!;
      const range = document.createRange();
      range.setStart(pick.node, pick.start);
      range.setEnd(pick.node, pick.end);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { where, offsetX: frameBox.x, viewLeft: view.x, viewRight: view.x + view.width, viewTop: view.y - frameBox.y, viewBottom: view.y + view.height - frameBox.y },
  );
}

/** The same in the PDF, whose words are in the page's text layer: a line about half-way down the screen. */
async function selectPdfWord(page: Page, where: 'left' | 'middle' | 'right') {
  const viewport = page.viewportSize()!;
  await page.evaluate(
    ({ where, width, height }) => {
      const words: { node: Text; start: number; end: number; x: number; y: number }[] = [];
      const layer = document.querySelector('.pdf-text')!;
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text;
        for (const m of t.data.matchAll(/\p{L}{3,}/gu)) {
          const r = document.createRange();
          r.setStart(t, m.index);
          r.setEnd(t, m.index + m[0].length);
          const box = r.getClientRects()[0];
          if (!box || box.left < 0 || box.right > width || box.top < 0 || box.bottom > height) continue;
          // Lines by their height on screen, to a few pixels: a line's pieces sit a little apart.
          words.push({ node: t, start: m.index, end: m.index + m[0].length, x: box.left, y: Math.round(box.top / 4) * 4 });
        }
      }
      const lines = [...new Set(words.map((w) => w.y))];
      const mid = height / 2;
      const line = lines.filter((y) => words.filter((w) => w.y === y).length >= 3).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0]!;
      const onLine = words.filter((w) => w.y === line).sort((a, b) => a.x - b.x);
      const pick = where === 'left' ? onLine[0]! : where === 'right' ? onLine[onLine.length - 1]! : onLine[Math.floor(onLine.length / 2)]!;
      const range = document.createRange();
      range.setStart(pick.node, pick.start);
      range.setEnd(pick.node, pick.end);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { where, width: viewport.width, height: viewport.height },
  );
}

/** A box on screen, in CSS pixels. */
interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** A word of a PDF line where it is printed: its text, where it starts in the line's text, and its ink's left and right. */
interface PrintedWord {
  readonly text: string;
  readonly start: number;
  readonly left: number;
  readonly right: number;
}

/** A line of the PDF page: its text in the text layer, where that is selectable, and where the canvas has it printed. */
interface PdfLine {
  readonly text: string;
  /** Its span's box. */
  readonly span: Box;
  /** Its characters' box: the span's text without the spaces around it. */
  readonly chars: Box;
  /** The inked columns of the canvas across the line's height (null when nothing is printed there). */
  readonly ink: { readonly left: number; readonly right: number } | null;
  /** Its words where they are printed, when the ink's widest gaps tell them apart beyond doubt (else none). */
  readonly words: readonly PrintedWord[];
}

/** Wait until the PDF page on screen is drawn, with its text layer laid out over it and fonts settled. */
async function pdfPageReady(page: Page): Promise<void> {
  await expect(page.locator('.pdf-text')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(page.locator('.pdf-text span').first()).toBeAttached();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/**
 * The PDF page on screen, measured: its canvas, its text layer and every line of it. Where a line
 * is printed comes from the canvas pixels alone, never from the text layer, so the two can be
 * compared.
 */
async function measurePdfPage(page: Page): Promise<{ canvas: Box; layer: Box; lines: PdfLine[] }> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.pdf-page canvas')!;
    const layer = document.querySelector<HTMLElement>('.pdf-text')!;
    const boxOf = (r: DOMRect): Box => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    const c = canvas.getBoundingClientRect();
    // Canvas pixels per CSS pixel: the device pixel ratio the page is drawn at.
    const k = canvas.width / c.width;
    const ctx = canvas.getContext('2d')!;
    const lines: PdfLine[] = [];
    for (const span of layer.querySelectorAll('span')) {
      const node = span.firstChild;
      if (!(node instanceof Text) || !node.data.trim()) continue;
      const s = span.getBoundingClientRect();
      const chars = document.createRange();
      chars.setStart(node, node.data.length - node.data.trimStart().length);
      chars.setEnd(node, node.data.trimEnd().length);
      // The runs of inked (dark) columns in the canvas rows the span covers.
      const runs: [number, number][] = [];
      const y0 = Math.max(0, Math.ceil((s.top - c.top) * k) + 1);
      const y1 = Math.min(canvas.height, Math.floor((s.bottom - c.top) * k) - 1);
      if (y1 > y0) {
        const px = ctx.getImageData(0, y0, canvas.width, y1 - y0).data;
        for (let x = 0; x < canvas.width; x++) {
          let inked = false;
          for (let y = 0; y < y1 - y0 && !inked; y++) {
            const i = (y * canvas.width + x) * 4;
            inked = px[i]! + px[i + 1]! + px[i + 2]! < 3 * 140;
          }
          const last = runs[runs.length - 1];
          if (inked && last?.[1] === x) last[1] = x + 1;
          else if (inked) runs.push([x, x + 1]);
        }
      }
      // Its printed words: the ink split at its widest gaps, one per space between words, when
      // those are clearly wider than any gap left inside a word (between its letters).
      const tokens = [...node.data.matchAll(/\S+/g)];
      const gaps = runs
        .slice(1)
        .map((run, i) => ({ after: i, width: run[0] - runs[i]![1] }))
        .sort((a, b) => b.width - a.width);
      const between = gaps.slice(0, tokens.length - 1);
      const narrowest = between[between.length - 1]?.width ?? Infinity;
      const clear = runs.length >= tokens.length && narrowest >= 1.4 * (gaps[tokens.length - 1]?.width ?? 0) && narrowest >= 0.12 * (s.bottom - s.top) * k;
      const words: PrintedWord[] = [];
      if (clear) {
        const cuts = new Set(between.map((g) => g.after));
        let from = runs[0]![0];
        runs.forEach((run, i) => {
          if (i < runs.length - 1 && !cuts.has(i)) return;
          const token = tokens[words.length]!;
          words.push({ text: token[0], start: token.index, left: c.left + from / k, right: c.left + run[1] / k });
          if (i < runs.length - 1) from = runs[i + 1]![0];
        });
      }
      const ink = runs.length > 0 ? { left: c.left + runs[0]![0] / k, right: c.left + runs[runs.length - 1]![1] / k } : null;
      lines.push({ text: node.data, span: boxOf(s), chars: boxOf(chars.getBoundingClientRect()), ink, words });
    }
    return { canvas: boxOf(c), layer: boxOf(layer.getBoundingClientRect()), lines };
  });
}

/**
 * Every line of the PDF page is selectable where it is printed: its characters start and end over
 * its ink (to a quarter of its height), and its box is no wider than its print, on the page and
 * clear of the line below. (pdf.js's text layer without its own rules set every line in 16 px type,
 * unstretched: twice as wide as printed on a phone, and over the next line.)
 */
async function expectTextOverPrint(page: Page, what: string): Promise<void> {
  const { canvas, layer, lines } = await measurePdfPage(page);
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    expect(Math.abs(layer[side] - canvas[side]), `${what}: the text layer covers the drawn page (${side})`).toBeLessThanOrEqual(1);
  }
  // A printed line set in more than one font (a word in italics) is one span of the layer for each
  // run: they are one line, and its characters together start and end over its ink.
  const printed: PdfLine[] = [];
  for (const l of lines.filter((x) => x.ink !== null)) {
    const same = printed.find((p) => Math.abs(yOf(p) - yOf(l)) < (p.span.bottom - p.span.top) / 2);
    if (!same) {
      printed.push(l);
      continue;
    }
    const union = (a: Box, b: Box): Box => ({ left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) });
    printed[printed.indexOf(same)] = {
      ...same,
      text: `${same.text}${l.text}`,
      span: union(same.span, l.span),
      chars: union(same.chars, l.chars),
      ink: { left: Math.min(same.ink!.left, l.ink!.left), right: Math.max(same.ink!.right, l.ink!.right) },
      words: [...same.words, ...l.words],
    };
  }
  printed.sort((a, b) => a.span.top - b.span.top);
  // The page's lines, not one or two of them.
  expect(printed.length, `${what}: printed lines`).toBeGreaterThanOrEqual(20);
  for (const [i, l] of printed.entries()) {
    const ink = l.ink!;
    const at = `${what}: “${l.text}”`;
    const tolerance = Math.max(2, (l.span.bottom - l.span.top) / 4);
    expect(Math.abs(l.chars.left - ink.left), `${at} starts where it is printed`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(l.chars.right - ink.right), `${at} ends where it is printed`).toBeLessThanOrEqual(tolerance);
    expect(l.span.right - l.span.left, `${at} is no wider than printed`).toBeLessThanOrEqual(ink.right - ink.left + 2 * tolerance);
    expect(l.span.left, `${at} is on the page`).toBeGreaterThanOrEqual(canvas.left - 1);
    expect(l.span.right, `${at} is on the page`).toBeLessThanOrEqual(canvas.right + 1);
    expect(l.span.top, `${at} is on the page`).toBeGreaterThanOrEqual(canvas.top - 1);
    expect(l.span.bottom, `${at} is on the page`).toBeLessThanOrEqual(canvas.bottom + 1);
    const next = printed[i + 1];
    if (next && next.span.top > (l.span.top + l.span.bottom) / 2) {
      expect(next.span.top, `${at} stays clear of the line below`).toBeGreaterThanOrEqual(l.span.bottom - 0.5);
    }
  }
}

/** The letters of a printed word, its punctuation aside, if there are four or more of them and nothing between them. */
function letters(word: PrintedWord): { start: number; end: number } | null {
  const m = /^(\P{L}*)(\p{L}{4,})\P{L}*$/u.exec(word.text);
  return m ? { start: word.start + m[1]!.length, end: word.start + m[1]!.length + m[2]!.length } : null;
}

/** The middle of a printed word, across; of a line, down. */
const xOf = (w: PrintedWord) => (w.left + w.right) / 2;
const yOf = (l: PdfLine) => (l.span.top + l.span.bottom) / 2;

/** The PDF page measured, with its lines in the middle of the screen whose printed words were told apart, the most central first. */
async function middleLines(page: Page): Promise<{ canvas: Box; layer: Box; middle: PdfLine[] }> {
  const screen = page.viewportSize()!;
  const { canvas, layer, lines } = await measurePdfPage(page);
  const off = (l: PdfLine) => Math.abs(yOf(l) - screen.height / 2);
  const middle = lines.filter((l) => l.words.length >= 4 && l.span.top > screen.height * 0.25 && l.span.bottom < screen.height * 0.75).sort((a, b) => off(a) - off(b));
  return { canvas, layer, middle };
}

/**
 * A drag with the mouse, at whole pixels as a mouse reports them (in Chromium a synthetic press
 * at some fractions of a pixel starts no selection at all).
 */
async function dragMouse(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const [x0, y0, x1, y1] = [from.x, from.y, to.x, to.y].map(Math.round) as [number, number, number, number];
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(Math.round((x0 + x1) / 2), y0, { steps: 5 });
  await page.mouse.move(x1, y1, { steps: 5 });
  await page.mouse.up();
}

const selectedText = (page: Page) => page.evaluate(() => document.getSelection()?.toString() ?? '');

/**
 * Every piece of a line's text that starts within one stretch of it (after its first character)
 * and ends within another (before its end): what a drag between the middles of two words selects.
 */
function piecesOf(text: string, starts: { start: number; end: number }, ends: { start: number; end: number }): string[] {
  const pieces: string[] = [];
  for (let start = starts.start + 1; start < starts.end; start++) {
    for (let end = ends.start + 1; end < ends.end; end++) pieces.push(text.slice(start, end));
  }
  return pieces;
}

test.describe('reacting to a passage', () => {
  test('the reaction menu is whole on screen wherever the passage is on the line', async ({ browser }) => {
    const { club, book } = await clubWithAlice([]);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${epub.id}&at=0.3`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    const viewport = page.viewportSize()!;
    for (const where of ['left', 'middle', 'right'] as const) {
      await selectWord(page, where);
      const menu = page.getByTestId('selection-menu');
      await expect(menu).toBeVisible();
      // Every button of it, not just the menu's middle, is inside the screen.
      for (const button of await menu.getByRole('button').all()) {
        const box = (await button.boundingBox())!;
        expect(box.x, `${where}: ${await button.getAttribute('aria-label') ?? 'Note'}`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${where}: ${await button.getAttribute('aria-label') ?? 'Note'}`).toBeLessThanOrEqual(viewport.width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      }
      await expect(menu.getByTestId('note-from-selection')).toBeInViewport();
    }
    await ctx.close();
  });

  test('in the PDF on a small phone too, and a reaction from it is pinned to the passage', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    // As narrow as phones come (an iPhone SE or mini), in both projects.
    const ctx = await browserAs(browser, club.owner, { viewport: { width: 375, height: 667 }, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}&at=0.3`);
    await expect(page.locator('.pdf-text span').first()).toBeAttached({ timeout: 30_000 });
    const before = await page.getByTestId('margin-marker').count();
    for (const where of ['left', 'middle', 'right'] as const) {
      await selectPdfWord(page, where);
      const menu = page.getByTestId('selection-menu');
      await expect(menu).toBeVisible();
      for (const button of await menu.getByRole('button').all()) {
        const box = (await button.boundingBox())!;
        const name = (await button.getAttribute('aria-label')) ?? 'Note';
        expect(box.x, `${where}: ${name}`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${where}: ${name}`).toBeLessThanOrEqual(375);
        expect(box.y, `${where}: ${name}`).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height, `${where}: ${name}`).toBeLessThanOrEqual(667);
      }
      await expect(menu.getByTestId('note-from-selection')).toBeInViewport();
    }
    // The last of them, on the right: pinned to the passage, on this page.
    const menu = page.getByTestId('selection-menu');
    const reaction = menu.locator('.reaction-btn').last();
    const emoji = (await reaction.textContent())!.trim();
    await reaction.click();
    await expect(page.getByText(`${emoji} pinned here.`)).toBeVisible();
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('margin-marker')).toHaveCount(before + 1);
    await expect(page.getByTestId('margin-marker').last()).toHaveText(emoji);
    await ctx.close();
  });
});

test.describe('the PDF selects what is printed', () => {
  test('every line of a PDF page is selectable where it is printed, fitted and zoomed in, on a phone and a computer', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const { viewport, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 15'];
    const screens = {
      'an iPhone': { viewport, deviceScaleFactor, isMobile, hasTouch },
      'a computer': { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    };
    for (const [name, screen] of Object.entries(screens)) {
      const ctx = await browserAs(browser, club.owner, screen);
      const page = await ctx.newPage();
      await page.goto(`/books/${book.id}/read?edition=${pdf.id}&at=0.3`);
      await pdfPageReady(page);
      await expectTextOverPrint(page, `${name}, fitted`);
      // Zoomed in, the page and its text are laid out again, larger.
      const width = () => page.locator('.pdf-page canvas').evaluate((c) => c.getBoundingClientRect().width);
      const fitted = await width();
      await page.getByTestId('pdf-view').click();
      await page.getByTestId('zoom-in').click();
      await expect.poll(width).toBeGreaterThan(fitted * 1.4);
      await pdfPageReady(page);
      await expectTextOverPrint(page, `${name}, zoomed in`);
      await ctx.close();
    }
  });

  test('the words under the pointer are the ones a reaction quotes: dragged across to a line’s end, or a word double-clicked', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}&at=0.3`);
    await pdfPageReady(page);
    const screen = page.viewportSize()!;
    const pageIndex = Number(await page.getByTestId('reader').getAttribute('data-page-index'));
    const menu = page.getByTestId('selection-menu');
    /** React to the selection through its menu, and return the note the server keeps for it. */
    const react = async (n: number) => {
      const button = menu.locator('.reaction-btn').nth(n);
      const emoji = (await button.textContent())!.trim();
      await button.click();
      await expect(page.getByText(`${emoji} pinned here.`)).toBeVisible();
      await expect(menu).toHaveCount(0);
      const comments = (await (await page.request.get(`/api/books/${book.id}/comments`)).json()) as { reaction: string | null; quote: string | null; locator: { kind: string; page?: number; y?: number } }[];
      const note = comments.find((c) => c.reaction === emoji);
      expect(note, `the ${emoji} note`).toBeDefined();
      return note!;
    };

    // Dragged with the pointer from the middle of a word near a line's end to the middle of its
    // last word: the selection starts inside the first and ends inside the last, as printed.
    let { layer, middle } = await middleLines(page);
    const drag = middle
      .map((line) => {
        const to = line.words[line.words.length - 1]!;
        const from = line.words.slice(-4, -2).find((w) => letters(w) !== null);
        return letters(to) && from ? { line, from, to } : null;
      })
      .find((d) => d !== null);
    expect(drag, 'a line in the middle of the screen ends in words to drag across').toBeDefined();
    const { line, from, to } = drag!;
    await dragMouse(page, { x: xOf(from), y: yOf(line) }, { x: xOf(to), y: yOf(line) });
    await expect(menu).toBeVisible();
    const dragged = await selectedText(page);
    expect(piecesOf(line.text, letters(from)!, letters(to)!), `dragged across “${line.text.slice(from.start, to.start + to.text.length)}”`).toContain(dragged);
    const draggedNote = await react(0);
    expect(draggedNote.quote).toBe(dragged.replace(/\s+/g, ' ').trim());
    // Pinned on this page at the line's height.
    expect(draggedNote.locator).toMatchObject({ kind: 'pdf', page: pageIndex });
    expect(Math.abs(draggedNote.locator.y! - (line.span.top - layer.top) / (layer.bottom - layer.top))).toBeLessThan(0.01);

    // A word double-clicked is selected whole and quoted. In the middle of the screen: on a phone
    // a tap at either side turns the page.
    ({ layer, middle } = await middleLines(page));
    const word = middle
      .flatMap((l) => l.words.map((w) => ({ l, w })))
      .find(({ w }) => /^\p{L}{4,}$/u.test(w.text) && xOf(w) > screen.width * 0.35 && xOf(w) < screen.width * 0.65);
    expect(word, 'a word of four letters or more in the middle of the screen').toBeDefined();
    await page.mouse.dblclick(Math.round(xOf(word!.w)), Math.round(yOf(word!.l)));
    await expect(menu).toBeVisible();
    expect((await selectedText(page)).trim()).toBe(word!.w.text);
    const wordNote = await react(1);
    expect(wordNote.quote).toBe(word!.w.text);
    expect(wordNote.locator).toMatchObject({ kind: 'pdf', page: pageIndex });
    expect(Math.abs(wordNote.locator.y! - (word!.l.span.top - layer.top) / (layer.bottom - layer.top))).toBeLessThan(0.01);
    await ctx.close();
  });

  test('a drag that runs on past the end of a line selects to that line’s end, not the page above or below it', async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { pdf: true });
    const pdf = book.editions.find((e) => e.kind === 'pdf')!;
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read?edition=${pdf.id}&at=0.3`);
    await pdfPageReady(page);
    // From the middle of a word near a line's end to the blank margin past it, where nothing is
    // printed (pdf.js's empty block under the text is there).
    const { canvas, middle } = await middleLines(page);
    const run = middle
      .map((line) => ({ line, from: line.words.slice(-4, -2).find((w) => letters(w) !== null) }))
      .find(({ line, from }) => from && letters(line.words[line.words.length - 1]!) && line.ink && line.ink.right + 16 < canvas.right);
    expect(run, 'a line in the middle of the screen with a margin past its end').toBeDefined();
    const { line, from } = run!;
    const last = line.words[line.words.length - 1]!;
    await dragMouse(page, { x: xOf(from!), y: yOf(line) }, { x: line.ink!.right + 12, y: yOf(line) });
    await expect(page.getByTestId('selection-menu')).toBeVisible();
    // It starts inside that word and stops in the line's last word, or at its very end: the
    // selection jumped to the top of the page in WebKit and to lines below in Chromium.
    const toEnd = { start: last.start, end: line.text.trimEnd().length + 1 };
    expect(piecesOf(line.text, letters(from!)!, toEnd), `dragged from “${from!.text}” past the end of “${line.text}”`).toContain(await selectedText(page));
    await ctx.close();
  });
});
