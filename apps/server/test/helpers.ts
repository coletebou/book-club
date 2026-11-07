import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { type BookDetail, type ClubDetail, type Import, type ServerMessage, ServerMessageSchema } from '@bookclub/shared';
import WebSocket from 'ws';
import { type BuiltApp, buildApp } from '../src/app';
import { loadConfig } from '../src/config';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const FIXTURES = path.join(ROOT, 'fixtures');
export const ALICE_EPUB = path.join(FIXTURES, 'books/alice-gutenberg-11.epub');
export const ALICE_PDF = path.join(FIXTURES, 'books/alice.pdf');
export const SYNTHETIC_AUDIO = path.join(FIXTURES, 'audio/synthetic');
/** Twelve LibriVox-shaped Alice tracks (tags only, no picture) plus the folder's cover image. */
export const ALICE_TINY_AUDIO = path.join(FIXTURES, 'audio/alice-tiny');
export const ALICE_TINY_COVER = path.join(ALICE_TINY_AUDIO, 'Alice_in_Wonderland.jpg');

export interface TestApp extends BuiltApp {
  readonly dir: string;
  /** http://127.0.0.1:<port> of the listening server. */
  readonly baseUrl: string;
  client(): Client;
  /** Wait for background ingest jobs. */
  settle(): Promise<void>;
}

export async function makeTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bookclub-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dir,
    LOG_LEVEL: 'silent',
    SCRYPT_LOG_N: '12',
    // Fixtures start many clubs as one owner; test/limits.test.ts sets and tests the real cap (D176).
    CLUBS_OWNED_MAX: '1000',
    ...env,
  });
  const built = await buildApp({ config, logger: false, background: false });
  const baseUrl = await built.app.listen({ host: '127.0.0.1', port: 0 });
  const testApp: TestApp = {
    ...built,
    dir,
    baseUrl,
    client: () => new Client(baseUrl),
    // Every queue empty at once: an ingest can start a transcription that starts an alignment,
    // and either can queue Cal's own indexing (ctx.calJobs, kept apart so its pending count never
    // changes what ctx.slowJobs.pending means to tests that predate Cal).
    settle: async () => {
      do {
        await built.ctx.jobs.idle();
        await built.ctx.slowJobs.idle();
        await built.ctx.calJobs.idle();
        // An agent's answer in chat (D204) runs after the request that asked for it has returned.
        await built.ctx.agents.idle();
      } while (built.ctx.jobs.pending > 0 || built.ctx.slowJobs.pending > 0 || built.ctx.calJobs.pending > 0 || built.ctx.agents.pending > 0);
    },
    async close() {
      await built.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return testApp;
}

export interface Res {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  /** Every Set-Cookie header of the response, unparsed. */
  readonly setCookies: readonly string[];
  readonly body: string;
  readonly bytes: Uint8Array;
  json<T>(): T;
}

export interface RequestOptions {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly payload?: unknown;
}

/** A browser-like client over real HTTP: keeps cookies, sends a same-origin Origin header on writes. */
export class Client {
  readonly cookies = new Map<string, string>();
  origin: string | null;

  constructor(readonly baseUrl: string) {
    this.origin = baseUrl;
  }

  get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(options: RequestOptions): Promise<Res> {
    const method = options.method.toUpperCase();
    const headers: Record<string, string> = { ...options.headers };
    if (this.cookies.size > 0 && !('cookie' in headers)) headers.cookie = this.cookieHeader;
    if (this.origin && !['GET', 'HEAD'].includes(method) && !('origin' in headers)) headers.origin = this.origin;
    let body: RequestInit['body'];
    if (options.payload instanceof Uint8Array) body = options.payload as RequestInit['body'];
    else if (typeof options.payload === 'string') body = options.payload;
    else if (options.payload !== undefined) {
      body = JSON.stringify(options.payload);
      headers['content-type'] ??= 'application/json';
    }
    const res = await fetch(this.baseUrl + options.url, { method, headers, body, redirect: 'manual' });
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expires = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith('expires='));
      const expired = expires ? new Date(expires.slice(8)).getTime() <= Date.now() : false;
      if (value === '' || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const bytes = method === 'HEAD' ? new Uint8Array() : new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    const headerMap: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headerMap[k] = v;
    });
    return { statusCode: res.status, headers: headerMap, setCookies: res.headers.getSetCookie(), body: text, bytes, json: <T>() => JSON.parse(text) as T };
  }

  get(url: string, headers?: Record<string, string>) {
    return this.request({ method: 'GET', url, ...(headers ? { headers } : {}) });
  }

  post(url: string, payload?: unknown, headers?: Record<string, string>) {
    return this.request({ method: 'POST', url, payload, ...(headers ? { headers } : {}) });
  }

  put(url: string, payload?: unknown) {
    return this.request({ method: 'PUT', url, payload });
  }

  patch(url: string, payload?: unknown) {
    return this.request({ method: 'PATCH', url, payload });
  }

  delete(url: string, payload?: unknown) {
    return this.request({ method: 'DELETE', url, ...(payload !== undefined ? { payload } : {}) });
  }

  async json<T>(res: Res | Promise<Res>, status?: number): Promise<T> {
    const r = await res;
    if (status !== undefined && r.statusCode !== status) throw new Error(`expected ${status}, got ${r.statusCode}: ${r.body}`);
    return r.json<T>();
  }
}

