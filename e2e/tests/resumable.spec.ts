import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { type Request, expect, test } from '@playwright/test';
import { SYNTHETIC_DIR, browserAs, makeClub } from '../helpers/api';

const GIB = 1024 ** 3;
const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.tmp');

/**
 * A 1 GiB MP3: one real CBR MP3 file repeated (frames are self-contained, so it is valid audio
 * from the server's point of view). Generated per run, deleted afterwards.
 */
function makeBigTrack(name: string, bytes = GIB): string {
  mkdirSync(path.dirname(path.join(DIR, name)), { recursive: true });
  const file = path.join(DIR, name);
  const unit = readFileSync(path.join(SYNTHETIC_DIR, '02 - The Middle.mp3'));
  const repeats = Math.ceil(bytes / unit.byteLength);
  const fd = openSync(file, 'w');
  const block = Buffer.concat(Array.from({ length: 256 }, () => unit));
  for (let written = 0; written < repeats; written += 256) writeSync(fd, written + 256 <= repeats ? block : Buffer.concat(Array.from({ length: repeats - written }, () => unit)));
  closeSync(fd);
  return file;
}

test.describe('a 1 GB audiobook upload on bad Wi-Fi', () => {
  test.describe.configure({ timeout: 10 * 60_000 });
  let big: string;

  test.beforeAll(() => {
    big = makeBigTrack(`big-${test.info().project.name}-${process.pid}.mp3`);
    expect(statSync(big).size).toBeGreaterThanOrEqual(GIB);
  });
  test.afterAll(() => {
    rmSync(big, { force: true });
  });

  test('is cut off midway and then finishes without starting over', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    const patches: { offset: number; t: number }[] = [];
    page.on('request', (req: Request) => {
      if (req.method() === 'PATCH' && req.url().includes('/api/uploads/')) patches.push({ offset: Number(req.headers()['upload-offset']), t: Date.now() });
    });
    await page.goto(`/clubs/${club.id}`);
    await page.getByRole('button', { name: 'Add a book' }).click();
    await page.getByTestId('file-input').setInputFiles(big);
    await expect(page.getByTestId('upload-title')).toBeVisible();
    await page.getByTestId('upload-title').fill('The Very Long Tale');
    await page.getByTestId('upload-start').click();
    const progress = page.getByTestId('upload-progress');
    await expect.poll(async () => Number(await progress.getAttribute('data-sent')), { timeout: 5 * 60_000, intervals: [250] }).toBeGreaterThan(0.3 * GIB);

    // The connection drops in the middle of the upload…
    await ctx.setOffline(true);
    const cutAt = Date.now();
    await expect(page.getByText(/waiting for the connection/)).toBeVisible({ timeout: 30_000 });
    const sentAtCut = Number(await progress.getAttribute('data-sent'));
    await page.waitForTimeout(3000);
    // …and comes back.
    await ctx.setOffline(false);
    await expect(page).toHaveURL(/\/books\//, { timeout: 6 * 60_000 });

    const after = patches.filter((p) => p.t > cutAt);
    expect(after.length).toBeGreaterThan(0);
    // The first request after the cut continued from where the server had got to, not from zero.
    expect(after[0]!.offset).toBeGreaterThan(0.25 * GIB);
    expect(after.every((p) => p.offset > 0)).toBe(true);
    expect(after[0]!.offset).toBeLessThanOrEqual(sentAtCut + 16 * 1024 * 1024);
    const bookId = page.url().split('/books/')[1]!;
    const detail = (await (await page.request.get(`/api/books/${bookId}`)).json()) as { editions: { sizeBytes: number }[] };
    expect(detail.editions[0]!.sizeBytes).toBe(statSync(big).size);
    await page.request.delete(`/api/books/${bookId}`);
    await ctx.close();
  });

  test('a folder interrupted by a reload sends only what the server lacks: finished tracks are not sent again', async ({ browser }) => {
    const folder = `folder-${test.info().project.name}-${process.pid}`;
    // Three short tracks finish first; three long ones are still going when the page reloads.
    const sizes = [4, 4, 4, 90, 90, 90].map((mb) => mb * 1024 * 1024);
    const tracks = sizes.map((size, i) => makeBigTrack(path.join(folder, `${String(i + 1).padStart(2, '0')} - Part ${i + 1}.mp3`), size));
    try {
      const club = await makeClub([]);
      const ctx = await browserAs(browser, club.owner);
      const page = await ctx.newPage();
      await page.goto(`/clubs/${club.id}`);
      await page.getByRole('button', { name: 'Add a book' }).click();
      await page.getByTestId('file-input').setInputFiles(tracks);
      await page.getByTestId('upload-title').fill('A Tale in Six Parts');
      await page.getByTestId('upload-start').click();
      const pendingKey = `bookclub:pending-import:${club.id}`;
      await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), pendingKey)).not.toBeNull();
      const importId = await page.evaluate((key) => (JSON.parse(localStorage.getItem(key)!) as { importId: string }).importId, pendingKey);
      type Files = { files: { index: number; complete: boolean; offset: number; uploadId: string | null }[] };
      const state = () => page.request.get(`/api/imports/${importId}`).then(async (r) => (await r.json()) as Files);
      // The reload comes once the short tracks are in and the long ones are under way on the
      // server (begun, not finished). Reloading while the long ones were still being created
      // would lose their creation (nothing of them sent yet), and they would rightly be created
      // again: that is not the case this test is about.
      const underWay = (f: Files['files'][number]) => !f.complete && f.uploadId !== null && f.offset > 0;
      await expect
        .poll(
          async () => {
            const files = (await state()).files;
            return files.filter((f) => f.complete).length >= 3 && files.filter(underWay).length === 3;
          },
          { timeout: 120_000, intervals: [100] },
        )
        .toBe(true);
      await page.reload();
      const before = await state();
      const finished = before.files.filter((f) => f.complete).map((f) => f.index);
      expect(finished).toEqual(expect.arrayContaining([0, 1, 2]));
      expect(before.files.some((f) => !f.complete)).toBe(true);

      const created: string[] = [];
      const firstOffsets = new Map<string, number>();
      page.on('request', (req) => {
        if (!req.url().includes('/api/uploads')) return;
        if (req.method() === 'POST') created.push(req.headers()['upload-metadata'] ?? '');
        if (req.method() === 'PATCH' && !firstOffsets.has(req.url())) firstOffsets.set(req.url(), Number(req.headers()['upload-offset']));
      });
      await page.getByRole('button', { name: 'Add a book' }).click();
      await expect(page.getByTestId('resume-notice')).toBeVisible();
      await page.getByTestId('file-input').setInputFiles(tracks);
      await page.getByTestId('upload-title').fill('A Tale in Six Parts');
      await page.getByTestId('upload-start').click();
      await expect(page).toHaveURL(/\/books\//, { timeout: 6 * 60_000 });
      // Nothing started over: no file was created again, and every unfinished one went on from
      // where the server had got to.
      expect(created).toEqual([]);
      expect(firstOffsets.size).toBeGreaterThan(0);
      for (const [url, offset] of firstOffsets) {
        const file = before.files.find((f) => f.uploadId !== null && url.endsWith(f.uploadId));
        expect(file, `PATCH ${url} belongs to a file of this import`).toBeDefined();
        expect(finished).not.toContain(file!.index);
        expect(offset).toBeGreaterThan(0);
      }
      const bookId = page.url().split('/books/')[1]!;
      const detail = (await (await page.request.get(`/api/books/${bookId}`)).json()) as { editions: { sizeBytes: number; tracks: unknown[] }[] };
      expect(detail.editions[0]!.tracks).toHaveLength(6);
      expect(detail.editions[0]!.sizeBytes).toBe(tracks.reduce((sum, f) => sum + statSync(f).size, 0));
      await page.request.delete(`/api/books/${bookId}`);
      await ctx.close();
    } finally {
      rmSync(path.join(DIR, folder), { recursive: true, force: true });
    }
  });

  test('a reload in the middle resumes when the same file is chosen again', async ({ browser }) => {
    const club = await makeClub([]);
    const ctx = await browserAs(browser, club.owner);
    const page = await ctx.newPage();
    await page.goto(`/clubs/${club.id}`);
    await page.getByRole('button', { name: 'Add a book' }).click();
    await page.getByTestId('file-input').setInputFiles(big);
    await page.getByTestId('upload-title').fill('The Very Long Tale');
    await page.getByTestId('upload-start').click();
    const progress = page.getByTestId('upload-progress');
    await expect.poll(async () => Number(await progress.getAttribute('data-sent')), { timeout: 5 * 60_000, intervals: [250] }).toBeGreaterThan(0.25 * GIB);
    await page.reload();

    const patches: number[] = [];
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && req.url().includes('/api/uploads/')) patches.push(Number(req.headers()['upload-offset']));
    });
    await page.getByRole('button', { name: 'Add a book' }).click();
    await expect(page.getByTestId('resume-notice')).toBeVisible();
    await page.getByTestId('file-input').setInputFiles(big);
    await page.getByTestId('upload-title').fill('The Very Long Tale');
    await page.getByTestId('upload-start').click();
    await expect(page).toHaveURL(/\/books\//, { timeout: 6 * 60_000 });
    expect(patches[0]).toBeGreaterThan(0.2 * GIB);
    const bookId = page.url().split('/books/')[1]!;
    await page.request.delete(`/api/books/${bookId}`);
    await ctx.close();
  });
});

