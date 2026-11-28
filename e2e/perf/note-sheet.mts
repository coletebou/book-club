import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { type APIRequestContext, type Locator, type Page, chromium, devices, expect, request, webkit } from '@playwright/test';
import { CommentViewSchema, tToLocator } from '@bookclub/shared';
import { seedDemoIfEmpty } from '../../apps/server/src/cli/seed';
import { adoptBlob } from '../../apps/server/src/repos/blobs';
import { editionById, editionTimeline } from '../../apps/server/src/repos/books';
import { attachMedia, insertCommentMedia, markMediaProcessed, setMediaTranscript } from '../../apps/server/src/repos/comment-media';
import { insertComment } from '../../apps/server/src/repos/comments';
import { closeApp, makeTestApp } from '../../apps/server/test/helpers';

// Run from the root with apps/server/node_modules/.bin/tsx e2e/perf/note-sheet.mts <production-dist> [chromium|webkit].
// --measure-only also works with an unwindowed build. --row-budget is the CI guard.
const [dist, engine = 'chromium', mode] = process.argv.slice(2);
if (!dist || (engine !== 'chromium' && engine !== 'webkit') || (mode && mode !== '--measure-only' && mode !== '--row-budget')) {
  throw new Error('Expected a build directory, optional browser name and optional measurement mode');
}
const measureOnly = mode === '--measure-only';
const rowBudgetOnly = mode === '--row-budget';

function startPressure() {
  const file = '/proc/pressure/cpu';
  if (!existsSync(file)) return () => null;
  const read = () => Number(/^some .*total=(\d+)/m.exec(readFileSync(file, 'utf8'))?.[1] ?? 0);
  const before = read();
  const start = performance.now();
  return () => (read() - before) / ((performance.now() - start) * 10);
}

async function scrollNotes(list: Locator, fraction: number) {
  await list.evaluate(async (element, position) => {
    const scroll = element.parentElement!;
    scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * position;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  }, fraction);
}

async function measureScroll(list: Locator, taskSeconds: () => Promise<number | undefined>) {
  const before = await taskSeconds();
  const pressure = startPressure();
  const { peakMounted, scrollMs } = await list.evaluate(async (element) => {
    const scroll = element.parentElement!;
    const start = performance.now();
    let peakMounted = element.children.length;
    for (let i = 0; i < 50; i++) {
      scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * i / 49;
      await new Promise(requestAnimationFrame);
      peakMounted = Math.max(peakMounted, element.children.length);
    }
    return { peakMounted, scrollMs: Math.round(performance.now() - start) };
  });
  const scrollPressurePercent = pressure();
  const after = await taskSeconds();
  const rendererTaskMs = before !== undefined && after !== undefined ? Math.round((after - before) * 1000) : null;
  return { peakMounted, scrollMs, scrollPressurePercent, rendererTaskMs };
}

async function mountNote(list: Locator, note: Locator) {
  for (let i = 0; i <= 50 && await note.count() === 0; i++) await scrollNotes(list, i / 50);
  await note.waitFor();
}

async function checkFinalNote(list: Locator, total: number) {
  await list.evaluate(async (element) => {
    const scroll = element.parentElement!;
    for (let i = 0; i < 8; i++) {
      scroll.scrollTop = scroll.scrollHeight;
      await new Promise(requestAnimationFrame);
    }
  });
  const finalNote = list.locator(`[aria-posinset="${total}"][aria-setsize="${total}"]`);
  await expect(finalNote).toBeInViewport();
  assert((await finalNote.innerText()).length > 0);
}

async function checkMiddleNote(list: Locator, total: number) {
  await scrollNotes(list, 0.5);
  // The window can mount edge controls outside the scrollport for keyboard navigation.
  await expect.poll(() => list.evaluate((element, count) => {
    const scroll = element.parentElement!.getBoundingClientRect();
    return [...element.children].some((row) => {
      const position = Number(row.getAttribute('aria-posinset'));
      if (position < count / 4 || position > 3 * count / 4) return false;
      const rect = row.getBoundingClientRect();
      return rect.top < scroll.bottom && rect.bottom > scroll.top;
    });
  }, total), { message: 'scrolling to the middle must put an interior note in view' }).toBe(true);
}

