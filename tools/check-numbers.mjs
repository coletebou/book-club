#!/usr/bin/env node
// Keeps the repository's two hand-taken number series sound (D226): the server's migrations
// (apps/server/src/db/migrations/NNN_name.sql) and the design decisions (docs/DECISIONS.md,
// `## D<n>.` headings, cited from code as `D<n>`). Parallel branches each take "the next" number,
// so two of them meet on master with the same one; a migration whose number a database has already
// passed never runs there, silently (db.ts `migrate`).
//
// CLI (from anywhere; reads the repository this file is in, or --root):
//   node tools/check-numbers.mjs           fails (exit 1) on a problem in this tree:
//                                           a migration number used twice or skipped, a .sql file
//                                           the loader would never take, a D-number with two
//                                           entries or a heading not in `## D<n>.` form, a D-number
//                                           cited somewhere with no entry
//   node tools/check-numbers.mjs --next    also prints the next free numbers, counting what every
//                                           open pull request has already taken, and the numbers
//                                           two of them (or one and master) both claim. Needs `gh`
//                                           signed in and the network; it only reads.
//
// Dependency-free: only Node built-ins, so CI runs it before `pnpm install`.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MIGRATIONS_DIR = 'apps/server/src/db/migrations';
export const DECISIONS_FILE = 'docs/DECISIONS.md';

// The loader's own pattern (apps/server/src/db/db.ts `loadMigrations`): anything else in the
// directory is not a migration, and a .sql file outside it is one that never runs.
const MIGRATION_NAME = /^(\d{3})_.+\.sql$/;
const DECISION_HEADING = /^## D(\d+)\. (.*)$/;
const LOOSE_HEADING = /^#{1,6}\s*D\d+\b/;
const CITATION = /\bD(\d{1,4})\b/g;

// Where a D-number is a citation: code, docs, SQL, workflows. Not third-party or generated text.
const CITED_IN = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|md|sql|swift|py|sh|ya?ml|css|html)$/;
const NOT_CITED_IN = [/^fixtures\//, /^patches\//, /(^|\/)public\//, /^pnpm-lock\.yaml$/];

/**
 * @param {string[]} files the file names in the migrations directory
 * @returns {{ entries: { number: number, name: string }[], problems: string[] }}
 */
export function checkMigrations(files) {
  const problems = [];
  const entries = [];
  for (const name of [...files].sort()) {
    const match = MIGRATION_NAME.exec(name);
    if (match) entries.push({ number: Number(match[1]), name });
    else if (/\.sql$/i.test(name)) problems.push(`${MIGRATIONS_DIR}/${name}: never runs, the loader takes only NNN_name.sql (three digits, an underscore)`);
  }
  const byNumber = groupBy(entries, (e) => e.number);
  for (const [number, same] of byNumber) {
    if (same.length > 1) problems.push(`migration ${pad(number)} is taken ${same.length} times (${same.map((e) => e.name).join(', ')}): whoever merged second takes the next free number`);
  }
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  for (let expected = 1, i = 0; i < numbers.length; expected++) {
    if (numbers[i] === expected) i++;
    else problems.push(`migration ${pad(expected)} is missing: the numbers run 001, 002, 003… with none skipped`);
  }
  return { entries, problems };
}

/**
 * @param {string} text docs/DECISIONS.md
 * @returns {{ entries: { number: number, name: string, line: number }[], problems: string[] }}
 */
export function checkDecisions(text) {
  const problems = [];
  const entries = [];
  text.split('\n').forEach((line, i) => {
    const match = DECISION_HEADING.exec(line);
    if (match) entries.push({ number: Number(match[1]), name: match[2].trim(), line: i + 1 });
    else if (LOOSE_HEADING.test(line)) problems.push(`${DECISIONS_FILE}:${i + 1}: "${line.trim()}" is not a "## D<n>. Title" heading, so nothing can find or cite it`);
  });
  for (const [number, same] of groupBy(entries, (e) => e.number)) {
    if (same.length > 1) problems.push(`D${number} has ${same.length} entries (${DECISIONS_FILE} lines ${same.map((e) => e.line).join(', ')}): whoever merged second takes the next free number and renumbers its citations`);
  }
  return { entries, problems };
}

/**
 * Every `D<n>` in the given files must have an entry: a citation left behind by a renumbering, or
 * one written before its entry, points at nothing.
 *
 * @param {{ path: string, text: string }[]} files
 * @param {Set<number>} known
 */
export function checkCitations(files, known) {
  const problems = [];
  for (const { path, text } of files) {
    text.split('\n').forEach((line, i) => {
      for (const match of line.matchAll(CITATION)) {
        const number = Number(match[1]);
        if (!known.has(number)) problems.push(`${path}:${i + 1}: cites D${number}, which ${DECISIONS_FILE} has no entry for`);
      }
    });
  }
  return problems;
}

/** @param {string} path */
export function isCitationSource(path) {
  return CITED_IN.test(path) && !NOT_CITED_IN.some((re) => re.test(path));
}

/** Everything wrong with the tree at `root`, as messages; none means sound. */
export function checkTree(root = REPO_ROOT) {
  const migrations = checkMigrations(readdirSync(join(root, MIGRATIONS_DIR)));
  const decisions = checkDecisions(readFileSync(join(root, DECISIONS_FILE), 'utf8'));
  // Tracked files and new ones not yet added (a local run sees them before the commit), not ignored ones.
  const tracked = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root).split('\0').filter((p) => p && isCitationSource(p));
  const files = tracked.flatMap((path) => {
    try {
      return [{ path, text: readFileSync(join(root, path), 'utf8') }];
    } catch {
      return []; // tracked but deleted in the working tree
    }
  });
  const citations = checkCitations(files, new Set(decisions.entries.map((e) => e.number)));
  return { migrations: migrations.entries, decisions: decisions.entries, problems: [...migrations.problems, ...decisions.problems, ...citations] };
}

