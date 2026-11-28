import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, devices, expect, webkit } from '@playwright/test';
import { seedDemoIfEmpty } from '../../apps/server/src/cli/seed';
import { makeTestApp, closeApp } from '../../apps/server/test/helpers';

// From the root: apps/server/node_modules/.bin/tsx e2e/perf/chat-voice-window.mts <production-dist> <wave> [chromium|webkit].
// Use a 36-second wave fixture so the clip can outlast WebKit scrolling and two media seeks.
const [dist, wave, engine = 'chromium'] = process.argv.slice(2);
if (!dist || !wave || (engine !== 'chromium' && engine !== 'webkit')) {
  throw new Error('Expected a build directory, a wave recording and an optional browser name');
}
const app = await makeTestApp({ WEB_DIST: path.resolve(dist) });
try {
  await seedDemoIfEmpty(app.ctx);
  process.env.BOOKCLUB_URL = app.baseUrl;
  const { SYNTHETIC_DIR, audioFolder, browserAs, makeClub, uploadBook } = await import('../helpers/api');
  const club = await makeClub(['Ben']);
  const owner = club.owner;
  const book = await uploadBook(owner, club.id, 'audio', audioFolder(SYNTHETIC_DIR), {
    title: 'Audiobook under a chat voice clip', author: 'Fixture',
  });
  const other = club.members.Ben!;
  const earlier = Date.now() - 10_000;
  app.ctx.db.tx(() => {
    for (let i = 0; i < 500; i++) app.ctx.db.exec(
      'INSERT INTO chat_messages (id, club_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)',
      [`fixture-v20-history-${i}`, club.id, other.id, `Older chat message ${i}. ${'Four lines of chat history. '.repeat(i % 5)}`, earlier + i],
    );
  });
  const clipUpload = await other.api.post(`/api/clubs/${club.id}/chat/attachments?kind=voice`, {
    multipart: { file: { name: 'clip.wav', mimeType: 'audio/wav', buffer: readFileSync(wave) } },
  });
  assert.equal(clipUpload.status(), 201, await clipUpload.text());
  const attachment = (await clipUpload.json()) as { id: string };
  const sent = await other.api.post(`/api/clubs/${club.id}/chat`, { data: { text: 'The active voice clip', attachmentIds: [attachment.id] } });
  assert.equal(sent.status(), 201, await sent.text());
  const id = (await sent.json() as { id: string }).id;
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: engine !== 'webkit' });
  try {
    const context = await browserAs(browser, owner, { ...devices['iPhone 15'], serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto(new URL(`/books/${book.id}/listen`, app.baseUrl).href);
    await page.getByTestId('play-pause').click();
    const bookPlayer = page.getByTestId('audio-element');
    const paused = () => bookPlayer.evaluate((element: HTMLAudioElement) => element.paused);
    await expect.poll(paused).toBe(false);
    await page.getByTestId('open-chat-sheet').click();
    const chat = page.getByTestId('chat-sheet');
    const list = chat.getByTestId('chat-messages');
    const row = list.locator(`[data-message-id="${id}"]`);
    const player = row.getByTestId('chat-voice-player');
    const initialPlayer = await player.elementHandle();
    await player.evaluate((element: HTMLAudioElement) => element.play());
    await expect.poll(paused).toBe(true);
    const seconds = () => player.evaluate((element: HTMLAudioElement) => element.currentTime);
    const start = await seconds();
    const scrollAway = () => list.evaluate(async (element) => {
      element.scrollTop = 0;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await scrollAway();
    await expect.poll(() => list.evaluate((element) => {
      const row = element.querySelector('[data-message-id="fixture-v20-history-451"]')?.getBoundingClientRect();
      const viewport = element.getBoundingClientRect();
      return !!row && row.bottom > viewport.top && row.top < viewport.bottom;
    })).toBe(true);
    const mounted = await row.count();
    const audiobookHeld = await paused();
    console.log(JSON.stringify({ engine, mounted, audiobookHeld }));
    assert.equal(mounted, 1, 'an active clip stays mounted after its row scrolls away');
    assert.equal(audiobookHeld, true, 'the audiobook stays held while the scrolled-out clip plays');
    assert(await player.evaluate((element, original) => element === original, initialPlayer), 'the same audio element stays mounted');
    await expect.poll(seconds).toBeGreaterThan(start + 1);
    const pausedAt = await player.evaluate((element: HTMLAudioElement) => {
      element.pause();
      return element.currentTime;
    });
    await expect.poll(paused).toBe(false);
    await expect(row).toHaveCount(0);
    const scrollBack = () => list.evaluate(async (element) => {
      for (let i = 0; i < 5; i++) {
        element.scrollTop = element.scrollHeight;
        await new Promise(requestAnimationFrame);
      }
    });
    await scrollBack();
    assert(await player.evaluate((element: HTMLAudioElement) => element.paused), 'the remounted clip starts paused');
    await player.evaluate((element: HTMLAudioElement) => element.load());
    await expect.poll(() => player.evaluate((element: HTMLAudioElement, expected) => (
      element.paused && element.readyState >= 1 && !element.seeking && Math.abs(element.currentTime - expected) <= 0.2
    ), pausedAt)).toBe(true);
    const restoredAt = await seconds();
    await player.evaluate((element: HTMLAudioElement) => element.play());
    await expect.poll(seconds).toBeGreaterThan(restoredAt + 0.2);
    const pausedAgainAt = await player.evaluate((element: HTMLAudioElement) => {
      element.pause();
      return element.currentTime;
    });
    await scrollAway();
    await expect(row).toHaveCount(0);
    await scrollBack();
    assert(await player.evaluate((element: HTMLAudioElement) => element.paused), 'a second remount also stays paused');
    const playedFrom = await player.evaluate(async (element: HTMLAudioElement) => {
      await element.play();
      return element.paused || element.ended ? null : element.currentTime;
    });
    assert(playedFrom !== null && Math.abs(playedFrom - pausedAgainAt) <= 0.2, 'pressing Play on a fresh element must start at the saved position');
    console.log(JSON.stringify({ engine, clipAdvanced: true, audiobookResumedAfterPause: true, pausedAt, restoredAt, pausedAgainAt, playedFrom }));
  } finally {
    await browser.close();
  }
} finally {
  await closeApp(app);
}
