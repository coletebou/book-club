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
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BOOKCLUB_URL ?? 'http://127.0.0.1:47100';
const EMAIL = process.env.BOOKCLUB_LH_EMAIL ?? 'ana@demo.bookclub';
const PASSWORD = process.env.BOOKCLUB_LH_PASSWORD ?? 'wonderland-demo';
const OUT = path.join(HERE, '..', 'test-results', 'lighthouse');
const THRESHOLDS = { performance: 0.85, accessibility: 0.95, 'best-practices': 0.95 };

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

const pages = [
  { name: 'library', url: `${BASE}/clubs/${club.id}` },
  { name: 'reader', url: `${BASE}/books/${book.id}/read` },
  ...(process.env.BOOKCLUB_LH_ALL ? [{ name: 'book', url: `${BASE}/books/${book.id}` }, { name: 'listen', url: `${BASE}/books/${book.id}/listen` }] : []),
];

mkdirSync(OUT, { recursive: true });
const bin = path.join(HERE, '..', 'node_modules', '.bin', 'lighthouse');
let failed = false;
for (const page of pages) {
  const report = path.join(OUT, `${page.name}.report.json`);
  const run = spawnSync(
    bin,
    [
      page.url,
      '--quiet',
      '--chrome-flags=--headless=new --no-sandbox',
      `--extra-headers=${JSON.stringify({ Cookie: cookie })}`,
      '--only-categories=performance,accessibility,best-practices',
      '--output=json',
      `--output-path=${report}`,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CHROME_PATH: chromium.executablePath() } },
  );
  if (run.status !== 0) {
    console.error(`lighthouse exited with ${run.status} on ${page.name}`);
    failed = true;
    continue;
  }
  const lhr = JSON.parse(readFileSync(report, 'utf8'));
  const scores = Object.entries(lhr.categories).map(([id, c]) => `${id} ${Math.round(c.score * 100)}`);
  const metrics = ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index']
    .map((id) => `${id.replace(/-/g, ' ')} ${lhr.audits[id].displayValue}`)
    .join(', ');
  console.log(`${page.name} (${lhr.configSettings.formFactor}, Lighthouse ${lhr.lighthouseVersion}): ${scores.join(', ')}`);
  console.log(`  ${metrics}`);
  for (const [id, min] of Object.entries(THRESHOLDS)) {
    const cat = lhr.categories[id];
    if (cat.score < min) failed = true;
    for (const ref of cat.auditRefs) {
      const audit = lhr.audits[ref.id];
      if (ref.weight > 0 && audit.score !== null && audit.score < 1) console.log(`  [${id}] ${audit.id}: ${audit.title} (${audit.displayValue ?? audit.score})`);
    }
  }
}
process.exit(failed ? 1 : 0);
