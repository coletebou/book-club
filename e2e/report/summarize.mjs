#!/usr/bin/env node
/**
 * Summarise one or more Playwright JSON reports: per project, the distinct tests that ran and
 * how each ended (passed, failed, skipped, flaky), plus the tests that ran in Chromium but were
 * left out of WebKit (with their tags). The numbers are read from the reports, never assumed.
 *   node report/summarize.mjs reports/run-1.json [reports/run-2.json …]
 * Exits 1 when a report is missing a project, any test did not pass, or more than five tests
 * were left out of WebKit. The last line, "distinct min=N", is the smallest per-project count.
 */
import { readFileSync } from 'node:fs';

const PROJECTS = ['chromium-desktop', 'webkit-iphone'];
const MAX_LEFT_OUT = 5;

function* specsOf(suite, file) {
  for (const spec of suite.specs ?? []) yield { spec, file: spec.file ?? file };
  for (const child of suite.suites ?? []) yield* specsOf(child, child.file ?? file);
}

let failedAny = false;
let minDistinct = Infinity;
for (const path of process.argv.slice(2)) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const projects = new Map();
  for (const suite of report.suites) {
    for (const { spec, file } of specsOf(suite, suite.file)) {
      for (const test of spec.tests) {
        const p = projects.get(test.projectName) ?? { tests: new Map(), passed: 0, failed: 0, skipped: 0, flaky: 0 };
        const id = `${file} › ${spec.title}`;
        const last = test.results[test.results.length - 1]?.status;
        const outcome = test.status === 'skipped' ? 'skipped' : test.status === 'flaky' ? 'flaky' : test.status === 'expected' && last === 'passed' ? 'passed' : 'failed';
        p.tests.set(id, { outcome, tags: spec.tags ?? [] });
        p[outcome]++;
        projects.set(test.projectName, p);
      }
    }
  }
  const s = report.stats;
  console.log(`${path}: playwright stats expected=${s.expected} unexpected=${s.unexpected} flaky=${s.flaky} skipped=${s.skipped} duration=${Math.round(s.duration / 1000)}s`);
  if (report.errors?.length) {
    failedAny = true;
    for (const e of report.errors) console.log(`  error outside a test: ${(e.message ?? '').split('\n')[0]}`);
  }
  for (const name of PROJECTS) {
    if (projects.has(name)) continue;
    console.log(`  ${name}: MISSING from this report`);
    failedAny = true;
    minDistinct = 0;
  }
  for (const [name, p] of projects) {
    console.log(`  ${name}: ${p.tests.size} distinct tests, ${p.passed} passed, ${p.failed} failed, ${p.skipped} skipped, ${p.flaky} flaky`);
    minDistinct = Math.min(minDistinct, p.tests.size);
    if (p.failed || p.skipped || p.flaky) failedAny = true;
    for (const [id, t] of p.tests) if (t.outcome !== 'passed') console.log(`    ${t.outcome}: ${id}`);
  }
  const chromium = projects.get('chromium-desktop');
  const webkit = projects.get('webkit-iphone');
  if (chromium && webkit) {
    const left = [...chromium.tests.keys()].filter((id) => !webkit.tests.has(id));
    console.log(`  left out of webkit-iphone: ${left.length}`);
    for (const id of left) console.log(`    ${id} [${chromium.tests.get(id).tags.join(' ')}]`);
    if (left.length > MAX_LEFT_OUT) failedAny = true;
  }
}
console.log(`distinct min=${Number.isFinite(minDistinct) ? minDistinct : 0}`);
process.exit(failedAny ? 1 : 0);
