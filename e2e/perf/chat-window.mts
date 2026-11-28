import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type APIRequestContext, type Locator, type Page, chromium, devices, expect, request, webkit } from '@playwright/test';
import { seedDemoIfEmpty } from '../../apps/server/src/cli/seed';
import { closeApp, makeTestApp } from '../../apps/server/test/helpers';

// Run from the root with apps/server/node_modules/.bin/tsx e2e/perf/chat-window.mts <production-dist> [chromium|webkit] [--measure-only|--row-budget].
const [dist, engine = 'chromium', mode] = process.argv.slice(2);
if (!dist || (engine !== 'chromium' && engine !== 'webkit') || (mode && mode !== '--measure-only' && mode !== '--row-budget')) {
  throw new Error('Expected a build directory, optional browser name and optional measurement mode');
}

const total = 500;
const messageId = (index: number) => `fixture-chat-${index}`;
const message = (list: Locator, index: number) => list.locator(`[data-message-id="${messageId(index)}"]`);
const measurementsOnly = mode === '--measure-only';
const rowBudgetOnly = mode === '--row-budget';

async function signIn(baseURL: string, name: 'ana' | 'ben') {
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  const response = await api.post('/api/auth/signin', { data: { email: `${name}@demo.bookclub`, password: 'wonderland-demo' } });
  assert(response.ok(), await response.text());
  return api;
}

function cpuPressure() {
  try {
    return Number(/^some .*total=(\d+)/m.exec(readFileSync('/proc/pressure/cpu', 'utf8'))?.[1]);
  } catch {
    return NaN;
  }
}

async function scrollTo(list: Locator, fraction: number) {
  await list.evaluate(async (element, position) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * position;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  }, fraction);
}

async function expectChatItemInView(item: Locator) {
  await expect(item).toBeVisible();
  // WebKit can report zero intersection for a distant positioned row after
  // the scroller has reached it. Compare the rendered bounds to the scrollport.
  await expect.poll(() => item.evaluate((row) => {
    const rect = row.getBoundingClientRect();
    const list = row.closest('.chat-messages')?.getBoundingClientRect();
    return !!list && rect.height > 0 && rect.top < Math.min(list.bottom, window.innerHeight) && rect.bottom > Math.max(list.top, 0);
  })).toBe(true);
}

async function loadHistory(list: Locator) {
  const earlier = list.getByTestId('chat-load-earlier');
  const loaded = () => list.evaluate((element) => Number(element.dataset.loaded ?? element.querySelectorAll('[data-message-id]').length));
  const anchorDeltas: number[] = [];
  while (await earlier.count()) {
    await scrollTo(list, 0);
    const before = await loaded();
    const anchor = await list.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.top >= top && rect.top < top + element.clientHeight;
      });
      return row ? { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top } : null;
    });
    assert(anchor, 'loading earlier messages must start with a visible row');
    await earlier.click();
    await expect.poll(loaded).toBeGreaterThan(before);
    const delta = await list.evaluate(async (element, previous) => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const row = element.querySelector(`[data-message-id="${previous.id}"]`);
      return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top - previous.offset : null;
    }, anchor);
    assert(delta !== null, `lost anchor ${anchor.id} after prepending`);
    anchorDeltas.push(delta);
  }
  assert.equal(await loaded(), total);
  return anchorDeltas;
}

