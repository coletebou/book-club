import path from 'node:path';
import { expect, test } from '@playwright/test';
import { allowCal, FIXTURES, aliceEpub, browserAs, makeClub, putProgress, serverPlace, uploadBook } from '../helpers/api';

test('opening the playing CarPlay book from another title adopts its newer chapter and live position', async ({ browser }) => {
  type NativeCommand = { type: string; position?: number; playbackRate?: number; at?: number };
  const club = await makeClub([]);
  const files = ['01 - The Beginning.mp3', '02 - The Middle.mp3'].map((name) => ({
    name, path: path.join(FIXTURES, 'audio/synthetic', name), type: 'audio/mpeg', role: 'track' as const,
  }));
  const book = await uploadBook(club.owner, club.id, 'audio', files, {
    title: 'Listening in the car', author: 'Ada Tone', trackTitles: ['The Beginning', 'The Middle'],
  });
  const previous = await uploadBook(club.owner, club.id, 'audio', [files[0]!], { title: 'Earlier audiobook', author: 'Ada Tone' });
  const edition = book.editions.find((item) => item.kind === 'audio')!;
  expect(edition.tracks).toHaveLength(2);
  await putProgress(club.owner, book.id, edition.id, { kind: 'audio', track: 0, ms: 1_000 }, []);
  const ctx = await browserAs(browser, club.owner, { serviceWorkers: 'block' });
  try {
    await ctx.addInitScript(({ bookId, editionId, userId, duration }) => {
      const device = window as Window & {
        __bookClubReceive?: (json: string) => void;
        nativeCommands?: NativeCommand[];
      };
      const nativeCommands: NativeCommand[] = [];
      device.nativeCommands = nativeCommands;
      let adopted = false;
      const sleepUntil = Date.now() + 60_000;
      const send = (message: object) => device.__bookClubReceive?.(JSON.stringify(message));
      const openedAt = 1.5;
      const playback = { rate: 1.5, sleepUntil };
      const status = { type: 'status', currentTime: openedAt, duration, paused: false,
        ended: false, playbackRate: playback.rate, readyState: 2 };
      Object.assign(window, { BookClubNative: { carPlayConnected: true, postMessage(json: string) {
        const cmd = JSON.parse(json);
        nativeCommands.push(cmd);
        if (cmd.type === 'load' && cmd.handoffQueue?.bookId === bookId && cmd.handoffQueue?.editionId === editionId
          && cmd.handoffQueue?.userId === userId && cmd.handoffQueue?.tracks[0]?.url === cmd.url
          && cmd.handoffQueue.tracks[1]?.url !== cmd.url) {
          queueMicrotask(() => {
            adopted = true;
            send({ type: 'advanced', url: cmd.handoffQueue.tracks[1].url, handoff: openedAt, playback });
            send({ ...status, event: 'loadedmetadata' });
            send({ ...status, event: 'play' });
            send({ ...status, event: 'timeupdate' });
          });
        }
        if (cmd.type === 'pause' && adopted) queueMicrotask(() => send({ ...status, event: 'pause', paused: true }));
      } } });
    }, { bookId: book.id, editionId: edition.id, userId: club.owner.id, duration: edition.tracks[1]!.durationMs / 1000 });
    const page = await ctx.newPage();
    const commands = () => page.evaluate(() => (window as Window & { nativeCommands?: NativeCommand[] }).nativeCommands ?? []);
    await page.goto(`/books/${previous.id}/listen`);
    await expect.poll(commands).toContainEqual(expect.objectContaining({ type: 'load' }));
    await page.getByRole('link', { name: `Back to ${previous.title}` }).click();
    await page.locator('a.back-link').click();
    await page.locator(`a[href="/books/${book.id}"]`).first().click();
    await page.getByTestId('open-continue').click();
    const play = page.getByTestId('play-pause');
    await expect(play).toHaveAttribute('data-playing', 'true');
    await expect(page.getByTestId('listen-title')).toContainText('The Middle');
    await expect.poll(commands).toContainEqual(expect.objectContaining({ type: 'positionState', position: 1.5, playbackRate: 1.5 }));
    const sleep = page.getByTestId('sleep');
    await expect(sleep).toHaveValue('on');
    await page.evaluate(({ bookId, editionId, userId }) => {
      const shell = window as Window & { __bookClubReceive?: (json: string) => void };
      shell.__bookClubReceive?.(JSON.stringify({ type: 'selected-rate', bookId, editionId, userId, rate: 1.75, speed: 1.75 }));
    }, { bookId: book.id, editionId: edition.id, userId: club.owner.id });
    await expect(page.getByTestId('speed')).toHaveText('1.75×');
    await page.evaluate((duration) => {
      const shell = window as Window & { __bookClubReceive?: (json: string) => void };
      shell.__bookClubReceive?.(JSON.stringify({
        type: 'status', event: 'timeupdate', sleepUntil: null, currentTime: 1.75, duration,
        paused: false, ended: false, playbackRate: 1.75, readyState: 2,
      }));
    }, edition.tracks[1]!.durationMs / 1000);
    await expect(sleep).toHaveValue('off');
    await expect(play).toHaveAttribute('data-playing', 'true');
    expect((await commands()).filter(({ type }) => type === 'sleep')).toEqual([]);
    expect((await commands()).filter(({ type }) => ['pause', 'seek', 'setRate'].includes(type))).toEqual([{ type: 'pause' }]);
    await play.click();
    await expect(play).toHaveAttribute('data-playing', 'false');
    expect((await commands()).filter(({ type }) => type === 'pause')).toEqual([{ type: 'pause' }, { type: 'pause' }]);
  } finally {
    await ctx.close();
  }
});

