#!/usr/bin/env node
/**
 * Writes brotli (.br) and gzip (.gz) copies of the built app's text files, at the highest
 * settings, so the server sends them without compressing anything at request time.
 *   node scripts/precompress.mjs [dist]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const dist = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.webmanifest', '.wasm', '.txt']);

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (TEXT.has(path.extname(entry.name).toLowerCase())) yield full;
  }
}

let before = 0;
let after = 0;
const jobs = [];
for await (const file of files(dist)) {
  jobs.push(
    (async () => {
      const data = await readFile(file);
      if (data.length < 1024) return;
      const [br, gz] = await Promise.all([
        brotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
        gzip(data, { level: 9 }),
      ]);
      if (br.length < data.length) await writeFile(`${file}.br`, br);
      if (gz.length < data.length) await writeFile(`${file}.gz`, gz);
      before += data.length;
      after += Math.min(br.length, data.length);
    })(),
  );
}
await Promise.all(jobs);
const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`precompressed ${jobs.length} files in ${dist}: ${kb(before)} -> ${kb(after)} brotli`);
