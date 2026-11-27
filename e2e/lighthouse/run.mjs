#!/usr/bin/env node
/**
 * Lighthouse mobile audits (the default Lighthouse mobile profile: a mid-range phone with
 * simulated slow 4G and a 4x slower CPU) of the library and reader pages of the demo club,
 * signed in as a demo member. Prints Lighthouse's own scores and every failing audit, writes
 * the full reports to test-results/lighthouse/, and exits non-zero when a score is below the
 * acceptance thresholds.
 *
 *   BOOKCLUB_URL=http://127.0.0.1:47100 node lighthouse/run.mjs
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import lighthouse from 'lighthouse';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BOOKCLUB_URL ?? 'http://127.0.0.1:47100';
const EMAIL = process.env.BOOKCLUB_LH_EMAIL ?? 'ana@demo.bookclub';
const PASSWORD = process.env.BOOKCLUB_LH_PASSWORD ?? 'wonderland-demo';
const OUT = path.join(HERE, '..', 'test-results', 'lighthouse');
const THRESHOLDS = { performance: 0.85, accessibility: 0.95, 'best-practices': 0.95 };
// Hosted mobile audits start from the measured demo baseline (D234).
const ciPerformance = process.argv.includes('--ci') ? { library: 0.70, reader: 0.60 } : {};

async function api(pathname, init = {}) {
  const res = await fetch(new URL(pathname, BASE), { ...init, headers: { origin: BASE, 'content-type': 'application/json', ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} returned ${res.status}`);
  return res;
}

const signin = await api('/api/auth/signin', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const cookie = signin.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const asMember = { headers: { cookie } };
const clubs = await (await api('/api/clubs', asMember)).json();
const club = clubs.find((c) => c.name === 'The Rabbit Hole Society') ?? clubs[0];
if (!club) throw new Error(`${EMAIL} is in no club; is the demo stack seeded?`);
const books = await (await api(`/api/clubs/${club.id}/books`, asMember)).json();
const book = books.find((b) => /Alice/.test(b.title)) ?? books[0];
if (!book) throw new Error(`the club ${club.name} has no books`);

const bookPath = `/api/books/${book.id}`;
const detail = await (await api(bookPath, asMember)).json();
const edition = detail.editions.find((e) => e.kind === 'epub' && e.status === 'ready');
if (!edition?.publicationUrl) throw new Error('The demo book needs a ready EPUB edition');
const pages = [
  { name: 'library', url: `${BASE}/clubs/${club.id}`, requiredRequest: `/api/clubs/${club.id}/books` },
  { name: 'reader', url: `${BASE}/books/${book.id}/read`, requiredRequest: edition.publicationUrl },
  ...(process.env.BOOKCLUB_LH_ALL ? [{ name: 'book', url: `${BASE}/books/${book.id}` }, { name: 'listen', url: `${BASE}/books/${book.id}/listen` }] : []),
];

async function audit(url) {
  const profile = await mkdtemp(path.join(tmpdir(), 'bookclub-lighthouse-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', args: ['--remote-debugging-port=0'] });
    // The request context shares its cookie jar with Chromium, so the session stays scoped to
    // this origin. A fresh profile for each route keeps its cache and service worker cold.
    const signedIn = await context.request.post(new URL('/api/auth/signin', BASE).href, {
      headers: { origin: BASE },
      data: { email: EMAIL, password: PASSWORD },
    });
    if (!signedIn.ok()) throw new Error(`Browser sign-in returned ${signedIn.status()}`);
    const [port] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
    const result = await lighthouse(url, {
      port: Number(port),
      logLevel: 'error',
      disableStorageReset: true,
      onlyCategories: Object.keys(THRESHOLDS),
      onlyAudits: ['network-requests'],
    });
    if (!result?.lhr) throw new Error('Lighthouse did not produce a report');
    return result.lhr;
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

await mkdir(OUT, { recursive: true });
let failed = false;
for (const page of pages) {
  const report = path.join(OUT, `${page.name}.report.json`);
  let lhr;
  try {
    lhr = await audit(page.url);
    await writeFile(report, JSON.stringify(lhr, null, 2));
  } catch (err) {
    console.error(`Lighthouse could not audit ${page.name}: ${err.message}`);
    failed = true;
    continue;
  }
  const requests = lhr.audits['network-requests']?.details?.items ?? [];
  const loaded = !page.requiredRequest || requests.some((item) => item.url === new URL(page.requiredRequest, BASE).href && item.statusCode === 200);
  if (lhr.runtimeError || lhr.finalDisplayedUrl !== page.url || !loaded) {
    console.error(`${page.name} did not load as a signed-in member: ${lhr.runtimeError?.message ?? lhr.finalDisplayedUrl}`);
    failed = true;
    continue;
  }
  const scores = Object.entries(lhr.categories).map(([id, c]) => `${id} ${Math.round(c.score * 100)}`);
  const metrics = ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index']
    .map((id) => `${id.replace(/-/g, ' ')} ${lhr.audits[id].displayValue}`)
    .join(', ');
  console.log(`${page.name} (${lhr.configSettings.formFactor}, Lighthouse ${lhr.lighthouseVersion}): ${scores.join(', ')}`);
  console.log(`  ${metrics}`);
  for (const [id, min] of Object.entries({ ...THRESHOLDS, performance: ciPerformance[page.name] ?? THRESHOLDS.performance })) {
    const cat = lhr.categories[id];
    if (cat.score === null || cat.score < min) {
      console.error(`  [${id}] score below ${Math.round(min * 100)} on ${page.name}`);
      failed = true;
    }
    for (const ref of cat.auditRefs) {
      const audit = lhr.audits[ref.id];
      if (ref.weight > 0 && audit.score !== null && audit.score < 1) console.log(`  [${id}] ${audit.id}: ${audit.title} (${audit.displayValue ?? audit.score})`);
    }
  }
}
process.exitCode = failed ? 1 : 0;
