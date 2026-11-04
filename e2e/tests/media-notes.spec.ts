import { type Page, expect, test } from '@playwright/test';
import type { Edition } from '@bookclub/shared';
import { aliceEpub, browserAs, makeClub, png, uploadBook } from '../helpers/api';

/*
 * Media notes (D140-D145): a voice note and a photo note, spoiler-gated like any note; the friend
 * behind sees only a marker (kind, never bytes) until they reach the place, is notified when they
 * do, plays the voice note, and replies with text; the note's author is notified of the reply.
 *
 * A real microphone is not available in CI. Chromium gets a fake audio device
 * (--use-fake-device-for-media-stream, playwright.config.ts); Playwright's WebKit cannot fake one,
 * so there `MediaRecorder` and `getUserMedia` are stubbed in the page before it loads, producing a
 * real, valid (if silent) WAV the server's own content-sniffing and ffmpeg can both read, so the
 * rest of the flow (upload, gating, playback, notifications) is exercised for real either way.
 */

/** A minimal, valid 8-bit PCM WAV of silence: real bytes the server's content-sniff accepts. */
function stubRecorderScript() {
  return () => {
    function makeWavBlob(seconds: number, mimeType: string): Blob {
      const sampleRate = 8000;
      const numSamples = Math.floor(sampleRate * seconds);
      const buffer = new ArrayBuffer(44 + numSamples);
      const view = new DataView(buffer);
      const writeStr = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
      };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + numSamples, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate, true);
      view.setUint16(32, 1, true);
      view.setUint16(34, 8, true);
      writeStr(36, 'data');
      view.setUint32(40, numSamples, true);
      const bytes = new Uint8Array(buffer);
      for (let i = 44; i < bytes.length; i++) bytes[i] = 128;
      return new Blob([bytes], { type: mimeType });
    }
    class FakeMediaRecorder {
      stream: unknown;
      mimeType: string;
      state = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(stream: unknown, opts?: { mimeType?: string }) {
        this.stream = stream;
        this.mimeType = opts?.mimeType ?? 'audio/wav';
      }
      start() {
        this.state = 'recording';
      }
      pause() {
        this.state = 'paused';
      }
      resume() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: makeWavBlob(1, this.mimeType) });
        this.onstop?.();
      }
      static isTypeSupported() {
        return true;
      }
    }
    // @ts-expect-error test stub replacing the browser's own implementation
    window.MediaRecorder = FakeMediaRecorder;
    // Replacing `navigator.mediaDevices` wholesale (not just its `getUserMedia` property):
    // WebKit's own `mediaDevices` does not reliably keep a property assigned onto it, still
    // running its real (permission-checked, device-less) getUserMedia on the next access.
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ stop() {} }] }) as unknown as MediaStream,
      },
    });
  };
}