export const PASSWORD = 'correct horse battery';

/** First-run setup: the owner account plus a club. */
export async function setupOwner(t: TestApp, name = 'Cole', clubName = 'Thursday Readers'): Promise<{ owner: Client; club: ClubDetail }> {
  const owner = t.client();
  const res = await owner.post('/api/setup', { displayName: name, email: `${name.toLowerCase()}@example.com`, password: PASSWORD, clubName });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  const clubs = await owner.json<{ id: string }[]>(owner.get('/api/clubs'), 200);
  const club = await owner.json<ClubDetail>(owner.get(`/api/clubs/${clubs[0]!.id}`), 200);
  return { owner, club };
}

/** A new person joins through the club's invite link. */
export async function joinClub(t: TestApp, club: ClubDetail, name: string): Promise<Client> {
  const c = t.client();
  const res = await c.post('/api/auth/signup', {
    inviteCode: club.invite!.code,
    displayName: name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
    password: PASSWORD,
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  return c;
}

/** Someone with an account but in no club of ours (made through a second club's invite). */
export async function outsider(t: TestApp, owner: Client, name = 'Ozzy'): Promise<Client> {
  const other = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: `Other club ${Math.random()}` }), 201);
  const c = await joinClub(t, other, name);
  // The owner leaves no trace: Ozzy is only in "Other club", which the owner also owns, so make
  // Ozzy's club truly separate by having the owner leave is not possible (owner); tests only rely
  // on Ozzy not being a member of the club under test.
  return c;
}

export interface UploadFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly type: string;
  readonly role: 'main' | 'track' | 'cover';
}

export function fileFrom(p: string, role: UploadFile['role'], type: string, name = path.basename(p)): UploadFile {
  return { name, bytes: new Uint8Array(readFileSync(p)), type, role };
}

function metadataHeader(meta: Record<string, string>): string {
  return Object.entries(meta)
    .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`)
    .join(',');
}

/** Create a tus upload for one declared file; returns its URL. */
export async function tusCreate(c: Client, importId: string, index: number, file: UploadFile): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/uploads',
    headers: {
      'tus-resumable': '1.0.0',
      'upload-length': String(file.bytes.byteLength),
      'upload-metadata': metadataHeader({ importId, fileIndex: String(index), filename: file.name, filetype: file.type }),
    },
  });
  if (res.statusCode !== 201) throw new Error(`tus create failed: ${res.statusCode} ${res.body}`);
  return String(res.headers.location);
}

export async function tusPatch(c: Client, url: string, bytes: Uint8Array, offset: number) {
  return c.request({
    method: 'PATCH',
    url,
    headers: { 'tus-resumable': '1.0.0', 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' },
    payload: bytes,
  });
}

export async function tusHead(c: Client, url: string) {
  return c.request({ method: 'HEAD', url, headers: { 'tus-resumable': '1.0.0' } });
}

/** Full upload flow through the real API: import, tus uploads, finalize. */
export async function uploadBook(
  c: Client,
  clubId: string,
  kind: 'epub' | 'pdf' | 'audio',
  files: UploadFile[],
  finalize: Record<string, unknown> = {},
): Promise<{ bookId: string; editionId: string; importId: string }> {
  const imp = await c.json<Import>(
    c.post(`/api/clubs/${clubId}/imports`, { kind, files: files.map((f) => ({ name: f.name, size: f.bytes.byteLength, type: f.type, role: f.role })) }),
    201,
  );
  for (const [i, f] of files.entries()) {
    const url = await tusCreate(c, imp.id, i, f);
    const res = await tusPatch(c, url, f.bytes, 0);
    if (res.statusCode !== 204) throw new Error(`tus patch failed: ${res.statusCode} ${res.body}`);
  }
  const result = await c.json<{ bookId: string; editionId: string }>(
    c.post(`/api/imports/${imp.id}/finalize`, { title: 'Untitled', author: '', ...finalize }),
    201,
  );
  return { ...result, importId: imp.id };
}

export async function bookDetail(c: Client, bookId: string): Promise<BookDetail> {
  return c.json<BookDetail>(c.get(`/api/books/${bookId}`), 200);
}

/**
 * A note's media (D140): `POST /api/books/:bookId/media?kind=...`, one file, raw multipart bytes
 * built by hand (the Client has no multipart support of its own, and does not need one beyond
 * this single endpoint).
 */
export async function uploadNoteMedia(c: Client, bookId: string, kind: 'voice' | 'photo' | 'video', bytes: Uint8Array, filename: string, mime: string): Promise<Res> {
  const boundary = `----bookclub-test-${Math.random().toString(36).slice(2)}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const body = new Uint8Array(Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(bytes), Buffer.from(tail, 'utf8')]));
  return c.request({
    method: 'POST',
    url: `/api/books/${bookId}/media?kind=${kind}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}

/* ------------------------------------------------------------------------------------------ */
/* More helpers: accounts, uploads, raw HTTP, crafted files, WebSockets                         */
/* ------------------------------------------------------------------------------------------ */

/** Sign in to an existing account from a fresh client. */
export async function signIn(t: TestApp, email: string, password = PASSWORD): Promise<Client> {
  const c = t.client();
  const res = await c.post('/api/auth/signin', { email, password });
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`);
  return c;
}

