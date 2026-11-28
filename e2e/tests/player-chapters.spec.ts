import path from 'node:path';
import { expect, test } from '@playwright/test';
import { allowCal, FIXTURES, aliceEpub, browserAs, clubWithAlice, makeClub, putProgress, serverPlace, uploadBook } from '../helpers/api';

test('opening the playing CarPlay book from another title adopts its newer chapter and live position', async ({ browser }) => {
  type NativeCommand = { type: string; position?: number; playbackRate?: number; at?: number; sleepCommandId?: string };
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
    await sleep.selectOption('track');
    const trackEndCommand = { type: 'sleep', at: null, trackEnd: true, sleepCommandId: expect.any(String) };
    await expect.poll(commands).toContainEqual(trackEndCommand);
    const sleepCommandId = (await commands()).find(({ type }) => type === 'sleep')!.sleepCommandId;
    await page.evaluate(({ duration, sleepCommandId }) => {
      const shell = window as Window & { __bookClubReceive?: (json: string) => void };
      shell.__bookClubReceive?.(JSON.stringify({
        type: 'status', event: 'timeupdate', sleepUntil: Date.now() + 60_000, sleepAtTrackEnd: false, sleepCommandId,
        currentTime: 2, duration, paused: false, ended: false, playbackRate: 1.75, readyState: 2,
      }));
    }, { duration: edition.tracks[1]!.durationMs / 1000, sleepCommandId });
    await expect(sleep).toHaveValue('on');
    expect((await commands()).filter(({ type }) => type === 'sleep')).toEqual([trackEndCommand]);
    expect((await commands()).filter(({ type }) => ['pause', 'seek', 'setRate'].includes(type))).toEqual([{ type: 'pause' }]);
    await play.click();
    await expect(play).toHaveAttribute('data-playing', 'false');
    expect((await commands()).filter(({ type }) => type === 'pause')).toEqual([{ type: 'pause' }, { type: 'pause' }]);

    // On disconnect, native hands an open page its source and loaded metadata.
    await expect.poll(() => serverPlace(page, book.id)).toMatchObject({ kind: 'audio', track: 1 });
    const sourceChanges = (await commands()).filter(({ type }) => type === 'load' || type === 'seek');
    await page.evaluate(({ url, durationMs }) => {
      const shell = window as Window & { __bookClubReceive?: (json: string) => void };
      const send = (message: object) => shell.__bookClubReceive?.(JSON.stringify(message));
      send({ type: 'advanced', url, handoffOnMetadata: true });
      send({ type: 'status', event: 'loadedmetadata', currentTime: 1.25, duration: durationMs / 1000,
        paused: false, ended: false, playbackRate: 1.75, readyState: 2, at: Date.now() });
    }, edition.tracks[0]!);
    await expect(page.getByTestId('listen-title')).toContainText('The Beginning');
    await page.evaluate((durationMs) => {
      const shell = window as Window & { __bookClubReceive?: (json: string) => void };
      shell.__bookClubReceive?.(JSON.stringify({ type: 'status', event: 'pause', currentTime: 1.25,
        duration: durationMs / 1000, paused: true, ended: false, playbackRate: 1.75, readyState: 2, at: Date.now() }));
    }, edition.tracks[0]!.durationMs);
    await expect(play).toHaveAttribute('data-playing', 'false');
    await expect.poll(() => serverPlace(page, book.id)).toEqual({ kind: 'audio', track: 0, ms: 1_250 });
    expect((await commands()).filter(({ type }) => type === 'load' || type === 'seek')).toEqual(sourceChanges);
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

for (const surface of ['full player', 'reader sheet'] as const) {
  test(`the ${surface} chapter list opens at the chapter in use`, async ({ browser }) => {
    const { club, book } = await clubWithAlice([], { audio: 'tiny' });
    const edition = book.editions.find((item) => item.kind === 'audio')!;
    const track = 10;
    expect(edition.tracks.length).toBeGreaterThan(track);
    await putProgress(club.owner, book.id, edition.id, { kind: 'audio', track, ms: 100 }, []);
    const ctx = await browserAs(browser, club.owner, { audioOnlyView: true, serviceWorkers: 'block' });
    let releaseProgress!: () => void;
    const holdProgress = new Promise<void>((resolve) => { releaseProgress = resolve; });
    try {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 393, height: 659 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      if (surface === 'full player') {
        await page.route(`**/api/books/${book.id}/progress`, async (route) => {
          if (route.request().method() === 'GET') await holdProgress;
          await route.continue();
        });
      }
      let show = page.getByRole('button', { name: 'Track list' });
      await page.goto(`/books/${book.id}/listen?edition=${edition.id}`);
      if (surface === 'full player') {
        await expect(show).toBeDisabled();
        await expect(page.getByTestId('player-up-next')).toHaveCount(0);
        releaseProgress();
      }
      await expect(page.getByTestId('listen-page')).toHaveAttribute('data-track', String(track));
      if (surface === 'full player') await expect(page.getByTestId('player-up-next')).toBeVisible();
      let list = page.getByRole('region', { name: 'Tracks' });
      if (surface === 'reader sheet') {
        await page.getByTestId('show-text').click();
        await page.getByTestId('dock-expand').click();
        const sheet = page.getByRole('dialog', { name: 'Now in this book' });
        list = sheet.getByRole('region', { name: 'Chapters', exact: true });
        show = sheet.getByRole('button', { name: 'Chapters', exact: true });
      }
      await show.press('Enter');
      const current = list.locator('button[aria-current="true"]');
      await expect(current).toHaveCount(1);
      await expect(current).toBeInViewport({ ratio: 0.9, timeout: 2_000 });
      await expect(current).toBeFocused();
      if (surface === 'full player') {
        const launcher = page.locator('button.cal-launcher');
        await expect(launcher).toBeVisible();
        const [chapterBounds, calBounds] = await Promise.all([current.boundingBox(), launcher.boundingBox()]);
        expect(chapterBounds!.y + chapterBounds!.height).toBeLessThan(calBounds!.y);
      }
      const audio = page.getByTestId('audio-element');
      await expect(audio).toHaveAttribute('src', /\/tracks\/10$/);
      await expect(audio).toHaveJSProperty('paused', true);
      expect(await serverPlace(page, book.id)).toMatchObject({ kind: 'audio', track });
    } finally {
      releaseProgress();
      await ctx.close();
      await club.owner.api.dispose();
    }
  });
}

for (const view of ['full player', 'Now Playing'] as const) {
  test(`${view} shows the next in-file chapter before going there`, async ({ browser }) => {
    const club = await makeClub([]);
    const printed = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: 'A Tale in Three Chapters', author: 'Ada Tone' });
    const name = 'tale-in-three-chapters.m4b';
    const book = await uploadBook(club.owner, club.id, 'audio', [{
      name, path: path.join(FIXTURES, 'audio/m4b', name), type: 'audio/mp4', role: 'track',
    }], { title: printed.title, author: printed.author, bookId: printed.id });
    const edition = book.editions.find((item) => item.kind === 'audio')!;
    expect(edition.tracks).toHaveLength(1);
    const ctx = await browserAs(browser, club.owner, { audioOnlyView: view === 'full player', serviceWorkers: 'block' });

    try {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 393, height: 659 });
      if (view === 'full player') {
        await page.goto(`/books/${book.id}/listen?edition=${edition.id}`);
      } else {
        await page.goto(`/books/${book.id}/read`);
        await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true');
        await page.getByTestId('listen-here').click();
        const dock = page.getByRole('group', { name: /^Now playing:/ });
        const play = dock.getByTestId('footer-play');
        await expect(play).toHaveAttribute('data-playing', 'true');
        await play.click();
        await dock.getByTestId('dock-expand').click();
      }

      const player = view === 'full player' ? page.getByTestId('listen-page') : page.getByRole('dialog', { name: 'Now in this book' });
      const next = player.getByRole('button', { name: 'Next chapter', exact: true });
      const upcoming = player.getByTestId('player-up-next');
      const audio = page.getByTestId('audio-element');
      const position = () => audio.evaluate((element: HTMLAudioElement) => element.currentTime);
      await expect(next).toBeEnabled();
      await expect.poll(position).toBeLessThan(4);
      for (const [title, seconds] of [['Chapter Two: The Middle', 4], ['Chapter Three: The End', 8]] as const) {
        await expect(upcoming).toHaveText(`Up next ${title}`, { timeout: 2_000 });
        await expect(upcoming).toBeInViewport();
        await expect(next).toHaveAccessibleDescription(title);
        if (seconds === 4) await next.press('Enter');
        else await next.click();
        await expect.poll(position).toBeCloseTo(seconds);
      }
      await expect(upcoming).toHaveCount(0);
      await expect(next).toBeDisabled();
      expect(await audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    } finally {
      await ctx.close();
      await club.owner.api.dispose();
    }
  });
}