async function checkKeyboard(page: Page, total: number) {
  const list = page.getByTestId('marker-sheet');
  await list.evaluate(async (element) => {
    element.parentElement!.scrollTop = 0;
    await new Promise(requestAnimationFrame);
  });
  await list.locator('[aria-posinset="1"]').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).focus();
  const focused = () => page.evaluate(() =>
    Number(document.activeElement?.closest('[data-index]')?.getAttribute('data-index') ?? -1));
  let highest = -1;
  for (let i = 0; i < 140 && highest < 42; i++) {
    await page.keyboard.press('Tab');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    highest = Math.max(highest, await focused());
  }
  assert(highest >= 42, 'Tab must reach notes beyond the initial window');
  const before = await focused();
  await page.keyboard.press('Shift+Tab');
  const backward = await focused();
  assert(backward >= 0 && backward <= before);
  await list.evaluate(async (element) => {
    const scroll = element.parentElement!;
    scroll.scrollTop = scroll.scrollHeight / 2;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  assert.equal(await focused(), backward, 'scrolling must keep focus on the same note');
  for (const index of [backward - 1, backward + 1]) {
    if (index >= 0 && index < total) assert.equal(await list.locator(`[data-index="${index}"]`).count(), 1);
  }
  assert(await list.getByTestId('sheet-note').count() <= 40, 'keeping keyboard focus must keep the mounted window bounded');

  await checkFinalNote(list, total);
  console.log(JSON.stringify({ highestKeyboardIndex: highest, reverseKeyboardIndex: backward, finalNote: total, retainedFocus: true }));
}

async function checkTabAcrossHeldNotes(page: Page, ids: { before: string; hidden: string; lastHeld: string; after: string }) {
  const list = page.getByTestId('marker-sheet');
  const note = (id: string) => list.locator(`[data-note-id="${id}"]`);
  const focusControl = async (id: string, control: Locator) => {
    await mountNote(list, note(id));
    await control.focus();
  };
  const focusedNote = () => page.evaluate(() => document.activeElement?.closest('[data-note-id]')?.getAttribute('data-note-id'));

  await focusControl(ids.before, note(ids.before).getByTestId('reply-open'));
  assert.equal(await note(ids.hidden).getAttribute('data-hidden'), 'true');
  await note(ids.hidden).getByRole('button', { name: 'Block member', exact: true }).waitFor();
  await scrollNotes(list, 0.8);
  assert.equal(await focusedNote(), ids.before);
  await page.keyboard.press('Tab');
  assert.equal(await focusedNote(), ids.hidden, 'Tab must reach the safety action on a held note');

  await focusControl(ids.after, note(ids.after).getByRole('button', { name: 'Go to passage', exact: true }));
  await scrollNotes(list, 0.8);
  assert.equal(await focusedNote(), ids.after);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await focusedNote(), ids.lastHeld, 'Shift+Tab must reach the preceding held note’s safety action');
  console.log(JSON.stringify({ tabAcrossHidden: true }));
}

async function checkConfirmOpener(page: Page, noteId: string) {
  const list = page.getByTestId('marker-sheet');
  const note = list.locator(`[data-note-id="${noteId}"]`);
  await mountNote(list, note);
  const opener = note.getByRole('button', { name: 'Block member', exact: true });
  await opener.focus();
  await opener.click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await scrollNotes(list, 0.8);
  assert.equal(await opener.count(), 1, 'the confirm opener must stay mounted after scrolling away');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(opener).toBeFocused();
  console.log(JSON.stringify({ retainedConfirmOpener: true }));
}