/** An in-memory upload file. */
export function fileOf(name: string, content: Uint8Array | string, role: UploadFile['role'], type = 'application/octet-stream'): UploadFile {
  return { name, bytes: typeof content === 'string' ? new TextEncoder().encode(content) : content, type, role };
}

/** The MP3 files of a fixture folder in filename order, as audiobook tracks. */
export function audioTracks(dir: string): UploadFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mp3'))
    .sort()
    .map((f) => fileFrom(path.join(dir, f), 'track', 'audio/mpeg'));
}

/** Declare an import without uploading anything yet. */
export async function createImport(c: Client, clubId: string, kind: 'epub' | 'pdf' | 'audio', files: readonly UploadFile[]): Promise<Import> {
  return c.json<Import>(
    c.post(`/api/clubs/${clubId}/imports`, { kind, files: files.map((f) => ({ name: f.name, size: f.bytes.byteLength, type: f.type, role: f.role })) }),
    201,
  );
}

/** A tus creation request with arbitrary metadata and length; returns the raw response. */
export async function tusCreateRequest(c: Client, meta: Record<string, string>, length: number): Promise<Res> {
  return c.request({
    method: 'POST',
    url: '/api/uploads',
    headers: { 'tus-resumable': '1.0.0', 'upload-length': String(length), 'upload-metadata': metadataHeader(meta) },
  });
}

/** Upload every declared file of an import completely (one PATCH each). */
export async function uploadAll(c: Client, importId: string, files: readonly UploadFile[]): Promise<string[]> {
  const urls: string[] = [];
  for (const [i, f] of files.entries()) {
    const url = await tusCreate(c, importId, i, f);
    const res = await tusPatch(c, url, f.bytes, 0);
    if (res.statusCode !== 204) throw new Error(`tus patch failed: ${res.statusCode} ${res.body}`);
    urls.push(url);
  }
  return urls;
}

export interface RawRes {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** A request over node:http with the path sent exactly as written (fetch would resolve `..` first). */
export function rawRequest(baseUrl: string, method: string, rawPath: string, headers: Record<string, string> = {}): Promise<RawRes> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path: rawPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** A ZIP archive with stored (uncompressed) entries: enough to craft EPUBs for tests. */
export function makeZip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(typeof content === 'string' ? encoder.encode(content) : content);
    const nameBytes = Buffer.from(encoder.encode(name));
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x21, 12); // DOS date 1980-01-01 (method 0 = stored, time 0)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(nameBytes.byteLength, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    parts.push(local, nameBytes, data);
    directory.push(central, nameBytes);
    offset += local.byteLength + nameBytes.byteLength + data.byteLength;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dir.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

export interface EpubOptions {
  readonly title?: string;
  readonly author?: string;
  /** Leave META-INF/container.xml out (a valid ZIP that is not an EPUB). */
  readonly withoutContainer?: boolean;
  /** More files for the archive, by container path (e.g. images the sections refer to). */
  readonly extraFiles?: Record<string, string | Uint8Array>;
}