async function measureScroll(list: Locator, steps: 'regular' | 'jumps', takeTaskSeconds: () => Promise<number | undefined>) {
  const previousTaskSeconds = await takeTaskSeconds();
  const pressure = cpuPressure();
  const start = performance.now();
  const result = await list.evaluate(async (element, type) => {
    let peakMounted = element.querySelectorAll('[data-message-id]').length;
    let previous = await new Promise(requestAnimationFrame);
    const frames = [];
    for (let i = 0; i < 50; i++) {
      element.scrollTop = type === 'regular' ? i * 65 : (element.scrollHeight - element.clientHeight) * i / 49;
      const frame = await new Promise(requestAnimationFrame);
      frames.push(frame - previous);
      previous = frame;
      peakMounted = Math.max(peakMounted, element.querySelectorAll('[data-message-id]').length);
    }
    return { peakMounted, p95FrameMs: frames.sort((a, b) => a - b)[47]! };
  }, steps);
  const pressurePercent = (cpuPressure() - pressure) / ((performance.now() - start) * 10);
  const taskSeconds = await takeTaskSeconds();
  return {
    ...result,
    pressurePercent,
    rendererMs: previousTaskSeconds !== undefined && taskSeconds !== undefined ? Math.round((taskSeconds - previousTaskSeconds) * 1000) : null,
  };
}

async function checkRowBudget(list: Locator) {
  let peakMounted = 0;
  for (const scroll of [0, 0.5, 1]) {
    await scrollTo(list, scroll);
    if (scroll === 0) await expectChatItemInView(message(list, 0));
    if (scroll === 1) await expectChatItemInView(message(list, total - 1));
    peakMounted = Math.max(peakMounted, await list.getByTestId('chat-message').count());
  }
  assert(peakMounted <= 40, 'mounted message count must stay bounded');
  return peakMounted;
}

async function checkShowAll(page: Page, list: Locator) {
  const toggle = page.getByRole('button', { name: 'Show all loaded messages', exact: true });
  await scrollTo(list, 0);
  const match = message(list, 273);
  await expect(match).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(list.getByTestId('chat-message')).toHaveCount(total);
  await expectChatItemInView(message(list, 0));
  const found = await page.evaluate(() => {
    const find = (window as Window & { find?: (text: string, caseSensitive: boolean, backwards: boolean, wrap: boolean) => boolean }).find;
    return find ? find.call(window, 'Chat window fixture 273', true, false, true) : null;
  });
  if (found !== null) assert(found, 'browser Find must reach a message that was outside the window');
  await match.getByTestId('chat-message-menu-btn').focus();
  await page.keyboard.press('Tab');
  await expect(message(list, 274).getByTestId('chat-message-menu-btn')).toBeFocused();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expectChatItemInView(message(list, 274));
  assert(await list.getByTestId('chat-message').count() <= 40, 'turning off Show all must restore the bounded window');
  console.log(JSON.stringify({ showAllForFind: true, browserFind: found, keyboardReachedAllRows: true }));
}

async function checkUnmeasuredAnchor(page: Page, list: Locator) {
  const toggle = page.getByRole('button', { name: 'Show all loaded messages', exact: true });
  await scrollTo(list, 0);
  const tall = message(list, 315);
  await expect(tall).toHaveCount(0);
  await toggle.click();
  const positionInTallRow = 800;
  const scrolled = await tall.evaluate((row, offset) => {
    const viewport = row.closest<HTMLElement>('.chat-messages')!;
    if (row.getBoundingClientRect().height <= offset) return false;
    viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top + offset;
    return true;
  }, positionInTallRow);
  assert(scrolled, 'the fixture must be taller than the offset into the unmeasured row');
  await toggle.click();
  await expectChatItemInView(tall);
  await expect.poll(() => tall.evaluate((row) => row.getBoundingClientRect().top - row.closest('.chat-messages')!.getBoundingClientRect().top)).toBeCloseTo(-positionInTallRow, -1);
  console.log(JSON.stringify({ keptUnmeasuredAnchor: true }));
}

async function reachMessage(list: Locator, index: number) {
  const row = message(list, index);
  for (let i = 0; i <= 50 && await row.count() === 0; i++) await scrollTo(list, i / 50);
  await row.waitFor();
  return row;
}