test.describe('an upload paused for the connection (fidelity review round 16)', () => {
  test.describe.configure({ timeout: 6 * 60_000 });

  test('goes on as soon as the connection is back, without waiting out its back-off, and finishes without starting over', async ({ browser }) => {
    const track = makeBigTrack(`back-${test.info().project.name}-${process.pid}.mp3`, 400 * 1024 * 1024);
    try {
      const club = await makeClub([]);
      const ctx = await browserAs(browser, club.owner);
      const page = await ctx.newPage();
      const requests: { method: string; offset: number; t: number }[] = [];
      page.on('request', (req: Request) => {
        if (new URL(req.url()).pathname.startsWith('/api/uploads')) requests.push({ method: req.method(), offset: Number(req.headers()['upload-offset'] ?? -1), t: Date.now() });
      });
      await page.goto(`/clubs/${club.id}`);
      await page.getByRole('button', { name: 'Add a book' }).click();
      await page.getByTestId('file-input').setInputFiles(track);
      await page.getByTestId('upload-title').fill('The Patient Tale');
      await page.getByTestId('upload-start').click();
      const progress = page.getByTestId('upload-progress');
      await expect.poll(async () => Number(await progress.getAttribute('data-sent')), { timeout: 2 * 60_000, intervals: [50] }).toBeGreaterThan(24 * 1024 * 1024);

      // The connection drops, and stays down long enough for the tries to be 15 s apart…
      await ctx.setOffline(true);
      const cutAt = Date.now();
      const paused = page.getByText(/Paused at \d+%: waiting for the connection/);
      await expect(paused).toBeVisible({ timeout: 30_000 });
      const sentAtCut = Number(await progress.getAttribute('data-sent'));
      await page.waitForTimeout(Math.max(0, cutAt + 16_000 - Date.now()));
      // …and comes back: the upload asks the server where it got to at once, not up to 15 s later.
      await ctx.setOffline(false);
      const backAt = Date.now();
      await expect.poll(() => requests.filter((r) => r.t >= backAt).length, { timeout: 3000, intervals: [50] }).toBeGreaterThan(0);
      await expect(paused).toHaveCount(0, { timeout: 5000 });
      await expect(page).toHaveURL(/\/books\//, { timeout: 4 * 60_000 });

      // Nothing started over: no file was created again, and it went on from where the server had got to.
      const after = requests.filter((r) => r.t >= cutAt);
      expect(after.filter((r) => r.method === 'POST')).toEqual([]);
      const patches = after.filter((r) => r.method === 'PATCH' && r.t >= backAt);
      expect(patches.length).toBeGreaterThan(0);
      expect(patches[0]!.offset).toBeGreaterThan(0);
      expect(patches[0]!.offset).toBeLessThanOrEqual(sentAtCut + 16 * 1024 * 1024);
      const bookId = page.url().split('/books/')[1]!;
      const detail = (await (await page.request.get(`/api/books/${bookId}`)).json()) as { editions: { sizeBytes: number }[] };
      expect(detail.editions[0]!.sizeBytes).toBe(statSync(track).size);
      await page.request.delete(`/api/books/${bookId}`);
      await ctx.close();
    } finally {
      rmSync(track, { force: true });
    }
  });
});
