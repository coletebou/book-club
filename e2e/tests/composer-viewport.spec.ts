import { type Locator, type Page, devices, expect, test } from '@playwright/test';
import { browserAs, clubWithAlice } from '../helpers/api';

const phone = (browserName: string) => browserName === 'webkit' ? devices['iPhone 15'] : { viewport: { width: 390, height: 844 } };
const VISIBLE_WITH_KEYBOARD = 450;

async function simulateVisualViewport(page: Page) {
  await page.addInitScript(() => {
    let height = window.innerHeight;
    const viewport = Object.assign(new EventTarget(), { offsetTop: 0, scale: 1 });
    Object.defineProperty(viewport, 'height', { get: () => height });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    window.addEventListener('test-visible-height', (event) => {
      height = (event as CustomEvent<number>).detail;
      viewport.dispatchEvent(new Event('resize'));
    });
  });
}

async function setVisibleHeight(page: Page, height: number) {
  await page.evaluate((size) => window.dispatchEvent(new CustomEvent('test-visible-height', { detail: size })), height);
}

async function expectLastItemVisible(list: Locator, item: Locator) {
  await expect.poll(async () => {
    const [viewport, last] = await Promise.all([list.boundingBox(), item.boundingBox()]);
    return !!viewport && !!last && last.y >= viewport.y - 1 && last.y + last.height <= viewport.y + viewport.height + 1;
  }).toBe(true);
}

async function expectAboveKeyboard(control: Locator) {
  await expect.poll(async () => {
    const field = await control.boundingBox();
    return field ? Math.max(-field.y, field.y + field.height - VISIBLE_WITH_KEYBOARD) : Infinity;
  }).toBeLessThanOrEqual(1);
}

async function verifyComposerViewport(page: Page, list: Locator, last: Locator, input: Locator, send: Locator) {
  await expectLastItemVisible(list, last);
  await input.focus();
  await setVisibleHeight(page, VISIBLE_WITH_KEYBOARD);
  await expectAboveKeyboard(input);
  await expectLastItemVisible(list, last);
  await input.fill(Array.from({ length: 7 }, (_, line) => `Draft line ${line + 1}`).join('\n'));
  await expectAboveKeyboard(input);
  await expectAboveKeyboard(send);
  await expectLastItemVisible(list, last);
}

async function verifyEarlierScrollPosition(list: Locator) {
  // A reader looking back should keep their place even when the resize is in the same frame.
  const { earlier, height } = await list.evaluate((el, nextHeight) => {
    const earlier = Math.floor(el.scrollTop / 2);
    const height = el.clientHeight;
    el.scrollTop = earlier;
    window.dispatchEvent(new CustomEvent('test-visible-height', { detail: nextHeight }));
    return { earlier, height };
  }, VISIBLE_WITH_KEYBOARD - 25);
  expect(earlier).toBeGreaterThan(0);
  await expect.poll(() => list.evaluate((el) => el.clientHeight)).not.toBe(height);
  await list.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await list.evaluate((el) => el.scrollTop)).toBe(earlier);
}

test('chat fits the keyboard and keeps the newest message visible in the standalone page and reader sheet', async ({ browser, browserName }, testInfo) => {
  const { club, book } = await clubWithAlice([]);
  for (let i = 1; i <= 24; i++) {
    expect((await club.owner.api.post(`/api/clubs/${club.id}/chat`, { data: { text: `Club message ${i} for the group.` } })).ok()).toBe(true);
  }
  const context = await browserAs(browser, club.owner, { ...phone(browserName), serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await simulateVisualViewport(page);
    let release!: () => void;
    const loading = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/clubs/${club.id}`, async (route) => {
      await loading;
      await route.continue();
    });
    try {
      await page.goto(`/clubs/${club.id}/chat`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('status', { name: 'Loading chat' })).toBeVisible();
    } finally {
      release();
    }
    const list = page.getByTestId('chat-messages');
    const last = list.getByTestId('chat-message').last();
    await expect(last).toContainText('Club message 24 for the group.');
    await verifyComposerViewport(page, list, last, page.getByTestId('chat-input'), page.getByTestId('chat-send'));
    await testInfo.attach('Chat fits the visual viewport', { body: await page.locator('.chat-page').screenshot(), contentType: 'image/png' });
    await verifyEarlierScrollPosition(list);

    await page.goto(`/books/${book.id}/read`);
    await page.getByTestId('open-chat-sheet').click();
    const sheet = page.getByTestId('chat-sheet');
    const sheetList = sheet.getByTestId('chat-messages');
    const sheetLast = sheetList.getByTestId('chat-message').last();
    await expect(sheetLast).toContainText('Club message 24 for the group.');
    await verifyComposerViewport(page, sheetList, sheetLast, sheet.getByTestId('chat-input'), sheet.getByTestId('chat-send'));
    await verifyEarlierScrollPosition(sheetList);
  } finally {
    await context.close();
  }
});

test('Cal keeps the current reply visible while its composer fits the keyboard', async ({ browser, browserName }, testInfo) => {
  const { club, book } = await clubWithAlice([]);
  const thread = await club.owner.api.post(`/api/clubs/${club.id}/cal/conversations`, { data: { bookId: book.id } });
  expect(thread.ok()).toBe(true);
  const { id } = await thread.json() as { id: string };
  for (let i = 1; i <= 7; i++) {
    const reply = await club.owner.api.post(`/api/cal/conversations/${id}/messages`, { data: { text: `What does the White Rabbit say in passage ${i}?` } });
    expect(reply.ok()).toBe(true);
    expect(await reply.text()).toContain('event: done');
  }
  const context = await browserAs(browser, club.owner, phone(browserName));
  try {
    const page = await context.newPage();
    await simulateVisualViewport(page);
    await page.goto(`/books/${book.id}`);
    await page.getByTestId('cal-launcher').click();
    const list = page.locator('.cal-messages');
    const replies = list.getByTestId('cal-message-assistant');
    await expect(replies).toHaveCount(7);
    await verifyComposerViewport(page, list, replies.last(), page.getByTestId('cal-input'), page.getByTestId('cal-send'));
    await testInfo.attach('Cal fits the visual viewport', { body: await page.getByRole('dialog', { name: 'Ask Cal' }).screenshot(), contentType: 'image/png' });
    await verifyEarlierScrollPosition(list);
  } finally {
    await context.close();
  }
});
