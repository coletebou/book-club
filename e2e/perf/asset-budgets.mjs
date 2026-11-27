#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../../apps/web/dist/', import.meta.url)));
// About 5% headroom over the measured production bundles: 221,544 startup bytes and 1,534,951 install bytes (D234, D253).
const budgets = { initialJavaScript: 233_000, precache: 1_612_000 };
const read = (name) => readFileSync(path.join(dist, name), 'utf8');

function initialScripts() {
  const manifest = JSON.parse(read('.vite/manifest.json'));
  const seen = new Set();
  const files = new Set();
  function visit(key) {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (/\.m?js$/.test(chunk.file)) files.add(chunk.file);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }
  visit('index.html');
  // Vite's manifest does not describe public scripts such as the pre-paint theme script.
  const origin = 'https://bookclub.invalid';
  const scriptSources = /<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>]+))/gi;
  for (const [, doubleQuoted, singleQuoted, unquoted] of read('index.html').matchAll(scriptSources)) {
    const url = new URL(doubleQuoted ?? singleQuoted ?? unquoted, origin);
    if (url.origin === origin && /\.m?js$/.test(url.pathname)) files.add(decodeURIComponent(url.pathname.slice(1)));
  }
  return files;
}

function precachedFiles() {
  // Workbox injects an array encoded as compact JSON, with object keys in sorted order.
  const matches = read('sw.js').match(/\[\{(?:"integrity":"[^"]+",)?"revision":.*?\}\]/g);
  if (matches?.length !== 1) throw new Error('Expected one Workbox precache manifest in sw.js');
  const files = new Set(JSON.parse(matches[0]).map((entry) => entry.url));
  if (!files.has('index.html')) throw new Error('The precache manifest does not include index.html');
  return files;
}

function gzipBytes(name) {
  const file = path.resolve(dist, name);
  if (!file.startsWith(dist + path.sep)) throw new Error(`Asset is outside the build: ${name}`);
  const raw = statSync(file).size;
  const gzip = statSync(`${file}.gz`, { throwIfNoEntry: false });
  return gzip?.size ?? raw;
}

for (const [name, files] of Object.entries({ initialJavaScript: initialScripts(), precache: precachedFiles() })) {
  const bytes = [...files].reduce((total, file) => total + gzipBytes(file), 0);
  console.log(`${name}: ${bytes} bytes across ${files.size} files (budget ${budgets[name]})`);
  if (bytes > budgets[name]) {
    console.error(`${name} exceeds its budget by ${bytes - budgets[name]} bytes`);
    process.exitCode = 1;
  }
}