async function checkActiveNotes(page: Page, draftNoteId: string, mediaNoteId: string, focusNoteId: string) {
  const list = page.getByTestId('marker-sheet');
  const focusOtherNote = async () => {
    const other = list.locator(`[data-note-id="${focusNoteId}"]`);
    await mountNote(list, other);
    await other.getByTestId('reply-open').focus();
  };
  const draftNote = list.locator(`[data-note-id="${draftNoteId}"]`);
  await mountNote(list, draftNote);
  await focusOtherNote();
  await scrollNotes(list, 0.5);
  assert.equal(await draftNote.count(), 0, 'the draft fixture must use a row the window normally unmounts');
  await mountNote(list, draftNote);
  const reply = draftNote.getByTestId('reply-text');
  await draftNote.getByTestId('reply-open').click();
  await reply.fill('Draft survives scrolling');
  await focusOtherNote();
  await scrollNotes(list, 0.5);
  assert.equal(await reply.count(), 1, 'the note with an active reply must remain mounted');
  assert.equal(await reply.inputValue(), 'Draft survives scrolling');
  await draftNote.getByRole('button', { name: 'Cancel', exact: true }).click();

  const voiceNote = list.locator(`[data-note-id="${mediaNoteId}"]`);
  await mountNote(list, voiceNote);
  const player = voiceNote.getByTestId('note-voice-player');
  await player.evaluate((element) => (element as HTMLAudioElement).play());
  const inspectPlayback = () => player.evaluate((element) => {
    const audio = element as HTMLAudioElement;
    return { time: audio.currentTime, duration: audio.duration, paused: audio.paused, ended: audio.ended, readyState: audio.readyState };
  });
  const before = (await inspectPlayback()).time;
  console.log(JSON.stringify({ phase: 'played', ...(await inspectPlayback()) }));
  const index = Number(await voiceNote.getAttribute('aria-posinset'));
  await focusOtherNote();
  await scrollNotes(list, index < 250 ? 1 : 0);
  assert.equal(await player.count(), 1, 'a playing note must stay mounted away from the viewport');
  console.log(JSON.stringify({ phase: 'after scroll', ...(await inspectPlayback()) }));
  await page.waitForFunction(({ id, elapsed }) => {
    const audio = document.querySelector<HTMLAudioElement>(`[data-note-id="${id}"] audio`);
    return audio && !audio.paused && audio.currentTime > elapsed;
  }, { id: mediaNoteId, elapsed: before });

  await voiceNote.getByTestId('note-voice-transcript-toggle').click();
  await player.evaluate((element) => (element as HTMLAudioElement).pause());
  await focusOtherNote();
  await scrollNotes(list, index < 250 ? 1 : 0);
  assert.equal(await voiceNote.getByTestId('note-voice-transcript').innerText(), 'Fixture transcript');
  assert(await list.getByTestId('sheet-note').count() <= 40, 'retained notes must coexist with the bounded window');

  await voiceNote.getByTestId('note-voice-transcript-toggle').click();
  const position = await player.evaluate(async (element) => {
    const audio = element as HTMLAudioElement;
    await new Promise<void>((resolve) => {
      audio.addEventListener('seeked', () => resolve(), { once: true });
      audio.currentTime = 2.5;
    });
    return audio.currentTime;
  });
  await focusOtherNote();
  await scrollNotes(list, index < 250 ? 1 : 0);
  assert.equal(await player.count(), 0, 'a paused note with a closed transcript can leave the window');
  await mountNote(list, voiceNote);
  await player.waitFor();
  await page.waitForFunction(({ id, time }) => {
    const audio = document.querySelector<HTMLAudioElement>(`[data-note-id="${id}"] audio`);
    return audio && audio.paused && Math.abs(audio.currentTime - time) < 0.1;
  }, { id: mediaNoteId, time: position }, { timeout: 3000 });
  console.log(JSON.stringify({ retainedDraft: true, retainedPlayback: true, retainedTranscript: true, restoredPausedPosition: position }));
}

async function checkFind(page: Page, total: number, taskSeconds: () => Promise<number | undefined>) {
  const sheet = page.getByTestId('marker-sheet');
  const notes = sheet.getByTestId('sheet-note');
  const fullList = page.getByRole('button', { name: 'Show all notes', exact: true });
  const phrase = 'Fixture note 273 A short observation';
  await scrollNotes(sheet, 0);
  assert.equal(await notes.filter({ hasText: phrase }).count(), 0);
  await fullList.click();
  await notes.filter({ hasText: phrase }).waitFor();
  assert.equal(await notes.count(), total);
  assert.equal(await notes.filter({ hasText: 'Fixture note 50 A short observation' }).count(), 0);
  console.log(JSON.stringify({ view: 'show-all', ...await measureScroll(sheet, taskSeconds) }));
  const found = await page.evaluate((text) => {
    const find = (window as Window & { find?: (text: string, caseSensitive: boolean, backwards: boolean, wrap: boolean) => boolean }).find;
    return find ? find.call(window, text, true, false, true) : null;
  }, phrase);
  if (found !== null) assert(found, 'browser Find must reach a note that was outside the window');
  await fullList.click();
  assert(await notes.count() <= 40, 'turning off the full list must restore the bounded window');
  console.log(JSON.stringify({ showAllForFind: true, browserFind: found }));
}

