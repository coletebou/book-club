import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { type APIRequestContext, type Browser, type BrowserContext, type Page, expect, request } from '@playwright/test';
import type { BookDetail, ClubDetail, CommentView, Import, Locator } from '@bookclub/shared';

export const BASE = process.env.BOOKCLUB_URL ?? 'http://127.0.0.1:47100';
export const ADMIN_EMAIL = process.env.BOOKCLUB_ADMIN_EMAIL ?? 'cole@demo.bookclub';
export const ADMIN_PASSWORD = process.env.BOOKCLUB_ADMIN_PASSWORD ?? 'wonderland-demo';
export const PASSWORD = 'e2e-correct-horse';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(ROOT, 'fixtures');
export const ALICE_EPUB = path.join(FIXTURES, 'books/alice-gutenberg-11.epub');
export const ALICE_PDF = path.join(FIXTURES, 'books/alice.pdf');
export const SYNTHETIC_DIR = path.join(FIXTURES, 'audio/synthetic');
export const ALICE_TINY_DIR = path.join(FIXTURES, 'audio/alice-tiny');
export const LIBRIVOX_DIR = process.env.LIBRIVOX_DIR ?? path.join(ROOT, '.cache/downloads/librivox-alice');

let counter = 0;
export function unique(prefix: string): string {
  counter++;
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${counter}`;
}

/** A person: their own cookie jar for API calls, and the storage state to open a browser as them. */
export interface Person {
  readonly name: string;
  readonly email: string;
  readonly id: string;
  readonly api: APIRequestContext;
}

async function expectOk(res: Awaited<ReturnType<APIRequestContext['get']>>, what: string): Promise<void> {
  if (!res.ok()) throw new Error(`${what} failed: ${res.status()} ${await res.text()}`);
}

export async function apiAs(email: string, password: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
  await expectOk(await ctx.post('/api/auth/signin', { data: { email, password } }), `sign in ${email}`);
  return ctx;
}

export async function signUp(invite: string, name: string): Promise<Person> {
  // A display name may hold spaces or accents ("Ben Carter"); the address made from it may not.
  const email = `${unique(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}@e2e.test`;
  const api = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
  const res = await api.post('/api/auth/signup', { data: { inviteCode: invite, displayName: name, email, password: PASSWORD } });
  await expectOk(res, `sign up ${name}`);
  const body = (await res.json()) as { user: { id: string } };
  return { name, email, id: body.user.id, api };
}

export interface TestClub {
  readonly id: string;
  readonly name: string;
  readonly invite: string;
  readonly inviteUrl: string;
  readonly owner: Person;
  readonly members: Record<string, Person>;
}

/**
 * A fresh club for one test, owned by a fresh person, with fresh members. Built through the real
 * API: the demo owner creates it, invites everyone, hands ownership to the test owner and leaves.
 */
export async function makeClub(memberNames: readonly string[] = [], ownerName = 'Olive'): Promise<TestClub> {
  const admin = await apiAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const name = unique('Club');
  const created = await admin.post('/api/clubs', { data: { name } });
  await expectOk(created, 'create club');
  const club = (await created.json()) as ClubDetail;
  const invite = club.invite!.code;
  const owner = await signUp(invite, ownerName);
  await expectOk(await admin.put(`/api/clubs/${club.id}/members/${owner.id}/role`, { data: { role: 'owner' } }), 'make owner');
  const adminId = ((await (await admin.get('/api/session')).json()) as { user: { id: string } }).user.id;
  await expectOk(await admin.delete(`/api/clubs/${club.id}/members/${adminId}`), 'admin leaves');
  await admin.dispose();
  const members: Record<string, Person> = {};
  for (const m of memberNames) members[m] = await signUp(invite, m);
  const detail = (await (await owner.api.get(`/api/clubs/${club.id}`)).json()) as ClubDetail;
  return { id: club.id, name, invite: detail.invite!.code, inviteUrl: detail.invite!.url, owner, members };
}

/** Someone with an account who is not in the given club (they are in a club of their own). */
export async function makeOutsider(name = 'Ozzy'): Promise<Person> {
  const other = await makeClub([], name);
  return other.owner;
}

/** Open a browser context signed in as a person (session cookie copied from their API jar). */
export async function browserAs(browser: Browser, person: Person, options: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
  const state = await person.api.storageState();
  return browser.newContext({ ...options, storageState: state });
}

export interface LocalFile {
  readonly name: string;
  readonly path: string;
  readonly type: string;
  readonly role: 'main' | 'track' | 'cover';
}

export function audioFolder(dir: string): LocalFile[] {
  const files: LocalFile[] = [];
  for (const name of readdir(dir)) {
    if (/\.mp3$/i.test(name)) files.push({ name, path: path.join(dir, name), type: 'audio/mpeg', role: 'track' });
  }
  return files;
}

function readdir(dir: string): string[] {
  return readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

/** Upload files through the real import + tus API and finalise; waits until the edition is ready. */
export async function uploadBook(
  person: Person,
  clubId: string,
  kind: 'epub' | 'pdf' | 'audio',
  files: readonly LocalFile[],
  finalize: { title: string; author: string; bookId?: string; trackTitles?: readonly string[] },
): Promise<BookDetail> {
  const api = person.api;
  const created = await api.post(`/api/clubs/${clubId}/imports`, {
    data: { kind, files: files.map((f) => ({ name: f.name, size: statSync(f.path).size, type: f.type, role: f.role })) },
  });
  await expectOk(created, 'create import');
  const imp = (await created.json()) as Import;
  for (const [i, f] of files.entries()) {
    const bytes = readFileSync(f.path);
    const res = await api.post('/api/uploads', {
      headers: {
        'tus-resumable': '1.0.0',
        'upload-length': String(bytes.byteLength),
        'upload-metadata': `importId ${b64(imp.id)},fileIndex ${b64(String(i))},filename ${b64(f.name)},filetype ${b64(f.type)}`,
      },
    });
    await expectOk(res, `tus create ${f.name}`);
    const location = res.headers()['location']!;
    const patch = await api.patch(location, {
      headers: { 'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' },
      data: bytes,
    });
    await expectOk(patch, `tus patch ${f.name}`);
  }
  const fin = await api.post(`/api/imports/${imp.id}/finalize`, { data: finalize });
  await expectOk(fin, 'finalize');
  const { bookId, editionId } = (await fin.json()) as { bookId: string; editionId: string };
  for (let i = 0; i < 120; i++) {
    const book = (await (await api.get(`/api/books/${bookId}`)).json()) as BookDetail;
    const ed = book.editions.find((e) => e.id === editionId);
    if (ed?.status === 'ready') return book;
    if (ed?.status === 'failed') throw new Error(`ingest failed: ${ed.error}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('edition did not become ready');
}

export const aliceEpub = (): LocalFile => ({ name: 'alice-gutenberg-11.epub', path: ALICE_EPUB, type: 'application/epub+zip', role: 'main' });
export const alicePdf = (): LocalFile => ({ name: 'alice.pdf', path: ALICE_PDF, type: 'application/pdf', role: 'main' });

/** A club reading Alice as an EPUB (optionally also the tiny LibriVox-shaped audiobook). */
export async function clubWithAlice(memberNames: readonly string[], options: { audio?: 'tiny' | 'librivox'; pdf?: boolean } = {}) {
  const club = await makeClub(memberNames);
  let book = await uploadBook(club.owner, club.id, 'epub', [aliceEpub()], { title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' });
  if (options.pdf) {
    book = await uploadBook(club.owner, club.id, 'pdf', [alicePdf()], { title: book.title, author: book.author, bookId: book.id });
    book = await printLinedUp(club.owner, book, book.editions.find((e) => e.kind === 'pdf')!.id);
  }
  if (options.audio) {
    const dir = options.audio === 'librivox' ? LIBRIVOX_DIR : ALICE_TINY_DIR;
    book = await uploadBook(club.owner, club.id, 'audio', audioFolder(dir), { title: book.title, author: book.author, bookId: book.id });
  }
  return { club, book };
}

/**
 * Wait until a PDF is lined up with the book's text, line by line (D75): it is ready to read once
 * read, and its map (or the text's, when the timeline rests on the PDF) is refined a moment later,
 * in the same job. A test that works out places from the maps works them out from those.
 */
export async function printLinedUp(person: Person, book: BookDetail, pdfEditionId: string): Promise<BookDetail> {
  const refined = (detail: BookDetail) => detail.editions.find((e) => (detail.referenceEditionId === pdfEditionId ? e.kind === 'epub' : e.id === pdfEditionId));
  for (let i = 0; i < 120; i++) {
    const detail = (await (await person.api.get(`/api/books/${book.id}`)).json()) as BookDetail;
    if (refined(detail)?.alignment.method === 'forced') return detail;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the PDF was not lined up with the text');
}

/** What a recogniser heard in the LibriVox Alice (tools/align/transcribe.py), as the demo ships it. */
export const LIBRIVOX_TRANSCRIPT = path.join(ROOT, 'fixtures/align/librivox-alice.transcript.json');

/** Give an audiobook its transcript and wait until the book is lined up sentence by sentence. */
export async function readAlong(person: Person, book: BookDetail, audioEditionId: string): Promise<BookDetail> {
  const data = JSON.parse(readFileSync(LIBRIVOX_TRANSCRIPT, 'utf8')) as unknown;
  let res = await person.api.put(`/api/editions/${audioEditionId}/transcript`, { data });
  // The server reads two transcripts at once and says it is busy to a third, which tries again
  // shortly, as any client of it should (other tests' clubs upload theirs at the same time).
  for (let i = 0; res.status() === 503 && i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    res = await person.api.put(`/api/editions/${audioEditionId}/transcript`, { data });
  }
  await expectOk(res, 'transcript');
  for (let i = 0; i < 120; i++) {
    const detail = (await (await person.api.get(`/api/books/${book.id}`)).json()) as BookDetail;
    if (detail.editions.find((e) => e.id === audioEditionId)?.readAlong) return detail;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the book was not lined up');
}

export async function postComment(person: Person, bookId: string, body: { editionId: string; locator: Locator; text?: string; reaction?: string; quote?: string }): Promise<CommentView> {
  const res = await person.api.post(`/api/books/${bookId}/comments`, { data: body });
  await expectOk(res, 'comment');
  return (await res.json()) as CommentView;
}

export async function putProgress(person: Person, bookId: string, editionId: string, locator: Locator, spans: { from: Locator; to: Locator }[]): Promise<void> {
  const res = await person.api.put(`/api/books/${bookId}/progress`, { data: { editionId, locator, readSpans: spans, at: Date.now() } });
  await expectOk(res, 'progress');
}

/** "I've read up to here": marks `[0, locator]` of `editionId` as read (Cal's spoiler tests, cal.spec.ts). */
export async function readUpTo(person: Person, bookId: string, editionId: string, locator: Locator): Promise<void> {
  const res = await person.api.post(`/api/books/${bookId}/progress/read-up-to`, { data: { editionId, locator } });
  await expectOk(res, 'read-up-to');
}

/** The reader's visible book frame. */
export function bookFrame(page: Page) {
  return page.frameLocator('iframe.epub-frame');
}

/** This person's saved place in a book, as the server has it (what a reload or another device opens at). */
export async function serverPlace(page: Page, bookId: string): Promise<Locator | null> {
  const res = await page.request.get(`/api/books/${bookId}/progress`);
  const body = (await res.json()) as { mine: { locator: Locator | null } | null };
  return body.mine?.locator ?? null;
}

/** Wait until the server holds the place the EPUB reader shows now (instead of a fixed pause). */
export async function placeSaved(page: Page, bookId: string): Promise<void> {
  const reader = page.getByTestId('reader');
  await expect
    .poll(async () => {
      // The page on screen now (a late relayout may have moved it) against the server's copy.
      const section = Number(await reader.getAttribute('data-section'));
      const offset = Number(await reader.getAttribute('data-start'));
      const l = await serverPlace(page, bookId);
      return l?.kind === 'epub' && l.section === section && l.offset === offset;
    }, { timeout: 20_000 })
    .toBe(true);
}


/**
 * A card over the reader's footer: it, and every button on it, lies inside the footer (never over
 * the page's text) and inside the screen (nothing to tap is cut off at the bottom edge). On a
 * computer it leaves the page arrows free to click.
 */
export async function expectInFooter(page: Page, card: ReturnType<Page['getByTestId']>): Promise<void> {
  const viewport = page.viewportSize()!;
  const footer = (await page.locator('.reader-footer').boundingBox())!;
  const boxes = [(await card.boundingBox())!, ...(await Promise.all((await card.getByRole('button').all()).map(async (b) => (await b.boundingBox())!)))];
  for (const box of boxes) {
    expect(box.y).toBeGreaterThanOrEqual(footer.y - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(footer.y + footer.height + 1);
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  }
  if (viewport.width >= 600) {
    for (const arrow of await page.locator('.reader-footer .page-btn:enabled').all()) await arrow.click({ trial: true, timeout: 2000 });
  }
}

/* Files made for one test ---------------------------------------------------------------------- */

/** A file made for one test, written to a folder of its own (uploadBook reads files from disk). */
export function madeFile(name: string, bytes: Uint8Array, type: string, role: LocalFile['role'] = 'main'): LocalFile {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'bookclub-e2e-')), name);
  writeFileSync(file, bytes);
  return { name, path: file, type, role };
}

/** A ZIP archive of stored (uncompressed) entries, in order: enough for an EPUB made in a test. */
export function storedZip(entries: Record<string, string | Uint8Array>): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(nameBytes.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data);
    directory.push(central, nameBytes);
    offset += local.byteLength + nameBytes.byteLength + data.byteLength;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(dir.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** A PNG picture `width`×`height`, each row painted one colour (`rowColor(y)`, RGB). */
export function png(width: number, height: number, rowColor: (y: number) => readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.byteLength, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (1 + 3 * width));
  for (let y = 0; y < height; y++) {
    const [r, g, b] = rowColor(y);
    const at = y * (1 + 3 * width);
    for (let x = 0; x < width; x++) rows.set([r, g, b], at + 1 + 3 * x);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** Sentences of made-up prose, the same for the same seed: none of a real book's words. */
export function prose(sentences: number, seed: number): string {
  const words = 'the lamp was low and the street outside lay quiet under rain while she read on past midnight turning each page slowly as friends far away read the same lines'.split(' ');
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: sentences }, () => {
    const n = 8 + Math.floor(next() * 14);
    const said = Array.from({ length: n }, () => words[Math.floor(next() * words.length)]!).join(' ');
    return `${said[0]!.toUpperCase()}${said.slice(1)}.`;
  }).join(' ');
}

/**
 * An EPUB 3 made as Standard Ebooks make theirs (FR150): a title page and an imprint typed as front
 * matter, the chapters as body matter, then a colophon and its licence ("Uncopyright") as back
 * matter, with landmarks; and a cover, if given. Its words are made up.
 */
export function standardEbook(options: { title?: string; chapters?: readonly string[]; cover?: Uint8Array } = {}): Buffer {
  const title = options.title ?? 'The Strange Case';
  const chapters = options.chapters ?? ['Story of the Door', 'Search for Mr. Hyde', 'Henry Jekyll’s Full Statement of the Case'];
  const doc = (heading: string, bodyType: string, section: string) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en-GB"><head><title>${heading}</title></head><body epub:type="${bodyType}">\n\t\t${section}\n\t</body></html>`;
  const parts: [string, string, string][] = [
    ['titlepage', 'Titlepage', doc('Titlepage', 'frontmatter', `<section id="titlepage" epub:type="titlepage"><h1 epub:type="title">${title}</h1><p>By An Author.</p></section>`)],
    ['imprint', 'Imprint', doc('Imprint', 'frontmatter', `<section id="imprint" epub:type="imprint"><h2 epub:type="title">Imprint</h2><p>This ebook is the product of many hours of hard work by volunteers. ${prose(4, 1)}</p></section>`)],
    ...chapters.map((name, i): [string, string, string] => [
      `chapter-${i + 1}`,
      name,
      doc(name, 'bodymatter z3998:fiction', `<section id="chapter-${i + 1}" role="doc-chapter" epub:type="chapter"><h2 epub:type="title">${name}</h2>${[0, 1, 2, 3].map((p) => `<p>${prose(9, 100 * i + p)}</p>`).join('')}</section>`),
    ]),
    ['colophon', 'Colophon', doc('Colophon', 'backmatter', `<section id="colophon" role="doc-colophon" epub:type="colophon"><h2 epub:type="title">Colophon</h2><p>This ebook was produced for Standard Ebooks. ${prose(6, 7)}</p></section>`)],
    ['uncopyright', 'Uncopyright', doc('Uncopyright', 'backmatter', `<section id="uncopyright" epub:type="copyright-page"><h2 epub:type="title">Uncopyright</h2><p>May you do good and not evil. ${prose(8, 9)}</p></section>`)],
  ];
  const files: Record<string, string | Uint8Array> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml':
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="epub/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  };
  for (const [id, , body] of parts) files[`epub/text/${id}.xhtml`] = body;
  if (options.cover) files['epub/images/cover.png'] = options.cover;
  files['epub/toc.xhtml'] =
    '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Table of Contents</title></head><body epub:type="frontmatter">' +
    `<nav id="toc" epub:type="toc"><h2>Table of Contents</h2><ol>${parts.map(([id, name]) => `<li><a href="text/${id}.xhtml">${name}</a></li>`).join('')}</ol></nav>` +
    '<nav id="landmarks" epub:type="landmarks"><ol><li><a href="text/titlepage.xhtml" epub:type="frontmatter">Frontmatter</a></li><li><a href="text/chapter-1.xhtml" epub:type="bodymatter">Start</a></li></ol></nav></body></html>';
  const cover = options.cover ? '<item href="images/cover.png" id="cover.png" media-type="image/png" properties="cover-image"/>' : '';
  files['epub/content.opf'] =
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:e2e:${encodeURIComponent(title)}</dc:identifier><dc:title>${title}</dc:title><dc:creator>An Author</dc:creator><dc:language>en-GB</dc:language></metadata>` +
    `<manifest><item href="toc.xhtml" id="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>${cover}${parts.map(([id]) => `<item href="text/${id}.xhtml" id="${id}" media-type="application/xhtml+xml"/>`).join('')}</manifest>` +
    `<spine>${parts.map(([id]) => `<itemref idref="${id}"/>`).join('')}</spine></package>`;
  return storedZip(files);
}

/** The SHA-256 of a file, as a transcript names the track it heard. */
export function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** What the recogniser heard of each chapter of the LibriVox Alice (its track k reads chapter k+1): the words, in order. */
export function librivoxWords(): string[][] {
  const doc = JSON.parse(readFileSync(LIBRIVOX_TRANSCRIPT, 'utf8')) as { tracks: { words: [number, number, string][] }[] };
  return doc.tracks.map((t) => t.words.map(([, , w]) => w));
}

/** Words heard from `from` to `to` ms of a track, spread evenly over that stretch in their order, as a transcript's. */
export function heardBetween(words: readonly string[], from: number, to: number): [number, number, string][] {
  const step = (to - from) / Math.max(1, words.length);
  return words.map((w, i): [number, number, string] => [from + i * step, from + (i + 0.8) * step, w]);
}

/**
 * Choose a listening speed in the player (D195): its speed button opens a sheet with a stepper and
 * the common speeds; a preset is one tap, and Escape closes the sheet again.
 */
export async function chooseSpeed(page: Page, rate: number): Promise<void> {
  await page.getByTestId('speed').click();
  await page.getByTestId(`speed-preset-${rate}`).click();
  await expect(page.getByTestId('speed-value')).toHaveText(`${rate.toFixed(2).replace(/0$/, '')}×`);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Playback speed' })).toBeHidden();
}
