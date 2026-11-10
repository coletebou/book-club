// Tests for tools/check-numbers.mjs (D226): migration and decision numbers, citations, and the next
// free numbers across master, this tree and open pull requests.
// `node --test tools/check-numbers.test.mjs` -- node:test and node:assert are Node built-ins, so this
// needs nothing installed. Run from the repo root, where check.yml invokes it.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { checkCitations, checkDecisions, checkMigrations, checkTree, isCitationSource, nextNumbers, numbersAt } from './check-numbers.mjs';

const SCRIPT = new URL('./check-numbers.mjs', import.meta.url).pathname;
const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A scratch repository holding the given files, committed, so `git ls-files` sees them. */
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'check-numbers-test-'));
  scratch.push(dir);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'master']);
  const write = (/** @type {Record<string, string>} */ more) => {
    for (const [path, text] of Object.entries(more)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'files']);
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, git, write, head: write(files) };
}

const sound = {
  'apps/server/src/db/migrations/001_init.sql': 'CREATE TABLE a (x);\n',
  'apps/server/src/db/migrations/002_more.sql': 'CREATE TABLE b (x);\n',
  'docs/DECISIONS.md': '# Decisions\n\n## D1. One origin\n\nText citing D2.\n\n## D2. Two\n\nText.\n',
  'apps/server/src/main.ts': '// One origin (D1).\nexport {};\n',
};

function cli(dir) {
  return spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' });
}

describe('migrations', () => {
  test('numbered 001, 002, 003… in their loader’s form are sound', () => {
    const { entries, problems } = checkMigrations(['002_b.sql', '001_a.sql', '003_c.sql']);
    assert.deepEqual(problems, []);
    assert.deepEqual(entries.map((e) => e.number), [1, 2, 3]);
  });

  test('a number two branches each took is named, with both files', () => {
    const { problems } = checkMigrations(['001_a.sql', '002_chat_threads.sql', '002_club_plans.sql']);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /migration 002 is taken 2 times \(002_chat_threads\.sql, 002_club_plans\.sql\)/);
  });

  test('a skipped number is named', () => {
    assert.deepEqual(checkMigrations(['001_a.sql', '003_c.sql']).problems, ['migration 002 is missing: the numbers run 001, 002, 003… with none skipped']);
  });

  test('a .sql file the loader would never take is named; other files are not migrations', () => {
    const { entries, problems } = checkMigrations(['001_a.sql', '0002_b.sql', '2_c.sql', '003-d.sql', 'README.md', '.gitkeep']);
    assert.deepEqual(entries.map((e) => e.name), ['001_a.sql']);
    assert.equal(problems.length, 3);
    for (const name of ['0002_b.sql', '2_c.sql', '003-d.sql']) assert.ok(problems.some((p) => p.includes(name) && p.includes('never runs')), name);
  });
});

describe('decisions', () => {
  test('one entry per number is sound, in any order', () => {
    const { entries, problems } = checkDecisions('# D\n\n## D2. Two\n\ntext\n\n## D1. One\n');
    assert.deepEqual(problems, []);
    assert.deepEqual(entries.map((e) => [e.number, e.name, e.line]), [[2, 'Two', 3], [1, 'One', 7]]);
  });

  test('a number with two entries is named, with their lines', () => {
    const { problems } = checkDecisions('## D206. Plans\n\n## D207. Calendars\n\n## D206. Questions\n');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /D206 has 2 entries \(docs\/DECISIONS\.md lines 1, 5\)/);
  });

  test('a heading not in "## D<n>. Title" form is named, since nothing would find it', () => {
    const { entries, problems } = checkDecisions('## D1. One\n## D2: Two\n### D3. Three\n##D4. Four\n');
    assert.deepEqual(entries.map((e) => e.number), [1]);
    assert.equal(problems.length, 3);
  });

  test('a decision mentioned in passing is not a heading', () => {
    assert.deepEqual(checkDecisions('## D1. One\n\nRevisits D53 and D2.\n- D9 is listed\n').problems, []);
  });
});

describe('citations', () => {
  test('a D-number with no entry is named where it is cited', () => {
    // Written as D${999} so that this file's own source cites no decision that does not exist.
    const problems = checkCitations([{ path: 'a.ts', text: `// D1\n// D1 and D${999}, then D2\n` }], new Set([1, 2]));
    assert.deepEqual(problems, [`a.ts:2: cites D${999}, which docs/DECISIONS.md has no entry for`]);
  });

  test('only whole D-numbers count, not hex colours, longer words or 3D', () => {
    assert.deepEqual(checkCitations([{ path: 'a.css', text: 'color: #D3D3D3; 3D; ID12; D12x; AD12\n' }], new Set()), []);
  });

  test('third-party, generated and fixture files are not citations', () => {
    for (const path of ['apps/server/src/x.ts', 'docs/TRACEABILITY.md', 'apps/server/src/db/migrations/001_init.sql', '.github/workflows/check.yml', 'apps/mobile/targets/widget/Widget.swift']) assert.ok(isCitationSource(path), path);
    for (const path of ['fixtures/book.epub', 'fixtures/notes.md', 'patches/expo-audio.patch', 'apps/web/public/pdf.js', 'pnpm-lock.yaml', 'apps/web/src/logo.png']) assert.ok(!isCitationSource(path), path);
  });
});

