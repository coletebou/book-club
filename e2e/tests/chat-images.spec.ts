import { type Page, expect, test } from '@playwright/test';
import type { ChatMessageView, UploadedChatAttachment } from '@bookclub/shared';
import { browserAs, clubWithAlice, makeClub, png } from '../helpers/api';

const bubble = (page: Page, text: string) => page.getByTestId('chat-message').filter({ hasText: text });
const picture = (seed: number) => png(320, 200, (y) => [(seed * 70) % 255, (y * 3) % 255, 120]);

/** Hand the page a picture the way a paste or a drop does: a DataTransfer holding a File. */
async function transfer(page: Page, selector: string, kind: 'paste' | 'drop', name: string, seed: number) {
  const bytes = [...picture(seed)];
  await page.evaluate(
    ({ selector, kind, name, bytes }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
      const target = document.querySelector(selector)!;
      if (kind === 'drop') {
        const over = new Event('dragover', { bubbles: true, cancelable: true });
        Object.defineProperty(over, 'dataTransfer', { value: dt });
        target.dispatchEvent(over);
      }
      const event = new Event(kind, { bubbles: true, cancelable: true });
      Object.defineProperty(event, kind === 'paste' ? 'clipboardData' : 'dataTransfer', { value: dt });
      target.dispatchEvent(event);
    },
    { selector, kind, name, bytes },
  );
}

test.describe('pictures in chat (D203)', () => {
  test('pictures picked, pasted and dropped are sent; a friend sees them and opens one full size', async ({ browser }) => {
    const club = await makeClub(['Ana', 'Ben']);
    const anaCtx = await browserAs(browser, club.members.Ana!);
    const ana = await anaCtx.newPage();
    await ana.goto(`/clubs/${club.id}/chat`);
    await ana.getByTestId('chat-attach-input').setInputFiles([
      { name: 'one.png', mimeType: 'image/png', buffer: picture(1) },
      { name: 'two.png', mimeType: 'image/png', buffer: picture(2) },
    ]);
    await transfer(ana, '[data-testid="chat-input"]', 'paste', 'pasted.png', 3);
    await transfer(ana, '[data-testid="chat-panel"]', 'drop', 'dropped.png', 4);
    const chips = ana.getByTestId('chat-attachment');
    await expect(chips).toHaveCount(4);
    await expect(chips.and(ana.locator('[data-status="ready"]'))).toHaveCount(4);
    await ana.getByTestId('chat-input').fill('the croquet ground');
    await ana.getByTestId('chat-send').click();
    await expect(chips).toHaveCount(0);
    const sent = bubble(ana, 'the croquet ground');
    await expect(sent.getByTestId('chat-image')).toHaveCount(4);

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}/chat`);
    const seen = bubble(ben, 'the croquet ground');
    await expect(seen.getByTestId('chat-image')).toHaveCount(4);
    // The thumbnails really load (gated, uncached addresses, served to a member).
    await expect.poll(() => seen.locator('img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await seen.getByTestId('chat-image').nth(1).click();
    const full = ben.getByTestId('chat-lightbox-image');
    await expect(full).toBeVisible();
    await expect.poll(() => full.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
    await expect(ben.getByRole('dialog')).toContainText('Picture 2 of 4');
    await ben.getByTestId('chat-lightbox-next').click();
    await expect(ben.getByRole('dialog')).toContainText('Picture 3 of 4');
    await ben.keyboard.press('Escape');
    await expect(ben.getByTestId('chat-lightbox')).toHaveCount(0);
    await anaCtx.close();
    await benCtx.close();
  });

  test('a fenced message keeps its pictures hidden with it from a friend not that far', async ({ browser }) => {
    const { club, book } = await clubWithAlice(['Ana', 'Ben']);
    const ana = club.members.Ana!;
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const geometry = epub.geometry!;
    if (geometry.kind !== 'epub') throw new Error('expected an epub edition');
    const mid = { kind: 'epub' as const, section: Math.max(1, Math.floor(geometry.sectionLengths.length / 2)), offset: 0 };
    await ana.api.put(`/api/books/${book.id}/progress`, { data: { editionId: epub.id, locator: mid, readSpans: [{ from: { kind: 'epub', section: 0, offset: 0 }, to: mid }], at: Date.now() } });
    const place = ((await (await ana.api.get(`/api/books/${book.id}`)).json()) as { progress: { userId: string; t: number }[] }).progress.find((p) => p.userId === ana.id)!.t;
    const up = (await (
      await ana.api.post(`/api/clubs/${club.id}/chat/attachments`, { multipart: { file: { name: 'scene.png', mimeType: 'image/png', buffer: picture(9) } } })
    ).json()) as UploadedChatAttachment;
    expect(up.status).toBe('ready');
    const fenced = (await (await ana.api.post(`/api/clubs/${club.id}/chat`, { data: { bookId: book.id, text: 'the trial', spoilerUpToT: place, attachmentIds: [up.id] } })).json()) as ChatMessageView;
    expect(fenced.hidden).toBe(false);

    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/clubs/${club.id}/chat`);
    await ben.locator(`[data-testid="chat-channel-chip"][data-book-id="${book.id}"]`).click();
    const marker = ben.getByTestId('chat-spoiler-marker');
    await expect(marker).toContainText('1 picture');
    await expect(ben.getByTestId('chat-image')).toHaveCount(0);
    expect((await ben.request.get(`/media/chat/${up.id}`)).status()).toBe(404);
    expect((await ben.request.get(`/media/chat/${up.id}/thumb`)).status()).toBe(404);
    await benCtx.close();
  });
});