test('the reader’s Now Playing uses in-file chapters, speed and sleep, and Cal keeps the saved place during a look', async ({ browser }) => {
  const club = await makeClub([]);
  await allowCal(club.owner);
  const printed = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: 'A Tale in Three Chapters', author: 'Ada Tone' });
  const name = 'tale-in-three-chapters.m4b';
  const book = await uploadBook(club.owner, club.id, 'audio', [{ name, path: path.join(FIXTURES, 'audio/m4b', name), type: 'audio/mp4', role: 'track' }], { title: printed.title, author: printed.author, bookId: printed.id });
  const edition = book.editions.find((item) => item.kind === 'audio')!;
  expect(edition.tracks).toHaveLength(1);
  const saved = { kind: 'audio' as const, track: 0, ms: 1_000 };
  await putProgress(club.owner, book.id, edition.id, saved, []);
  const ctx = await browserAs(browser, club.owner, { serviceWorkers: 'block' });
  let releaseSave!: () => void;
  const holdSave = new Promise<void>((resolve) => { releaseSave = resolve; });

  try {
    const page = await ctx.newPage();
    await page.goto(`/books/${book.id}/read`);
    await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('listen-here').click();
    const dock = page.getByRole('group', { name: /^Now playing:/ });
    await expect(dock.getByTestId('footer-play')).toHaveAttribute('data-playing', 'true');
    await dock.getByTestId('footer-play').click();
    await dock.getByTestId('dock-expand').click();
    const sheet = page.getByRole('dialog', { name: 'Now in this book' });
    const audio = page.getByTestId('audio-element');
    const position = () => audio.evaluate((element: HTMLAudioElement) => element.currentTime);
    await expect.poll(position).toBeLessThan(4);

    const next = sheet.getByRole('button', { name: 'Next chapter' });
    await next.click();
    await expect.poll(position).toBeCloseTo(4);
    await sheet.getByRole('button', { name: 'Previous chapter' }).click();
    await expect.poll(position).toBeCloseTo(0);
    await sheet.getByTestId('sheet-scrubber').fill('1');
    await expect.poll(() => serverPlace(page, book.id)).toEqual(saved);

    await sheet.getByTestId('speed').click();
    const speed = page.getByRole('dialog', { name: 'Playback speed' });
    await speed.getByTestId('speed-preset-1.25').click();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.25);
    await page.keyboard.press('Escape');
    await expect(speed).toHaveCount(0);
    const sleep = sheet.getByRole('combobox', { name: 'Sleep timer' });
    await sleep.selectOption('30');
    await expect(sleep).toHaveValue('on');
    await sleep.selectOption('off');
    await expect(sleep).toHaveValue('off');

    await sheet.getByRole('button', { name: 'Chapters', exact: true }).click();
    const chapterList = sheet.getByRole('region', { name: 'Chapters' });
    await expect(chapterList.getByRole('button')).toHaveCount(3);
    const last = chapterList.getByRole('button', { name: /The End/ });
    const progressUrl = `**/api/books/${book.id}/progress`;
    let unavailable = true;
    await page.route(progressUrl, async (route) => {
      if (route.request().method() === 'PUT') {
        if (unavailable) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
        await holdSave;
      }
      await route.continue();
    });
    await last.click();
    await expect.poll(position).toBeCloseTo(8);
    await expect(last).toHaveAttribute('aria-current', 'true');
    expect(await serverPlace(page, book.id)).toEqual(saved);

    const ask = sheet.getByRole('button', { name: 'Ask Cal', exact: true });
    const cal = page.getByRole('dialog', { name: 'Ask Cal' });
    await ask.click();
    await expect(page.getByText('Could not sync your listening position. Try again.')).toBeVisible();
    await expect(cal).toHaveCount(0);
    unavailable = false;
    await ask.click();
    await expect(ask).toHaveAttribute('aria-disabled', 'true');
    await expect(cal).toHaveCount(0);
    releaseSave();
    await expect(cal).toBeVisible();
    expect(await serverPlace(page, book.id)).toEqual(saved);
    await page.unroute(progressUrl);
    await page.keyboard.press('Escape');
    await sheet.getByRole('button', { name: 'Back to saved place' }).click();
    await expect.poll(position).toBeCloseTo(1);
    await last.click();
    await expect.poll(position).toBeCloseTo(8);
    await sheet.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(sheet.getByTestId('sheet-play')).toHaveAttribute('data-playing', 'true');
    await expect.poll(position).toBeGreaterThanOrEqual(8);
    await expect(sheet.getByRole('button', { name: 'Back to saved place' })).toHaveCount(0);
  } finally {
    releaseSave();
    await ctx.close();
  }
});