async function checkWidthChange(page: Page, list: Locator) {
  await scrollTo(list, 0.5);
  let visibleId: string | undefined;
  await expect.poll(async () => {
    visibleId = await list.evaluate((el) => {
      const viewport = el.getBoundingClientRect();
      const middle = (viewport.top + viewport.bottom) / 2;
      return [...el.querySelectorAll<HTMLElement>('[data-message-id]')]
        .map((row) => ({ id: row.dataset.messageId, rect: row.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > viewport.top && rect.top < viewport.bottom)
        .map(({ id, rect }) => ({ id, distance: Math.abs(middle - (rect.top + rect.bottom) / 2) }))
        .sort((a, b) => a.distance - b.distance)[0]?.id;
    });
    return visibleId;
  }, { message: 'a message near the middle of the list must be visible before resizing' }).toBeDefined();
  assert(visibleId);
  const anchor = list.locator(`[data-message-id="${visibleId}"]`);
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ ...viewport, width: viewport.width + 64 });
  await expectChatItemInView(anchor);
  await page.setViewportSize(viewport);
  await expectChatItemInView(anchor);
  console.log(JSON.stringify({ widthChangeHeldVisibleMessage: true }));
}

async function checkKeyboardAndDialogs(page: Page, list: Locator) {
  const focusId = () => page.evaluate(() => document.activeElement?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId);
  const trigger = (row: Locator) => row.getByTestId('chat-message-menu-btn');
  const own = await reachMessage(list, 100);
  await trigger(own).focus();
  await scrollTo(list, 0.9);
  assert.equal(await focusId(), messageId(100));
  await page.keyboard.press('Tab');
  assert.equal(await focusId(), messageId(101));
  await expect(message(list, 101).getByTestId('chat-replies')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await focusId(), messageId(100));
  await page.keyboard.press('Enter');
  await own.getByTestId('chat-message-edit').click();
  const edit = own.getByRole('textbox', { name: 'Edit message' });
  await edit.fill('Unsent chat edit');

  const other = await reachMessage(list, 210);
  await trigger(other).click();
  await other.getByRole('button', { name: 'Report message' }).click();
  const dialog = page.getByRole('dialog', { name: 'Report message' });
  await expect(dialog).toBeVisible();
  await scrollTo(list, 0.9);
  await expect(other).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(trigger(other)).toBeFocused();
  await expect(edit).toHaveValue('Unsent chat edit');
  await own.getByRole('button', { name: 'Cancel' }).click();
  console.log(JSON.stringify({ forwardAndReverseTab: true, editRetained: true, reportFocusRestored: true }));
}

async function checkQuotes(page: Page, list: Locator) {
  await scrollTo(list, 1);
  const latest = message(list, total - 1);
  await expectChatItemInView(latest);
  const root = message(list, 150);
  await expect(root).toHaveCount(0);
  await latest.getByTestId('chat-quote').click();
  await expect(root).toHaveClass(/is-highlighted/);
  await expectChatItemInView(root);
  await root.getByTestId('chat-replies').click();
  await expect(page.getByTestId('chat-thread').getByTestId('chat-message')).toHaveCount(2);
  await page.getByTestId('chat-thread-close').click();
  await expect(root).toHaveClass(/is-highlighted/);
  await expectChatItemInView(root);
  console.log(JSON.stringify({ unloadedQuoteReached: true, threadAndReturn: true }));
}

async function postChat(api: APIRequestContext, url: string, text: string, bookId?: string): Promise<string> {
  const response = await api.post(url, { data: { text, bookId } });
  assert(response.ok(), await response.text());
  return (await response.json()).id;
}