async function openSmallerGroup(page: Page, api: APIRequestContext, test: Awaited<ReturnType<typeof makeTestApp>>, bookId: string, noteIds: string[], size: number) {
  const { db } = test.ctx;
  const response = await api.get(`/api/books/${bookId}/comments`);
  assert(response.ok());
  const notes = CommentViewSchema.array().parse(await response.json());
  const keepFixtures = size - (notes.length - noteIds.length);
  assert(keepFixtures > 5);
  const returning = notes.find((note) => note.id === noteIds[keepFixtures - 1]);
  assert(returning && !returning.hidden);
  db.tx(() => {
    for (const id of noteIds.slice(keepFixtures)) db.exec('DELETE FROM comments WHERE id = ?', [id]);
  });

  await page.reload();
  await page.locator(`[data-testid="bar-comment-group"][data-count="${size}"]`).click();
  return returning;
}

async function checkWindowTransition(page: Page, api: APIRequestContext, test: Awaited<ReturnType<typeof makeTestApp>>, bookId: string, userId: string, noteIds: string[], taskSeconds: () => Promise<number | undefined>) {
  const { db } = test.ctx;
  const clubId = db.get<{ club_id: string }>('SELECT club_id FROM books WHERE id = ?', [bookId])!.club_id;
  const returning = await openSmallerGroup(page, api, test, bookId, noteIds, 41);
  const sheet = page.getByTestId('marker-sheet');
  await sheet.locator('[aria-setsize="41"]').first().waitFor();
  // Temporarily remove one of the IDs already in this group, then replay its authenticated
  // view over the normal realtime channel while a draft is open on the 40-row sheet.
  assert.equal((await api.delete(`/api/comments/${returning.id}`)).status(), 204);
  await page.waitForFunction(() => document.querySelector('[data-testid="marker-sheet"]')?.children.length === 40);
  console.log(JSON.stringify({ view: 'small', ...await measureScroll(sheet, taskSeconds) }));
  const draftNote = sheet.getByTestId('sheet-note').filter({ hasText: /Fixture note 5 / });
  await draftNote.getByTestId('reply-open').click();
  await draftNote.getByTestId('reply-text').fill('Draft survives a larger group');
  await sheet.locator(`[data-note-id="${noteIds[8]}"]`).getByTestId('reply-open').focus();
  db.exec('UPDATE comments SET deleted_at = NULL, text = ? WHERE id = ?', [returning.text, returning.id]);
  test.ctx.hub.publish(clubId, (recipientId) => recipientId === userId
    ? { type: 'comment:new', clubId, bookId, comment: returning }
    : null);
  await sheet.locator('[aria-setsize="41"]').first().waitFor();
  assert.equal(await draftNote.getByTestId('reply-text').inputValue({ timeout: 3000 }), 'Draft survives a larger group');
  console.log(JSON.stringify({ retainedDraftOnWindowTransition: true }));
}

