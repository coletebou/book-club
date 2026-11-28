import { existsSync, readFileSync } from 'node:fs';
import { chromium, request } from '@playwright/test';

// Run against two production demo stacks with matching seeds:
// node e2e/perf/cold-startup.mjs http://127.0.0.1:47247 http://127.0.0.1:47248
const [baseline, candidate] = process.argv.slice(2);
if (!baseline || !candidate) throw new Error('Expected the baseline and candidate demo URLs');

const pressurePath = '/proc/pressure/cpu';
function cpuStall() {
  if (!existsSync(pressurePath)) return null;
  const match = /^some .*total=(\d+)/m.exec(readFileSync(pressurePath, 'utf8'));
  return match ? Number(match[1]) : null;
}

function startTimer() {
  const started = performance.now();
  const stalled = cpuStall();
  return () => stalled === null ? null : (cpuStall() - stalled) / ((performance.now() - started) * 10);
}

async function measure(browser, options) {
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.afterNextPaint = (selector) => new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (!document.querySelector(selector)) return;
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
        });
        observer.observe(document, { childList: true, subtree: true });
      });
      window.firstCardPaint = window.afterNextPaint('[data-testid="book-card"]');
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150, downloadThroughput: 1_125_000, uploadThroughput: 375_000,
    });

    const homePressure = startTimer();
    await page.goto('/', { waitUntil: 'commit' });
    const link = page.locator('[data-testid="book-card"] .book-card-link').first();
    await link.waitFor();
    const homeMs = await page.evaluate(() => window.firstCardPaint);
    const homePressurePercent = homePressure();

    await link.evaluate((target) => {
      target.addEventListener('click', () => {
        const clicked = performance.now();
        window.detailPaint = window.afterNextPaint('#book-title').then((painted) => painted - clicked);
      }, { once: true });
    });
    const detailPressure = startTimer();
    await link.click();
    await page.locator('#book-title').waitFor();
    const detailMs = await page.evaluate(() => window.detailPaint);
    return { homeMs, detailMs, totalMs: homeMs + detailMs, homePressurePercent, detailPressurePercent: detailPressure() };
  } finally {
    await context.close();
  }
}

const options = new Map();
for (const [label, baseURL] of Object.entries({ baseline, candidate })) {
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: new URL(baseURL).origin } });
  try {
    const response = await api.post('/api/auth/signin', { data: { email: 'ana@demo.bookclub', password: 'wonderland-demo' } });
    if (!response.ok()) throw new Error(`Demo sign-in failed for ${label} (${response.status()})`);
    options.set(label, { baseURL, storageState: await api.storageState(), serviceWorkers: 'block' });
  } finally {
    await api.dispose();
  }
}

const browser = await chromium.launch();
try {
  for (let pair = 1; pair <= 6; pair++) {
    const order = pair % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const label of order) {
      const sample = await measure(browser, options.get(label));
      console.log(JSON.stringify({ pair, label, ...sample }));
    }
  }
} finally {
  await browser.close();
}