async function ready(page: Page) {
  await expect(page.getByTestId('page-number')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

test.describe('media notes: voice and photo, spoiler-gated, with notifications and a reply', () => {
  test('Ben sees only markers until he reaches chapter 2, is reached-notified, Ana sees his reply', async ({ browser, browserName }, testInfo) => {
    testInfo.setTimeout(120_000);
    const club = await makeClub(['Ben'], 'Ana');
    const book = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
    const epub = book.editions.find((e: Edition) => e.kind === 'epub')!;

    // Chromium's fake device still goes through a real permission check (--use-fake-ui-for-media-
    // stream dismisses the native prompt, but Playwright's own permission gate is separate and
    // must be granted too); WebKit does not support granting "microphone" at all, but never asks,
    // since its recorder is stubbed below.
    const anaCtx = await browserAs(browser, club.owner, browserName === 'chromium' ? { permissions: ['microphone'] } : {});
    const ana = await anaCtx.newPage();
    // Playwright's Linux WebKit cannot fake a microphone: a stubbed recorder stands in for it,
    // producing real, valid audio bytes the rest of the flow (upload, gating, playback) exercises for real.
    if (browserName === 'webkit') await ana.addInitScript(stubRecorderScript());

    await ana.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(ana);
    await ana.getByTestId('open-toc').click();
    await ana.getByRole('button', { name: /CHAPTER II\./ }).click();
    await expect(ana.getByTestId('reader')).toHaveAttribute('data-section', /\d+/);
    await ready(ana);

    // The voice note.
    await ana.getByTestId('add-note').click();
    await ana.getByTestId('attach-voice').click();
    await ana.getByTestId('voice-record-start').click();
    await expect(ana.getByTestId('voice-elapsed')).toBeVisible();
    await ana.waitForTimeout(600);
    await ana.getByTestId('voice-stop').click();
    await expect(ana.getByTestId('voice-preview-player')).toBeVisible();
    await ana.getByTestId('voice-use').click();
    await expect(ana.getByTestId('media-attachment')).toHaveAttribute('data-status', 'ready', { timeout: 15_000 });
    await ana.getByTestId('note-submit').click();
    await expect(ana.getByTestId('note-text')).toHaveCount(0, { timeout: 15_000 });

    // The photo note.
    await ana.getByTestId('add-note').click();
    await ana.getByTestId('attach-photo').click();
    const photo = png(8, 8, () => [255, 0, 0]);
    await ana.getByTestId('attach-photo-input').setInputFiles({ name: 'spoiler.png', mimeType: 'image/png', buffer: photo });
    await expect(ana.getByTestId('media-attachment')).toHaveAttribute('data-status', 'ready', { timeout: 15_000 });
    await ana.getByTestId('note-submit').click();
    await expect(ana.getByTestId('note-text')).toHaveCount(0, { timeout: 15_000 });

    // Ben, behind, sees two markers: kind only, never bytes.
    const benCtx = await browserAs(browser, club.members.Ben!);
    const ben = await benCtx.newPage();
    await ben.goto(`/books/${book.id}`);
    const markers = ben.getByTestId('note-media-marker');
    await expect(markers).toHaveCount(2);
    await expect(markers.first()).not.toContainText(/\d+:\d+/); // no duration leaks into the marker
    await expect(ben.getByTestId('note').filter({ has: ben.getByTestId('note-voice') })).toHaveCount(0);

    // Ben reaches chapter 2: he turns pages (a tap on the iPhone project, which cannot send a
    // keyboard event meaningfully to a touch viewport; ArrowRight on desktop Chromium) until the
    // server itself says both notes are open to him, not a guessed number of pages.
    await ben.goto(`/books/${book.id}/read?edition=${epub.id}`);
    await ready(ben);
    await ben.getByTestId('open-toc').click();
    await ben.getByRole('button', { name: /CHAPTER II\./ }).click();
    await ready(ben);
    const bothOpen = async () => {
      const comments = (await (await ben.request.get(`/api/books/${book.id}/comments`)).json()) as { hidden: boolean }[];
      return comments.filter((c) => !c.hidden).length >= 2;
    };
    const iphone = testInfo.project.name.includes('iphone');
    for (let i = 0; i < 25 && !(await bothOpen()); i++) {
      if (iphone) {
        const box = (await ben.locator('.epub-viewport').boundingBox())!;
        await ben.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
      } else {
        await ben.keyboard.press('ArrowRight');
      }
      await ben.waitForTimeout(300);
    }
    expect(await bothOpen(), 'both notes should have opened for Ben by the end of the chapter').toBe(true);

    // Ana is notified that Ben reached her notes. The bell lives in the app shell's header, not
    // the reader's own (Contents / Reading settings / Leave a note): back to the book page for it.
    await ana.goto(`/books/${book.id}`);
    await ana.getByTestId('bell').click();
    // Both notes are Ana's, reached by Ben in the same chapter: D145 batches them into one
    // notification ("got to 2 of your notes"), not two.
    await expect(ana.getByTestId('bell-panel')).toContainText(/Ben got to (your note|2 of your notes)/);

    // Ben opens the book page: both notes are now open to him.
    await ben.goto(`/books/${book.id}`);
    await expect(ben.getByTestId('note-voice-player')).toBeVisible({ timeout: 15_000 });
    await expect(ben.locator('.note-photos img')).toBeVisible();
    await ben.getByTestId('note-voice-player').evaluate((el: HTMLAudioElement) => el.play());
    await expect
      .poll(async () => ben.getByTestId('note-voice-player').evaluate((el: HTMLAudioElement) => el.currentTime > 0 || el.ended), { timeout: 10_000 })
      .toBe(true);

    // Ben replies with text to the voice note.
    const voiceNote = ben.getByTestId('note').filter({ has: ben.getByTestId('note-voice') });
    await voiceNote.getByTestId('reply-open').click();
    await voiceNote.getByTestId('reply-text').fill('Got it, that made me laugh');
    // Ben has read on past the note's place while finding it (the page-turning loop above): his
    // reply would otherwise wait for Ana to read as far as he had when he wrote it (D69). He says
    // it is only about this passage, same as the scenario's "Ben replies... Ana is notified and sees
    // it" expects to work at once.
    const aboutHere = voiceNote.getByTestId('reply-send-about-here');
    if (await aboutHere.isVisible()) await aboutHere.click();
    else await voiceNote.getByTestId('reply-send').click();
    await expect(voiceNote.getByTestId('reply')).toContainText('Got it, that made me laugh');

    // Ana is notified of the reply, and sees it.
    await ana.goto(`/books/${book.id}`);
    await ana.getByTestId('bell').click();
    await expect(ana.getByTestId('bell-panel')).toContainText('Ben replied');
    await ana.getByTestId('notification').filter({ hasText: 'Ben replied' }).first().click();
    await expect(ana.getByText('Got it, that made me laugh')).toBeVisible();
  });
});