const test = await makeTestApp({ WEB_DIST: path.resolve(dist) });
try {
  await seedDemoIfEmpty(test.ctx);
  const { db } = test.ctx;
  const user = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', ['ana@demo.bookclub'])!;
  const friend = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', ['cleo@demo.bookclub'])!;
  const edition = db.get<{ id: string; book_id: string }>("SELECT id, book_id FROM editions WHERE kind = 'epub'")!;
  const timeline = editionTimeline(editionById(db, edition.id)!)!;
  const at = 0.25;
  const locator = tToLocator(timeline, at);
  const noteIds = db.tx(() => {
    const start = Date.now();
    return Array.from({ length: 500 }, (_, i) => {
      const held = i >= 50 && i <= 52;
      const noteId = insertComment(db, {
        bookId: edition.book_id, userId: held ? friend.id : user.id, editionId: edition.id, kind: 'epub', locator,
        endLocator: null, t: at, endT: null, quote: null,
        text: `Fixture note ${i} ${'A short observation about the story. '.repeat(i % 4)}`,
        reaction: null, clientId: null,
        horizon: held ? { editionId: edition.id, locator: tToLocator(timeline, 0.95), t: 0.95 } : null,
      });
      db.exec('UPDATE comments SET created_at = ? WHERE id = ?', [start + i, noteId]);
      return noteId;
    });
  });
  const mediaNoteId = noteIds[0]!;
  const audioFile = path.join(test.ctx.storage.tmpDir, 'note-window-fixture.mp3');
  await copyFile(path.resolve('fixtures/audio/alice-tiny/wonderland_ch_02_64kb.mp3'), audioFile);
  const clip = await adoptBlob(db, test.ctx.storage, audioFile, 'audio/mpeg');
  const media = insertCommentMedia(db, { userId: user.id, bookId: edition.book_id, kind: 'voice' });
  markMediaProcessed(db, media.id, {
    status: 'ready', originalBlobId: clip.id, derivedBlobId: clip.id, posterBlobId: null,
    mime: 'audio/mpeg', durationMs: null, width: null, height: null, transcriptStatus: 'ready', error: null,
  });
  setMediaTranscript(db, media.id, 'Fixture transcript', 'ready');
  assert(attachMedia(db, mediaNoteId, user.id, edition.book_id, [media.id]));
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: engine !== 'webkit' });
  let api: APIRequestContext | undefined;
  try {
    api = await request.newContext({ baseURL: test.baseUrl, extraHTTPHeaders: { origin: test.baseUrl } });
    assert((await api.post('/api/auth/signin', { data: { email: 'ana@demo.bookclub', password: 'wonderland-demo' } })).ok());
    const context = await browser.newContext({
      baseURL: test.baseUrl, storageState: await api.storageState(), serviceWorkers: 'block', ...devices['iPhone 15'],
    });
    const page = await context.newPage();
    const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null;
    await cdp?.send('Performance.enable');
    const taskSeconds = async () => (await cdp?.send('Performance.getMetrics'))?.metrics
      .find((metric) => metric.name === 'TaskDuration')?.value;
    await page.goto(`/books/${edition.book_id}/read?edition=${edition.id}`);
    const markers = page.getByTestId('bar-comment-group');
    await markers.first().waitFor();
    const total = Math.max(...await markers.evaluateAll((items) => items.map((item) => Number(item.getAttribute('data-count')))));
    assert(total >= 500, 'expected a large note group');
    const marker = page.locator(`[data-testid="bar-comment-group"][data-count="${total}"]`);
    await marker.evaluate((target) => {
      target.addEventListener('click', () => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (!document.querySelector('[data-testid="sheet-note"]')) return;
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => performance.measure('note-sheet-paint', { start })));
        });
        observer.observe(document, { childList: true, subtree: true });
      }, { once: true });
    });
    const openPressure = startPressure();
    await marker.click();
    await page.waitForFunction(() => performance.getEntriesByName('note-sheet-paint').length > 0);
    const open = await page.evaluate(() => performance.getEntriesByName('note-sheet-paint')[0]!.duration);
    const openPressurePercent = openPressure();
    const sheet = page.getByTestId('marker-sheet');
    const mountedFirst = await sheet.getByTestId('sheet-note').count();
    const large = await measureScroll(sheet, taskSeconds);
    console.log(JSON.stringify({
      view: 'large', engine, total, mountedFirst, openMs: Math.round(open), openPressurePercent, ...large,
    }));
    if (measureOnly) {
      const showAll = page.getByRole('button', { name: 'Show all notes', exact: true });
      if (await showAll.count()) await showAll.click();
      await expect(sheet.getByTestId('sheet-note')).toHaveCount(total);
      console.log(JSON.stringify({ view: 'show-all', ...await measureScroll(sheet, taskSeconds) }));
      await openSmallerGroup(page, api, test, edition.book_id, noteIds, 40);
      await expect(sheet.getByTestId('sheet-note')).toHaveCount(40);
      console.log(JSON.stringify({ view: 'small', ...await measureScroll(sheet, taskSeconds) }));
    } else {
      assert(large.peakMounted <= 40, 'scrolling a large note group must keep a bounded number of mounted rows');
      if (rowBudgetOnly) {
        await checkMiddleNote(sheet, total);
        await checkFinalNote(sheet, total);
      } else {
        await expect(page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })).toBeFocused();
        await checkKeyboard(page, total);
        await checkTabAcrossHeldNotes(page, { before: noteIds[49]!, hidden: noteIds[50]!, lastHeld: noteIds[52]!, after: noteIds[53]! });
        await checkConfirmOpener(page, noteIds[50]!);
        await checkActiveNotes(page, noteIds[24]!, mediaNoteId, noteIds[8]!);
        await checkFind(page, total, taskSeconds);
        await checkWindowTransition(page, api, test, edition.book_id, user.id, noteIds, taskSeconds);
      }
    }
  } finally {
    await Promise.all([browser.close(), api?.dispose()]);
  }
} finally {
  await closeApp(test);
}