async function checkNewMessages(page: Page, list: Locator, baseURL: string, clubId: string) {
  const friend = await signIn(baseURL, 'ben');
  const rowById = (id: string) => list.locator(`[data-message-id="${id}"]`);
  const url = `/api/clubs/${clubId}/chat`;
  const viewport = page.viewportSize()!;
  try {
    await scrollTo(list, 1);
    const latest = message(list, total - 1);
    await expectChatItemInView(latest);
    await page.setViewportSize({ ...viewport, height: viewport.height - 200 });
    await expectChatItemInView(latest);
    const whileFollowing = await postChat(friend, url, 'Arrives while you are at the newest message');
    await expectChatItemInView(rowById(whileFollowing));

    await scrollTo(list, 0.4);
    const before = await list.evaluate((el) => el.scrollTop);
    await page.setViewportSize(viewport);
    const moved = () => list.evaluate((el, prior) => Math.abs(el.scrollTop - prior), before);
    await expect.poll(moved).toBeLessThanOrEqual(2);
    await postChat(friend, url, 'Arrives while you are reading earlier messages');
    await expect(list).toHaveAttribute('data-loaded', String(total + 2));
    await expect.poll(moved).toBeLessThanOrEqual(2);

    await page.getByTestId('chat-input').fill('A message I send while reading earlier');
    await page.getByTestId('chat-send').click();
    await expectChatItemInView(list.getByText('A message I send while reading earlier'));
    console.log(JSON.stringify({ followsFriendAtBottom: true, holdsHistoryForFriend: true, followsOwnSend: true, resizePreserved: true }));
  } finally {
    await friend.dispose();
  }
}

async function checkLiveGrowth(page: Page, list: Locator, baseURL: string, clubId: string, bookId: string) {
  const friend = await signIn(baseURL, 'ben');
  const count = list.getByTestId('chat-message');
  try {
    await page.locator(`[data-testid="chat-channel-chip"][data-book-id="${bookId}"]`).click();
    await expect(count).toHaveCount(50);
    await scrollTo(list, 0.4);
    const before = await list.evaluate((el) => el.scrollTop);
    const newest = await postChat(friend, `/api/clubs/${clubId}/chat`, 'A book channel grows while you are reading', bookId);
    await expect(count).toHaveCount(51);
    assert.equal(await list.evaluate((el) => el.scrollTop), before);

    const reportOpener = list.locator('[data-message-id="fixture-book-chat-20"]');
    const menu = reportOpener.getByTestId('chat-message-menu-btn');
    await menu.click();
    await reportOpener.getByRole('button', { name: 'Report message' }).click();
    const dialog = page.getByRole('dialog', { name: 'Report message' });
    await expect(dialog).toBeVisible();
    await scrollTo(list, 1);
    await expect.poll(() => count.count()).toBeLessThanOrEqual(40);
    await expectChatItemInView(list.locator(`[data-message-id="${newest}"]`));
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(menu).toBeFocused();
    console.log(JSON.stringify({ smallChannelHeldHistory: true, windowedOnReturnToNewest: true, reportSurvivedGrowth: true }));
  } finally {
    await friend.dispose();
  }
}