/** A small valid EPUB 3 without images: one XHTML document per section body and a nav document. */
export function makeEpub(sections: readonly string[], options: EpubOptions = {}): Uint8Array {
  const title = options.title ?? 'A Small Test Book';
  const author = options.author ?? 'Test Author';
  const xhtml = (heading: string, body: string) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>${heading}</title></head><body>${body}</body></html>`;
  const files: Record<string, string | Uint8Array> = { mimetype: 'application/epub+zip' };
  if (!options.withoutContainer) {
    files['META-INF/container.xml'] =
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  }
  const items = sections.map((_, i) => `<item id="s${i}" href="s${i}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spine = sections.map((_, i) => `<itemref idref="s${i}"/>`).join('');
  files['OEBPS/content.opf'] =
    `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:test:book</dc:identifier><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>en</dc:language></metadata>` +
    `<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items}</manifest><spine>${spine}</spine></package>`;
  files['OEBPS/nav.xhtml'] = xhtml(
    'Contents',
    `<nav epub:type="toc"><ol>${sections.map((_, i) => `<li><a href="s${i}.xhtml">Chapter ${i + 1}</a></li>`).join('')}</ol></nav>`,
  );
  sections.forEach((body, i) => {
    files[`OEBPS/s${i}.xhtml`] = xhtml(`Chapter ${i + 1}`, body);
  });
  return makeZip({ ...files, ...options.extraFiles });
}

/** Words of a generated paragraph: none of a real book's, distinct enough to be told apart. */
export function generatedWords(n: number, seed: string): string {
  return Array.from({ length: n }, (_, i) => `${seed}${(i * 7919) % 10_007}`).join(' ');
}

/**
 * An EPUB 3 made as Standard Ebooks make theirs (FR150): a title page and an imprint typed as front
 * matter, three chapters as body matter, then a colophon and its licence ("Uncopyright") typed as
 * back matter, its navigation document with landmarks. Its words are generated.
 */
export function standardEbook(options: { chapterWords?: number } = {}): Uint8Array {
  const n = options.chapterWords ?? 600;
  const doc = (title: string, bodyType: string, section: string) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en-GB"><head><title>${title}</title></head><body epub:type="${bodyType}">\n\t\t${section}\n\t</body></html>`;
  const chapter = (id: string, title: string) =>
    doc(title, 'bodymatter z3998:fiction', `<section id="${id}" role="doc-chapter" epub:type="chapter"><h2 epub:type="title">${title}</h2>${[1, 2, 3].map((p) => `<p>${generatedWords(n / 3, `${id}p${p}w`)}.</p>`).join('')}</section>`);
  const parts: [string, string, string][] = [
    ['titlepage', 'Titlepage', doc('Titlepage', 'frontmatter', '<section id="titlepage" epub:type="titlepage"><h1 epub:type="title">The Strange Case</h1><p>By <b epub:type="z3998:author">An Author</b>.</p></section>')],
    ['imprint', 'Imprint', doc('Imprint', 'frontmatter', `<section id="imprint" epub:type="imprint"><h2 epub:type="title">Imprint</h2><p>This ebook is the product of many hours of hard work by volunteers. ${generatedWords(60, 'imprint')}.</p></section>`)],
    ['chapter-1', 'Story of the Door', chapter('chapter-1', 'Story of the Door')],
    ['chapter-2', 'Search for Mr. Hyde', chapter('chapter-2', 'Search for Mr. Hyde')],
    ['chapter-10', 'Henry Jekyll’s Full Statement of the Case', chapter('chapter-10', 'Henry Jekyll’s Full Statement of the Case')],
    ['colophon', 'Colophon', doc('Colophon', 'backmatter', `<section id="colophon" role="doc-colophon" epub:type="colophon"><h2 epub:type="title">Colophon</h2><p>This ebook was produced for Standard Ebooks. ${generatedWords(90, 'colophon')}.</p></section>`)],
    ['uncopyright', 'Uncopyright', doc('Uncopyright', 'backmatter', `<section id="uncopyright" epub:type="copyright-page"><h2 epub:type="title">Uncopyright</h2><p>May you do good and not evil. ${generatedWords(150, 'licence')}.</p></section>`)],
  ];
  const files: Record<string, string> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml':
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="epub/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  };
  for (const [id, , body] of parts) files[`epub/text/${id}.xhtml`] = body;
  files['epub/toc.xhtml'] =
    `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Table of Contents</title></head><body epub:type="frontmatter">` +
    `<nav id="toc" epub:type="toc"><h2>Table of Contents</h2><ol>${parts.map(([id, title]) => `<li><a href="text/${id}.xhtml">${title}</a></li>`).join('')}</ol></nav>` +
    '<nav id="landmarks" epub:type="landmarks"><ol><li><a href="text/titlepage.xhtml" epub:type="frontmatter">Frontmatter</a></li><li><a href="text/chapter-1.xhtml" epub:type="bodymatter">The Strange Case</a></li></ol></nav></body></html>';
  files['epub/content.opf'] =
    '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:test:se</dc:identifier><dc:title>The Strange Case</dc:title><dc:creator>An Author</dc:creator><dc:language>en-GB</dc:language></metadata>' +
    `<manifest><item href="toc.xhtml" id="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>${parts.map(([id]) => `<item href="text/${id}.xhtml" id="${id}" media-type="application/xhtml+xml"/>`).join('')}</manifest>` +
    `<spine>${parts.map(([id]) => `<itemref idref="${id}"/>`).join('')}</spine><guide><reference href="text/titlepage.xhtml" title="Titlepage" type="title-page"/></guide></package>`;
  return makeZip(files);
}

