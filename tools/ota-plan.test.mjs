// Tests for tools/ota-plan.mjs's classifier (skip | update | build), the dependency-sensitive vs.
// mobile-JS fingerprint gates, the live-build runtime check, and its git helpers.
// `node --test tools/ota-plan.test.mjs` -- node:test and node:assert are Node built-ins, so this
// needs nothing installed (tools/ is typechecked but not a pnpm workspace package). Run from the
// repo root, where check.yml and scripts/test-ci.sh both invoke it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { changedFiles, classify, EMPTY_TREE, FIRST_COMMIT_PLAN, fingerprintDiffers, liveRuntimeMatches, needsFingerprintCheck, pathPlan, planBase, REPO_ROOT, resolveBase } from './ota-plan.mjs';

function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A scratch repository with a known history (a root commit and one more), so the git helpers are
 * tested the same way in any clone of this one: a shallow CI checkout or a repository whose own
 * history is a single commit has no HEAD~1 to lean on.
 */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ota-plan-test-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const run = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
  run(['init', '-q', '-b', 'master']);
  mkdirSync(join(dir, 'apps/mobile'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}\n');
  writeFileSync(join(dir, 'apps/mobile/app.config.ts'), 'export default {};\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'first']);
  const root = run(['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'apps/mobile/App.tsx'), 'export {};\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'second']);
  return { dir, root, head: run(['rev-parse', 'HEAD']) };
}

describe('classify: no mobile-relevant change', () => {
  test('no files changed', () => {
    assert.equal(classify([], undefined).decision, 'skip');
  });

  test('web, server and e2e files only', () => {
    const plan = classify(['apps/web/src/player/ListenPage.tsx', 'apps/server/src/routes/listening.ts', 'e2e/tests/audio.spec.ts', 'docs/DECISIONS.md'], undefined);
    assert.equal(plan.decision, 'skip');
    assert.deepEqual(plan.files, []);
  });

  test('tests and docs inside apps/mobile do not count, even alongside each other', () => {
    const plan = classify(['apps/mobile/src/audio/NativeAudioEngine.test.ts', 'apps/mobile/test/app-config.test.ts', 'apps/mobile/README.md'], undefined);
    assert.equal(plan.decision, 'skip');
  });
});

describe('classify: native-sensitive paths always need a build, unconditionally', () => {
  const nativeSensitivePaths = [
    'apps/mobile/plugins/with-manual-signing.ts',
    'apps/mobile/modules/book-club-native/ios/BookClubNativeModule.swift',
    'apps/mobile/targets/widgets/CurrentBookWidget.swift',
    'apps/mobile/app.config.ts',
    'apps/mobile/fingerprint.config.js',
    'apps/mobile/eas.json',
  ];

  for (const path of nativeSensitivePaths) {
    test(`${path} alone`, () => {
      const plan = classify([path], undefined);
      assert.equal(plan.decision, 'build');
      assert.deepEqual(plan.files, [path]);
      assert.equal(plan.fingerprintChecked, false);
      // Even a confirmed-unchanged fingerprint cannot clear it: no fingerprintChanged value flips this.
      assert.equal(classify([path], false).decision, 'build');
      assert.equal(classify([path], true).decision, 'build');
    });
  }

  test('wins over a JS change in the same commit, and never needs the fingerprint', () => {
    const plan = classify(['apps/mobile/app.config.ts', 'apps/mobile/src/audio/NativeAudioEngine.ts'], undefined);
    assert.equal(plan.decision, 'build');
    assert.deepEqual(plan.files, ['apps/mobile/app.config.ts']);
  });

  test('a native-sensitive path that is also a test file does not count (filtered first)', () => {
    const plan = classify(['apps/mobile/modules/book-club-native/index.test.ts'], undefined);
    assert.equal(plan.decision, 'skip');
  });
});

describe('classify: dependency-sensitive paths are fingerprint-gated, not an unconditional build', () => {
  const dependencySensitivePaths = ['apps/mobile/package.json', 'patches/expo-audio@58.0.10.patch', 'pnpm-lock.yaml'];

  for (const path of dependencySensitivePaths) {
    test(`${path} alone: not "build" from the path filter (fingerprintChecked: false) by itself`, () => {
      const plan = classify([path], undefined);
      assert.notEqual(plan.decision, 'skip'); // still worth checking -- it *can* touch a native dep
      assert.equal(plan.fingerprintChecked, false);
    });

    test(`${path} alone, fingerprint unchanged: skip -- no mobile JS shipped either way`, () => {
      const plan = classify([path], false);
      assert.equal(plan.decision, 'skip');
      assert.equal(plan.fingerprintChecked, true);
    });

    test(`${path} alone, fingerprint moved anyway: build`, () => {
      const plan = classify([path], true);
      assert.equal(plan.decision, 'build');
      assert.equal(plan.fingerprintChecked, true);
    });

    test(`${path} plus a mobile JS change, fingerprint unchanged: update (mobile JS did ship)`, () => {
      const plan = classify([path, 'apps/mobile/src/config.ts'], false);
      assert.equal(plan.decision, 'update');
      assert.deepEqual(plan.files.sort(), [path, 'apps/mobile/src/config.ts'].sort());
    });
  }

  // The regression this bucket exists for: a web-only dependency bump still rewrites the shared
  // lockfile, and must not fail the job with a false "new build needed".
  test('web dep bump: lockfile only -> fingerprint-gated, not build', () => {
    const plan = classify(['apps/server/package.json', 'pnpm-lock.yaml'], undefined);
    assert.notEqual(plan.decision, 'build');
    assert.equal(needsFingerprintCheck(['apps/server/package.json', 'pnpm-lock.yaml']), true);
    // Once the real check (no mobile JS, so the server bump cannot have moved the iOS fingerprint)
    // comes back unchanged, it resolves to skip, never build.
    assert.equal(classify(['apps/server/package.json', 'pnpm-lock.yaml'], false).decision, 'skip');
  });
});

describe('pathPlan / needsFingerprintCheck', () => {
  test('native-sensitive and irrelevant changes never need the fingerprint', () => {
    assert.equal(needsFingerprintCheck(['apps/mobile/app.config.ts']), false);
    assert.equal(needsFingerprintCheck(['apps/web/src/pages/BookPage.tsx']), false);
    assert.equal(needsFingerprintCheck([]), false);
  });

  test('dependency-sensitive and mobile JS changes do, and say whether base needs its own install', () => {
    assert.equal(needsFingerprintCheck(['apps/mobile/src/config.ts']), true);
    assert.equal(pathPlan(['apps/mobile/src/config.ts']).installAtBase, false);
    assert.equal(needsFingerprintCheck(['pnpm-lock.yaml']), true);
    assert.equal(pathPlan(['pnpm-lock.yaml']).installAtBase, true);
  });
});

describe('classify: JS-only changes go through the fingerprint gate', () => {
  const jsPaths = ['apps/mobile/src/audio/NativeAudioEngine.ts', 'apps/mobile/App.tsx', 'apps/mobile/index.ts', 'apps/mobile/assets/icon.png', 'packages/shared/src/format.ts'];

  for (const path of jsPaths) {
    test(`${path}: update when fingerprint is confirmed unchanged`, () => {
      const plan = classify([path], false);
      assert.equal(plan.decision, 'update');
      assert.equal(plan.fingerprintChecked, true);
    });

    test(`${path}: build when the fingerprint moved anyway`, () => {
      const plan = classify([path], true);
      assert.equal(plan.decision, 'build');
      assert.equal(plan.fingerprintChecked, true);
      assert.match(plan.reason, /fingerprint/);
    });
  }

  test('not computed (no --fingerprint): still a usable decision, but says so', () => {
    const plan = classify(['apps/mobile/src/config.ts'], undefined);
    assert.equal(plan.decision, 'update');
    assert.equal(plan.fingerprintChecked, false);
    assert.match(plan.reason, /path filter only/);
  });

  test('a mobile JS change plus an unrelated web change: still just the mobile file decides', () => {
    const plan = classify(['apps/mobile/src/config.ts', 'apps/web/src/pages/BookPage.tsx'], false);
    assert.equal(plan.decision, 'update');
    assert.deepEqual(plan.files, ['apps/mobile/src/config.ts']);
  });
});

describe('resolveBase', () => {
  /** @type {ReturnType<typeof scratchRepo>} */
  let repo;
  before(() => {
    repo = scratchRepo();
  });
  after(() => rmSync(repo.dir, { recursive: true, force: true }));

  test('a real commit is used as-is', () => {
    assert.equal(resolveBase(repo.head, repo.head, repo.dir), repo.head);
    assert.equal(resolveBase(repo.root, repo.head, repo.dir), repo.root);
  });

  test('empty falls back to head~1', () => {
    assert.equal(resolveBase('', repo.head, repo.dir), repo.root);
    assert.equal(resolveBase(undefined, repo.head, repo.dir), repo.root);
  });

  test('the all-zeros sentinel (a branch\'s first push) falls back to head~1', () => {
    assert.equal(resolveBase('0'.repeat(40), repo.head, repo.dir), repo.root);
  });

  test('a sha this clone does not have falls back to head~1, not an error', () => {
    assert.equal(resolveBase('1234567890123456789012345678901234567890', repo.head, repo.dir), repo.root);
  });

  test('a head with no parent falls back to the empty tree', () => {
    assert.equal(resolveBase('', repo.root, repo.dir), EMPTY_TREE);
  });
});

describe('planBase: a repository\'s first commit', () => {
  /** @type {ReturnType<typeof scratchRepo>} */
  let repo;
  before(() => {
    repo = scratchRepo();
  });
  after(() => rmSync(repo.dir, { recursive: true, force: true }));

  test('a head with no parent and no usable before is a first commit', () => {
    for (const before of ['', '0'.repeat(40), '1234567890123456789012345678901234567890', undefined]) {
      assert.deepEqual(planBase({ before, head: repo.root }, repo.dir), { base: EMPTY_TREE, firstCommit: true });
    }
  });

  test('a head with a parent is not, and neither is an explicit base, even the empty tree', () => {
    assert.deepEqual(planBase({ before: '', head: repo.head }, repo.dir), { base: repo.root, firstCommit: false });
    assert.deepEqual(planBase({ before: repo.root, head: repo.head }, repo.dir), { base: repo.root, firstCommit: false });
    assert.deepEqual(planBase({ base: EMPTY_TREE, head: repo.root }, repo.dir), { base: EMPTY_TREE, firstCommit: false });
  });

  test('a first commit publishes nothing, and says how to publish by hand', () => {
    assert.equal(FIRST_COMMIT_PLAN.decision, 'skip');
    assert.deepEqual(FIRST_COMMIT_PLAN.files, []);
    assert.equal(FIRST_COMMIT_PLAN.fingerprintChecked, false);
    assert.match(FIRST_COMMIT_PLAN.reason, /first commit/);
    assert.match(FIRST_COMMIT_PLAN.reason, /-f base=/);
  });
});

describe('changedFiles', () => {
  /** @type {ReturnType<typeof scratchRepo>} */
  let repo;
  before(() => {
    repo = scratchRepo();
  });
  after(() => rmSync(repo.dir, { recursive: true, force: true }));

  test('matches a plain `git diff --name-only` for the same range', () => {
    const expected = git(['diff', '--name-only', repo.root, repo.head], repo.dir)
      .split('\n')
      .filter(Boolean);
    assert.deepEqual(expected, ['apps/mobile/App.tsx']);
    assert.deepEqual(changedFiles(repo.root, repo.head, repo.dir), expected);
  });

  test('diffing against the empty tree lists every tracked file at HEAD', () => {
    const files = changedFiles(EMPTY_TREE, 'HEAD');
    assert.ok(files.includes('package.json'));
    assert.ok(files.includes('apps/mobile/app.config.ts'));
  });
});

describe('fingerprintDiffers (integration: real git worktrees + the installed expo-updates resolver)', { timeout: 60_000 }, () => {
  test('the same commit against itself never differs', (t) => {
    if (!existsSync(join(REPO_ROOT, 'apps/mobile/node_modules')) || !existsSync(join(REPO_ROOT, 'node_modules'))) {
      t.skip('apps/mobile/node_modules is not installed (run `pnpm install` first)');
      return;
    }
    const result = fingerprintDiffers('HEAD', 'HEAD');
    assert.equal(result.changed, false);
    assert.equal(result.baseVersion, result.headVersion);
    assert.match(result.baseVersion, /^[0-9a-f]{40}$/);
  });
});

describe('fingerprintDiffers with installAtBase (integration: a real, scoped `pnpm install` at base)', { timeout: 180_000 }, () => {
  test('the same commit against itself still never differs, reinstalled or not', (t) => {
    if (!existsSync(join(REPO_ROOT, 'apps/mobile/node_modules')) || !existsSync(join(REPO_ROOT, 'node_modules'))) {
      t.skip('apps/mobile/node_modules is not installed (run `pnpm install` first)');
      return;
    }
    const reused = fingerprintDiffers('HEAD', 'HEAD');
    const reinstalled = fingerprintDiffers('HEAD', 'HEAD', { installAtBase: true });
    assert.equal(reinstalled.changed, false);
    // A real install of the very same lockfile/package.json resolves the same runtime version as
    // reusing the caller's own node_modules would -- the point of installAtBase is correctness
    // when base's dependencies differ, not a different answer when they do not.
    assert.equal(reinstalled.baseVersion, reused.baseVersion);
  });
});

describe('liveRuntimeMatches', () => {
  test('matches: the live build is the authority, not the base-vs-head comparison', () => {
    const result = liveRuntimeMatches('abc123', 'abc123');
    assert.equal(result.ok, true);
  });

  test('unset (no repo variable yet): never matches', () => {
    assert.equal(liveRuntimeMatches('abc123', undefined).ok, false);
    assert.equal(liveRuntimeMatches('abc123', '').ok, false);
    assert.equal(liveRuntimeMatches('abc123', '   ').ok, false);
  });

  test('different: the resolver can disagree with the live build for the very same commit', () => {
    const result = liveRuntimeMatches('4c2977d2f9d9ad39d9bd6b2b43901e1b83112b28', 'eb9351e01c4282a3ea5b58f724cbbc8b36055f49');
    assert.equal(result.ok, false);
    assert.equal(result.live, 'eb9351e01c4282a3ea5b58f724cbbc8b36055f49');
    assert.equal(result.head, '4c2977d2f9d9ad39d9bd6b2b43901e1b83112b28');
  });
});