const app = await makeTestApp({ WEB_DIST: path.resolve(dist) });
try {
  await seedDemoIfEmpty(app.ctx);
  const { db } = app.ctx;
  const club = db.get<{ id: string }>('SELECT id FROM clubs')!;
  const book = db.get<{ id: string }>('SELECT id FROM books WHERE club_id = ?', [club.id])!;
  const me = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', ['ana@demo.bookclub'])!;
  const friend = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', ['ben@demo.bookclub'])!;
  const time = Date.now() - total - 1000;
  db.tx(() => {
    for (let i = 0; i < total; i++) {
      const author = i === 100 || Math.floor(i / 50) % 2 === 1 ? me : friend;
      const parent = i === total - 1 ? messageId(150) : i === 102 ? messageId(101) : null;
      db.exec(
        'INSERT INTO chat_messages (id, club_id, user_id, text, created_at, parent_id, thread_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [messageId(i), club.id, author.id, `Chat window fixture ${i} ${'A friendly conversation about the book at our club. '.repeat(i === 315 ? 36 : i % 7)}`, time + i, parent, parent, i === 101 ? time + i : null],
      );
    }
    for (let i = 0; i < 50; i++) db.exec(
      'INSERT INTO chat_messages (id, club_id, book_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [`fixture-book-chat-${i}`, club.id, book.id, friend.id, `Book channel fixture ${i}. ${'A line about the book. '.repeat(i % 5)}`, time + i],
    );
  });

  const api = await signIn(app.baseUrl, 'ana');
  const browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: engine !== 'webkit' });
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'], baseURL: app.baseUrl, storageState: await api.storageState(), serviceWorkers: 'block' });
    const page = await context.newPage();
    const cdp = engine === 'chromium' ? await context.newCDPSession(page) : undefined;
    await cdp?.send('Performance.enable');
    const takeTaskSeconds = async () => (await cdp?.send('Performance.getMetrics'))?.metrics.find((metric) => metric.name === 'TaskDuration')?.value;
    await page.goto(`/clubs/${club.id}/chat`);
    const list = page.getByTestId('chat-messages');
    await expectChatItemInView(message(list, total - 1));
    if (!measurementsOnly) {
      await expect(message(list, total - 1)).toHaveAttribute('aria-setsize', '-1');
      const earlier = list.getByRole('button', { name: 'Earlier messages', exact: true });
      await expect(earlier).toHaveCount(1);
      const messageList = list.getByRole('list');
      await expect(messageList).toHaveCount(1);
      await expect(messageList.getByTestId('chat-message').first()).toBeAttached();
      await expect(messageList.getByRole('button', { name: 'Earlier messages', exact: true })).toHaveCount(0);
      if (!rowBudgetOnly) {
        const toggle = page.getByRole('button', { name: 'Show all loaded messages', exact: true });
        const loaded = Number(await list.getAttribute('data-loaded'));
        assert(loaded < total, 'the first page must omit older messages');
        await toggle.click();
        await expect(list.getByTestId('chat-message')).toHaveCount(loaded);
        await expect(list.getByTestId('chat-load-earlier')).toHaveCount(1);
        await expect(message(list, total - 1)).toHaveAttribute('aria-setsize', '-1');
        await toggle.click();
        await expectChatItemInView(message(list, total - 1));
      }
    }
    const beforeLoad = await takeTaskSeconds();
    const pressure = cpuPressure();
    const start = performance.now();
    const anchorDeltas = await loadHistory(list);
    const loadPressurePercent = (cpuPressure() - pressure) / ((performance.now() - start) * 10);
    const afterLoad = await takeTaskSeconds();
    const loadRendererMs = beforeLoad !== undefined && afterLoad !== undefined ? Math.round((afterLoad - beforeLoad) * 1000) : null;
    if (!measurementsOnly) {
      assert(anchorDeltas.every((delta) => Math.abs(delta) <= 2), 'prepending must keep the visible message within two pixels');
      await scrollTo(list, 0);
      await expectChatItemInView(message(list, 0));
      await expect(message(list, 0)).toHaveAttribute('aria-setsize', String(total));
    }
    if (rowBudgetOnly) {
      const peakMounted = await checkRowBudget(list);
      console.log(JSON.stringify({ engine, loaded: total, anchorDeltas, peakMounted }));
      await checkShowAll(page, list);
      await checkUnmeasuredAnchor(page, list);
    } else {
      await scrollTo(list, 0);
      const regular = await measureScroll(list, 'regular', takeTaskSeconds);
      const jumps = await measureScroll(list, 'jumps', takeTaskSeconds);
      console.log(JSON.stringify({ engine, loaded: total, anchorDeltas, loadRendererMs, loadPressurePercent, regular, jumps }));
      if (!measurementsOnly) {
        assert(Math.max(regular.peakMounted, jumps.peakMounted) <= 40, 'mounted message count must stay bounded');
        await checkWidthChange(page, list);
        await checkKeyboardAndDialogs(page, list);
        await checkQuotes(page, list);
        await checkShowAll(page, list);
        await checkNewMessages(page, list, app.baseUrl, club.id);
        await checkLiveGrowth(page, list, app.baseUrl, club.id, book.id);
      }
    }
  } finally {
    await browser.close();
    await api.dispose();
  }
} finally {
  await closeApp(app);
}