export interface PdfOutlineEntry {
  readonly title: string;
  /** Zero-based page the entry points at. */
  readonly page: number;
  /** XYZ destination top, in points from the bottom of the 450-point page. */
  readonly top: number;
}

/** A minimal valid PDF: blank 300×450 pages, an info dictionary and an optional outline. */
export function makePdf(pageCount: number, info: { title?: string; author?: string } = {}, outline: readonly PdfOutlineEntry[] = []): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const pageIds = Array.from({ length: pageCount }, (_, i) => 3 + i);
  const infoId = 3 + pageCount;
  const outlinesId = infoId + 1;
  const itemIds = outline.map((_, i) => outlinesId + 1 + i);
  const objects = new Map<number, string>([
    [1, `<< /Type /Catalog /Pages 2 0 R${outline.length > 0 ? ` /Outlines ${outlinesId} 0 R` : ''} >>`],
    [2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`],
    ...pageIds.map((id): [number, string] => [id, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 450] >>']),
    [infoId, `<< /Title (${esc(info.title ?? '')}) /Author (${esc(info.author ?? '')}) >>`],
  ]);
  if (outline.length > 0) {
    objects.set(outlinesId, `<< /Type /Outlines /First ${itemIds[0]} 0 R /Last ${itemIds.at(-1)} 0 R /Count ${outline.length} >>`);
    outline.forEach((entry, i) => {
      const prev = i > 0 ? ` /Prev ${itemIds[i - 1]} 0 R` : '';
      const next = i < outline.length - 1 ? ` /Next ${itemIds[i + 1]} 0 R` : '';
      objects.set(itemIds[i]!, `<< /Title (${esc(entry.title)}) /Parent ${outlinesId} 0 R${prev}${next} /Dest [${pageIds[entry.page]} 0 R /XYZ 0 ${entry.top} 0] >>`);
    });
  }
  const lastId = outline.length > 0 ? itemIds.at(-1)! : infoId;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id <= lastId; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${lastId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= lastId; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${lastId + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** Poll until `check` returns true (for effects that settle asynchronously on the server). */
export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** What this thread did while watchThread watched it, from each turn of its event loop to the next. */
export interface ThreadWatch {
  /** The longest it went without turning (what anything waiting on it waited), and how much of that it spent working. */
  readonly longest: { readonly wallMs: number; readonly cpuMs: number };
  /** The most it worked from one turn to the next, in its own CPU time. */
  readonly busiestCpuMs: number;
  /** All the CPU time it spent, and all the process spent meanwhile (every thread: workers, garbage collection, libuv's pool). */
  readonly threadCpuMs: number;
  readonly processCpuMs: number;
}

/**
 * Watch this thread (the server's, and the test clients' beside it) turn by turn, every
 * `resolutionMs`, until `stop`: how long it went without turning, and how much of that it spent
 * working (process.threadCpuUsage, its own CPU time). On a box doing nothing else the two are about
 * the same. On a shared one they part company: other jobs' work, a memory limit's reclaim, a disk
 * busy with someone else's writes, a page swapped out, each stop a thread for as long as the box
 * takes, with nothing of its own to do; what it spent working is what its own code cost it,
 * whatever else the box was doing.
 */
export function watchThread(resolutionMs = 10): { stop(): ThreadWatch } {
  const cpuMs = () => {
    const { user, system } = process.threadCpuUsage();
    return (user + system) / 1000;
  };
  const processStart = process.cpuUsage();
  const threadStart = cpuMs();
  let wallAt = performance.now();
  let cpuAt = threadStart;
  let longest = { wallMs: 0, cpuMs: 0 };
  let busiestCpuMs = 0;
  const turn = () => {
    const wall = performance.now();
    const cpu = cpuMs();
    const gap = { wallMs: wall - wallAt, cpuMs: cpu - cpuAt };
    if (gap.wallMs > longest.wallMs) longest = gap;
    busiestCpuMs = Math.max(busiestCpuMs, gap.cpuMs);
    wallAt = wall;
    cpuAt = cpu;
    return cpu;
  };
  const timer = setInterval(turn, resolutionMs);
  return {
    stop() {
      clearInterval(timer);
      // The last stretch counts too, up to now.
      const threadEnd = turn();
      const { user, system } = process.cpuUsage(processStart);
      return { longest, busiestCpuMs, threadCpuMs: threadEnd - threadStart, processCpuMs: (user + system) / 1000 };
    },
  };
}

export interface SocketClose {
  readonly code: number;
  readonly reason: string;
}

type MessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

/** A WebSocket to `/ws` that records every server message, each validated against the shared schema. */
export class Socket {
  readonly messages: ServerMessage[] = [];
  readonly invalid: unknown[] = [];
  readonly closed: Promise<SocketClose>;
  private readonly returned = new Set<number>();
  private listeners: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: WebSocket.RawData) => {
      const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = text;
      }
      const parsed = ServerMessageSchema.safeParse(raw);
      if (parsed.success) this.messages.push(parsed.data);
      else this.invalid.push(raw);
      for (const listener of this.listeners.splice(0)) listener();
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  private find<T extends ServerMessage['type']>(type: T, predicate: (m: MessageOf<T>) => boolean): number {
    return this.messages.findIndex((m, i) => !this.returned.has(i) && m.type === type && predicate(m as MessageOf<T>));
  }

  /** The first message of `type` matching `predicate` that no earlier call returned; waits for it. */
  async next<T extends ServerMessage['type']>(type: T, predicate: (m: MessageOf<T>) => boolean = () => true, timeoutMs = 3000): Promise<MessageOf<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.invalid.length > 0) throw new Error(`invalid server message: ${JSON.stringify(this.invalid[0])}`);
      const index = this.find(type, predicate);
      if (index !== -1) {
        this.returned.add(index);
        return this.messages[index] as MessageOf<T>;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching ${type} message within ${timeoutMs} ms (got ${this.messages.map((m) => m.type).join(', ')})`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.listeners.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** True when no message of `type` matching `predicate` (and not returned before) arrives within `ms`. */
  async quiet<T extends ServerMessage['type']>(type: T, predicate: (m: MessageOf<T>) => boolean = () => true, ms = 300): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.find(type, predicate) === -1;
  }

  close(): Promise<SocketClose> {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
    return this.closed;
  }
}

export interface SocketOptions {
  /** Origin header to send; `null` sends none. Defaults to the app's own origin. */
  readonly origin?: string | null;
  /** Cookie header to send instead of the client's cookies. */
  readonly cookie?: string;
  /** Answer the server's heartbeat pings (default true). */
  readonly autoPong?: boolean;
}

/** Open a real WebSocket to the app as the client's user (or anonymously when `c` is null). */
export async function openSocket(t: TestApp, c: Client | null, options: SocketOptions = {}): Promise<Socket> {
  const headers: Record<string, string> = {};
  const cookie = options.cookie ?? c?.cookieHeader;
  if (cookie) headers.cookie = cookie;
  const origin = options.origin === undefined ? t.baseUrl : options.origin;
  if (origin !== null) headers.origin = origin;
  const ws = new WebSocket(`${t.baseUrl.replace(/^http/, 'ws')}/ws`, { headers, autoPong: options.autoPong ?? true });
  const socket = new Socket(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return socket;
}

/**
 * Close a test app without waiting on keep-alive sockets. A streamed file can end a tick after its
 * last byte reached the client; a connection that goes idle after close() began is never revisited,
 * so close() would wait out Fastify's 72 s keep-alive timeout.
 */
export async function closeApp(t: TestApp): Promise<void> {
  t.app.server.closeAllConnections();
  await t.close();
}