/**
 * The next free numbers across several sources (master, this tree, each open pull request), and
 * the numbers two of them claim for different things. A number is claimed for the same thing when
 * the migration's file name, or the decision's title, is the same: a branch carries master's
 * entries too, and this tree may be one of the pull requests.
 *
 * @param {{ label: string, migrations: { number: number, name: string }[], decisions: { number: number, name: string }[] }[]} sources
 */
export function nextNumbers(sources) {
  /** @param {'migrations' | 'decisions'} kind */
  const series = (kind) => {
    /** @type {Map<number, Map<string, string[]>>} number -> name -> labels */
    const claims = new Map();
    for (const source of sources) {
      for (const { number, name } of source[kind]) {
        const names = claims.get(number) ?? new Map();
        names.set(name, [...(names.get(name) ?? []), source.label]);
        claims.set(number, names);
      }
    }
    const next = Math.max(0, ...claims.keys()) + 1;
    const collisions = [...claims].filter(([, names]) => names.size > 1).sort(([a], [b]) => a - b).map(([number, names]) => ({ number, claims: [...names].map(([name, labels]) => ({ name, labels })) }));
    return { next, collisions };
  };
  return { migrations: series('migrations'), decisions: series('decisions') };
}

/** The numbers master and every open pull request hold, read from the remote without checking anything out. */
function remoteSources(root) {
  git(['fetch', '--quiet', 'origin', 'master'], root);
  const sources = [{ label: 'master', ...numbersAt('origin/master', root) }];
  const prs = JSON.parse(execFileSync('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title'], { cwd: root, encoding: 'utf8' }));
  for (const pr of prs) {
    git(['fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`], root);
    sources.push({ label: `#${pr.number} ${pr.title}`, ...numbersAt(git(['rev-parse', 'FETCH_HEAD'], root), root) });
  }
  return sources;
}

/**
 * The migrations and decisions a commit holds, read from git without checking it out.
 * @param {string} rev
 */
export function numbersAt(rev, root = REPO_ROOT) {
  const read = (/** @type {string[]} */ args) => {
    try {
      return git(args, root);
    } catch {
      return ''; // a commit from before the directory or the file existed
    }
  };
  const files = read(['ls-tree', '--name-only', `${rev}:${MIGRATIONS_DIR}`]).split('\n').filter(Boolean);
  return { migrations: checkMigrations(files).entries, decisions: checkDecisions(read(['show', `${rev}:${DECISIONS_FILE}`])).entries };
}

function report(sources) {
  const { migrations, decisions } = nextNumbers(sources);
  const lines = [`Next free migration: ${pad(migrations.next)}_<name>.sql`, `Next free decision:  D${decisions.next}`];
  for (const [kind, { collisions }] of /** @type {const} */ ([['migration', migrations], ['decision', decisions]])) {
    for (const { number, claims } of collisions) {
      lines.push(`  ${kind === 'migration' ? `migration ${pad(number)}` : `D${number}`} is claimed for ${claims.length} things:`);
      for (const { name, labels } of claims) lines.push(`    ${name} (${labels.join('; ')})`);
    }
  }
  return lines.join('\n');
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function pad(number) {
  return String(number).padStart(3, '0');
}

/**
 * @template T, K
 * @param {T[]} items
 * @param {(item: T) => K} key
 */
function groupBy(items, key) {
  /** @type {Map<K, T[]>} */
  const groups = new Map();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

function main(argv) {
  let root = REPO_ROOT;
  let next = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--next') next = true;
    else if (argv[i] === '--root') root = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}\nusage: node tools/check-numbers.mjs [--next] [--root <dir>]`);
      return 2;
    }
  }
  const tree = checkTree(root);
  for (const problem of tree.problems) console.error(problem);
  if (tree.problems.length === 0) process.stdout.write(`Numbering sound: ${tree.migrations.length} migrations, ${tree.decisions.length} decisions.\n`);
  if (next) process.stdout.write(`${report([{ label: 'this tree', migrations: tree.migrations, decisions: tree.decisions }, ...remoteSources(root)])}\n`);
  return tree.problems.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
