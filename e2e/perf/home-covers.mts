import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type Browser, type BrowserContextOptions, chromium, devices, request } from '@playwright/test';
import { seedDemoIfEmpty } from '../../apps/server/src/cli/seed';
import { createBook, setBookCover } from '../../apps/server/src/repos/books';
import { createClub } from '../../apps/server/src/repos/clubs';
import { closeApp, makeTestApp } from '../../apps/server/test/helpers';

// Run from the root with apps/server/node_modules/.bin/tsx e2e/perf/home-covers.mts <baseline-dist> <candidate-dist>
const [baseline, candidate] = process.argv.slice(2);
if (!baseline || !candidate) throw new Error('Pass the baseline and candidate production build directories');

declare global {
  interface Window {
    clubTextPaint: Promise<number>;
  }
}

function cpuStall(): number | null {
  const file = '/proc/pressure/cpu';
  if (!existsSync(file)) return null;
  const match = /^some .*total=(\d+)/m.exec(readFileSync(file, 'utf8'));
  return match ? Number(match[1]) : null;
}

async function seedShelves(test: Awaited<ReturnType<typeof makeTestApp>>) {
  await seedDemoIfEmpty(test.ctx);
  const { db } = test.ctx;
  const user = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', ['ana@demo.bookclub'])!;
  const original = db.get<{ cover_blob_id: string | null }>('SELECT cover_blob_id FROM books LIMIT 1')!;
  db.tx(() => {
    for (let c = 0; c < 8; c++) {
      const club = createClub(db, { name: `Cover fixture club ${c}`, description: 'Home cover fixture', ownerId: user.id });
      for (let b = 0; b < 4; b++) {
        const book = createBook(db, { clubId: club.id, createdBy: user.id, title: `Cover fixture ${c}-${b}`, author: 'Reading Sample' });
        if (b % 2 === 0 && original.cover_blob_id) setBookCover(db, book.id, original.cover_blob_id);
      }
    }
  });
}

async function measure(browser: Browser, options: BrowserContextOptions) {
  const context = await browser.newContext({ ...devices['iPhone 15'], ...options, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150, downloadThroughput: 100_000, uploadThroughput: 300_000,
    });
    const requests = new Map<string, { url: string; initial: string; updated?: string }>();
    cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
      const url = new URL(request.url);
      if (/^\/media\/books\/[^/]+\/cover$/.test(url.pathname)) requests.set(requestId, { url: url.pathname + url.search, initial: request.initialPriority });
    });
    cdp.on('Network.resourceChangedPriority', ({ requestId, newPriority }) => {
      const cover = requests.get(requestId);
      if (cover) cover.updated = newPriority;
    });
    await page.addInitScript(() => {
      window.clubTextPaint = new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (!document.querySelector('.club-home h2')) return;
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
        });
        observer.observe(document, { childList: true, subtree: true });
      });
    });
    const started = performance.now();
    const stalled = cpuStall();
    await page.goto('/', { waitUntil: 'commit' });
    await page.getByRole('heading', { name: 'Your clubs' }).waitFor();
    await page.getByTestId('club-card').last().waitFor();
    const { urls, ...timings } = await page.evaluate(async () => {
      const covers = [...document.querySelectorAll<HTMLImageElement>('.club-shelf img')];
      const visible = covers.filter((cover) => {
        const rect = cover.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      });
      if (!visible.length || covers.length !== 33) throw new Error('Expected the 33-cover fixture');
      await Promise.all(visible.map((cover) => cover.decode()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return {
        urls: visible.map((cover) => new URL(cover.src).pathname + new URL(cover.src).search),
        coverPaintMs: performance.now(),
        textPaintMs: await window.clubTextPaint,
      };
    });
    const pressure = stalled === null ? null : (cpuStall()! - stalled) / ((performance.now() - started) * 10);
    const visibleRequests = [...requests.values()].filter(({ url }) => urls.includes(url));
    const offscreenRequests = requests.size - visibleRequests.length;
    const lastCover = page.locator('.club-shelf img').last();
    await lastCover.scrollIntoViewIfNeeded();
    await lastCover.evaluate((cover) => (cover as HTMLImageElement).decode());
    return {
      ...timings, pressure, offscreenRequests,
      visiblePriorities: visibleRequests.map(({ initial, updated }) => [initial, updated ?? initial]),
    };
  } finally {
    await context.close();
  }
}

const instances: Awaited<ReturnType<typeof makeTestApp>>[] = [];
const profiles = new Map<string, BrowserContextOptions>();
try {
  for (const [label, dist] of Object.entries({ baseline, candidate })) {
    const test = await makeTestApp({ WEB_DIST: path.resolve(dist) });
    instances.push(test);
    await seedShelves(test);
    const api = await request.newContext({ baseURL: test.baseUrl, extraHTTPHeaders: { origin: test.baseUrl } });
    try {
      const response = await api.post('/api/auth/signin', { data: { email: 'ana@demo.bookclub', password: 'wonderland-demo' } });
      if (!response.ok()) throw new Error(`Demo sign-in failed for ${label}`);
      profiles.set(label, { baseURL: test.baseUrl, storageState: await api.storageState() });
    } finally {
      await api.dispose();
    }
  }
  const browser = await chromium.launch();
  try {
    for (let pair = 1; pair <= 6; pair++) {
      const order = pair % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const label of order) console.log(JSON.stringify({ pair, label, ...await measure(browser, profiles.get(label)!) }));
    }
  } finally {
    await browser.close();
  }
} finally {
  for (const instance of instances) await closeApp(instance);
}