describe('a whole tree', () => {
  test('this repository’s numbering is sound', () => {
    assert.deepEqual(checkTree().problems, []);
  });

  test('the command passes a sound tree and fails, naming each problem, on one that is not', () => {
    const good = cli(repo(sound).dir);
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /Numbering sound: 2 migrations, 2 decisions\./);

    const bad = repo({
      ...sound,
      'apps/server/src/db/migrations/002_other.sql': 'CREATE TABLE c (x);\n',
      'docs/DECISIONS.md': sound['docs/DECISIONS.md'] + '\n## D2. Also two\n',
      'apps/web/src/a.tsx': '// as D7 says\n',
    });
    const failed = cli(bad.dir);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /migration 002 is taken 2 times/);
    assert.match(failed.stderr, /D2 has 2 entries/);
    assert.match(failed.stderr, /apps\/web\/src\/a\.tsx:1: cites D7/);
  });

  test('a new file not yet added is read too; an ignored one is not', () => {
    const { dir } = repo({ ...sound, '.gitignore': 'out/\n' });
    writeFileSync(join(dir, 'new.ts'), '// D8\n');
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'out/built.js'), '// D9\n');
    const problems = checkTree(dir).problems;
    assert.deepEqual(problems, ['new.ts:1: cites D8, which docs/DECISIONS.md has no entry for']);
  });

  test('an unknown argument is refused', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
  });
});

describe('the next free numbers', () => {
  const master = { label: 'master', migrations: [{ number: 1, name: '001_init.sql' }, { number: 2, name: '002_b.sql' }], decisions: [{ number: 1, name: 'One' }, { number: 3, name: 'Three' }] };

  test('are one past the highest anyone has taken, open pull requests included', () => {
    const pr = { label: '#9 next book', migrations: [...master.migrations, { number: 3, name: '003_next_book.sql' }], decisions: [...master.decisions, { number: 4, name: 'Nominations' }, { number: 5, name: 'Rounds' }] };
    const r = nextNumbers([master, pr]);
    assert.equal(r.migrations.next, 4);
    assert.equal(r.decisions.next, 6);
    assert.deepEqual([r.migrations.collisions, r.decisions.collisions], [[], []]);
  });

  test('name a number two branches each claim for different things, and who claims what', () => {
    const tree = { label: 'this tree', migrations: [...master.migrations, { number: 3, name: '003_club_plans.sql' }], decisions: [...master.decisions, { number: 4, name: 'Plans' }] };
    const prA = { ...tree, label: '#8 plans' }; // this tree's own pull request: the same claims, no collision
    const prB = { label: '#10 questions', migrations: [...master.migrations, { number: 3, name: '003_questions.sql' }], decisions: [...master.decisions, { number: 4, name: 'Questions' }] };
    const r = nextNumbers([master, tree, prA, prB]);
    assert.deepEqual(r.migrations.collisions, [{ number: 3, claims: [{ name: '003_club_plans.sql', labels: ['this tree', '#8 plans'] }, { name: '003_questions.sql', labels: ['#10 questions'] }] }]);
    assert.deepEqual(r.decisions.collisions.map((c) => [c.number, c.claims.map((x) => x.name)]), [[4, ['Plans', 'Questions']]]);
    assert.equal(r.migrations.next, 4);
  });

  test('a branch’s numbers are read from git without checking it out', () => {
    const { dir, write, head } = repo(sound);
    const branch = write({ 'apps/server/src/db/migrations/003_new.sql': 'CREATE TABLE n (x);\n', 'docs/DECISIONS.md': sound['docs/DECISIONS.md'] + '\n## D3. New\n' });
    assert.deepEqual(numbersAt(head, dir).migrations.map((m) => m.name), ['001_init.sql', '002_more.sql']);
    assert.deepEqual(numbersAt(branch, dir).migrations.map((m) => m.name), ['001_init.sql', '002_more.sql', '003_new.sql']);
    assert.deepEqual(numbersAt(branch, dir).decisions.map((d) => [d.number, d.name]), [[1, 'One origin'], [2, 'Two'], [3, 'New']]);
  });

  test('a branch from before either series existed holds no numbers', () => {
    const { dir, head } = repo({ 'README.md': 'early\n' });
    assert.deepEqual(numbersAt(head, dir), { migrations: [], decisions: [] });
  });
});
