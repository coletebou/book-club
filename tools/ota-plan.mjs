#!/usr/bin/env node
// Decides what a change should do to the iOS app's EAS Update channel (D180):
//   skip    no mobile-relevant file changed -- nothing to ship
//   update  only the app's own JavaScript changed -- `eas update` reaches installed builds
//   build   something native-sensitive changed, the real iOS fingerprint (runtime version) moved
//           even though no path looked native-sensitive, or (with --live-runtime) the live
//           build's own runtime does not match what this publish would carry -- a new build is
//           needed instead
//
// The path filter (classify, below) is a fast, pure, dependency-free guess from a changed-file
// list alone, in three buckets: native-sensitive (a native module, a config plugin, eas.json, or
// the widget/Live Activity extension) is an unconditional build; dependency-sensitive
// (apps/mobile/package.json, a root patch, or the lockfile, which every workspace shares, so a
// web- or server-only bump touches it too) and mobile JS (apps/mobile's own src/App.tsx/index.ts,
// its assets, and the @bookclub/shared source it bundles) both need the fingerprint comparison
// (fingerprintDiffers) to decide for real -- the authoritative check D180 already uses for the
// same purpose (fingerprint.config.js, README.md "OTA update, or a new native build?"): it
// resolves the real runtime version at two commits with expo-updates' own resolver and compares
// the hashes, which also catches what the path filter cannot (e.g. an icon or splash asset).
// Unlike mobile JS, a dependency-sensitive change needs base's *own* install to check accurately
// (installAtBase), since the dependency tree itself may differ from what is already installed.
//
// Even an "update" the fingerprint comparison clears is not guaranteed to reach the live build:
// the resolver can give a different value for the very same commit depending on small environment
// differences between where a build was archived and where this runs (liveRuntimeMatches's doc
// comment; measured directly on TestFlight 1.0.0 (4)'s own archive commit). --live-runtime adds
// that last, authoritative gate against the live build's own embedded runtime version.
//
// CLI:
//   node tools/ota-plan.mjs --base <sha> --head <sha> [--fingerprint] [--live-runtime <sha>] [--json]
//   node tools/ota-plan.mjs --before <sha-or-empty> --head <sha> [--fingerprint] [--live-runtime <sha>] [--json]
//
// --base is an explicit base commit. --before is `github.event.before` as GitHub Actions gives
// it: empty or all-zeros (a branch's first push, or a force-push GitHub can't diff) falls back to
// head~1, and failing that to git's empty-tree hash, so a plan is always produced. Exactly one of
// --base/--before is required. --fingerprint runs the real (slow: one or two `git worktree add`s,
// one with its own `pnpm install`, plus the expo-updates resolver) comparison when the path filter
// alone could not already decide; without it, the tool reports the path-only verdict and says so.
// --live-runtime (see above) only matters once the decision is otherwise "update". If
// $GITHUB_OUTPUT is set, `decision` and `reason` are also appended there, so a workflow step needs
// no separate JSON parsing.
//
// Dependency-free (tools/ is typechecked but not installed into): only Node built-ins.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// The hash of an empty git tree (`git hash-object -t tree /dev/null`), the same on every repo:
// diffing against it treats every tracked file as changed, the safe fallback when there is truly
// no earlier commit to diff from.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// --- path classification ---------------------------------------------------------------------

// Changing any of these needs a new build, unconditionally -- no fingerprint can clear it, because
// there is no way these leave the native build unaffected: a native module or its Swift/podspec, a
// config plugin, the widget/Live Activity extension, or eas.json's build profiles.
const NATIVE_SENSITIVE = [
  /^apps\/mobile\/plugins\//,
  /^apps\/mobile\/modules\//,
  /^apps\/mobile\/targets\//,
  /^apps\/mobile\/app\.config\.ts$/,
  /^apps\/mobile\/fingerprint\.config\.js$/,
  /^apps\/mobile\/eas\.json$/,
];

// These *can* change a native dependency -- apps/mobile's own package.json (any `expo-*`/
// `react-native-*` bump or addition is native), the root patch set (patches/, e.g. the
// expo-audio patch), or the lockfile (shared by every workspace, so a web- or server-only
// dependency bump touches it too) -- but often don't (a web-only `pnpm add` still rewrites
// pnpm-lock.yaml). Unlike NATIVE_SENSITIVE, the fingerprint has the final say here: it is only
// accurate when computed from each commit's *own* installed dependencies, so base needs a real
// `pnpm install` at its own lockfile/package.json rather than reusing head's node_modules
// (fingerprintDiffers' installAtBase).
const DEPENDENCY_SENSITIVE = [/^apps\/mobile\/package\.json$/, /^patches\//, /^pnpm-lock\.yaml$/];

// The app's own JavaScript/TypeScript (src/, App.tsx, index.ts), its assets (the icon and splash
// are hashed into the fingerprint, not skipped here -- the fingerprint check is what actually
// clears or flags them), and @bookclub/shared's source, which apps/mobile bundles
// (apps/mobile/package.json: "@bookclub/shared": "workspace:*"). None of this is native-sensitive
// by itself, but the fingerprint still has the final say (see the module doc above).
const MOBILE_JS = [/^apps\/mobile\/src\//, /^apps\/mobile\/App\.tsx$/, /^apps\/mobile\/index\.ts$/, /^apps\/mobile\/assets\//, /^packages\/shared\/src\//];

// Tests and docs inside apps/mobile (or packages/shared) ship nothing and must not move the
// decision either way (requirement: "Tests/docs-only changes ... must not trigger an OTA").
const TEST_OR_DOCS = [/\.test\.tsx?$/, /\.test\.jsx?$/, /(^|\/)test\//, /(^|\/)README\.md$/i];

function isTestOrDocs(file) {
  return TEST_OR_DOCS.some((re) => re.test(file));
}

/**
 * The path filter alone, before any fingerprint is involved: which bucket a changed-file list
 * falls into, and (for 'needs-fingerprint') whether an accurate check needs base's own install
 * rather than reusing head's.
 *
 * @param {string[]} changedFiles
 */
export function pathPlan(changedFiles) {
  const relevant = changedFiles.filter((f) => !isTestOrDocs(f));

  const nativeSensitive = relevant.filter((f) => NATIVE_SENSITIVE.some((re) => re.test(f)));
  if (nativeSensitive.length > 0) return { kind: 'native-sensitive', files: nativeSensitive };

  const dependencySensitive = relevant.filter((f) => DEPENDENCY_SENSITIVE.some((re) => re.test(f)));
  const mobileJs = relevant.filter((f) => MOBILE_JS.some((re) => re.test(f)));
  if (dependencySensitive.length === 0 && mobileJs.length === 0) return { kind: 'irrelevant', files: [] };

  return { kind: 'needs-fingerprint', dependencySensitive, mobileJs, files: [...dependencySensitive, ...mobileJs], installAtBase: dependencySensitive.length > 0 };
}

/**
 * Whether classify(changedFiles, undefined) would benefit from a real fingerprint comparison --
 * i.e. the path filter alone was not already conclusive (skip, or an unconditional build).
 * @param {string[]} changedFiles
 */
export function needsFingerprintCheck(changedFiles) {
  return pathPlan(changedFiles).kind === 'needs-fingerprint';
}

/**
 * @typedef {{ decision: 'skip' | 'update' | 'build', reason: string, files: string[], fingerprintChecked: boolean }} Plan
 */

/**
 * Pure classifier: a changed-file list (repo-relative, forward slashes, as `git diff --name-only`
 * gives them) plus an optional real fingerprint comparison decides skip | update | build.
 *
 * @param {string[]} changedFiles
 * @param {boolean | undefined} fingerprintChanged whether the real iOS fingerprint (runtime
 *   version) differs between base and head. Omit when it was not computed -- either the path
 *   filter already decided without needing it (skip, or an unconditional build), or it is a fast
 *   dry run that only wants the path-only verdict.
 * @returns {Plan}
 */
export function classify(changedFiles, fingerprintChanged) {
  const plan = pathPlan(changedFiles);

  if (plan.kind === 'native-sensitive') {
    return {
      decision: 'build',
      reason: 'native-sensitive path(s) changed (a native module, a config plugin, eas.json, or the widget/Live Activity extension): a new build is needed',
      files: plan.files,
      fingerprintChecked: false,
    };
  }

  if (plan.kind === 'irrelevant') {
    return { decision: 'skip', reason: 'no mobile JS, dependency, or native-sensitive files changed', files: [], fingerprintChecked: false };
  }

  const hasMobileJs = plan.mobileJs.length > 0;
  const dependencyNote = plan.dependencySensitive.length > 0 ? ' (apps/mobile/package.json, a root patch, or the lockfile changed, so the base commit needed its own install to check accurately)' : '';

  if (fingerprintChanged === true) {
    return {
      decision: 'build',
      reason: `the iOS fingerprint (runtime version) differs between base and head${dependencyNote || ' even though no changed path looked native-sensitive'}: a new build is needed`,
      files: plan.files,
      fingerprintChecked: true,
    };
  }
  if (fingerprintChanged === false) {
    if (hasMobileJs) {
      return { decision: 'update', reason: `mobile JS changed and the iOS fingerprint (runtime version) is unchanged${dependencyNote}: ship an EAS Update`, files: plan.files, fingerprintChecked: true };
    }
    return { decision: 'skip', reason: `a dependency or lockfile change could have affected the native build, but the iOS fingerprint is unchanged${dependencyNote} and no mobile JS shipped: nothing to update`, files: plan.files, fingerprintChecked: true };
  }
  return {
    decision: 'update',
    reason: `${hasMobileJs ? 'mobile JS changed' : 'a dependency or lockfile change could affect the native build'} (path filter only: pass --fingerprint for the authoritative runtime-version check)`,
    files: plan.files,
    fingerprintChecked: false,
  };
}

// --- git plumbing -----------------------------------------------------------------------------

function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * The safe base commit for a push's diff: `before` as GitHub gives it (`github.event.before`),
 * unless it is empty or the all-zeros sentinel (a branch's first push, or a force-push GitHub
 * cannot diff), in which case this falls back to `head~1`, and from there to the empty-tree hash
 * if `head` itself has no parent. Always returns a diffable ref.
 *
 * @param {string | undefined} before
 * @param {string} head
 * @param {string} [cwd] the repository (this one by default; the tests use a scratch one)
 */
export function resolveBase(before, head, cwd = REPO_ROOT) {
  const trimmed = (before ?? '').trim();
  if (trimmed && !/^0+$/.test(trimmed)) {
    try {
      git(['cat-file', '-e', `${trimmed}^{commit}`], cwd);
      return trimmed;
    } catch {
      // not a commit this clone has (e.g. a shallow checkout, or before predates history we
      // fetched) -- fall through to the same fallback as a missing `before`.
    }
  }
  try {
    return git(['rev-parse', `${head}~1`], cwd).trim();
  } catch {
    return EMPTY_TREE;
  }
}

/**
 * What a plan diffs from: an explicit `--base` as given, or `--before` resolved as above, and
 * whether that resolution ran out of history, i.e. `head` is the repository's first commit
 * (nothing given, or nothing usable, and no parent). Only the latter counts as a first commit: an
 * explicit `--base` of the empty tree is a deliberate "everything", and is classified as such.
 *
 * @param {{ base?: string, before?: string, head: string }} args
 * @param {string} [cwd]
 * @returns {{ base: string, firstCommit: boolean }}
 */
export function planBase(args, cwd = REPO_ROOT) {
  if (args.base != null) return { base: args.base, firstCommit: false };
  const base = resolveBase(args.before, args.head, cwd);
  return { base, firstCommit: base === EMPTY_TREE };
}

/**
 * The plan for a repository's first commit. Diffed against the empty tree, every file would count
 * as changed and the answer would always be "build", which says nothing about what the installed
 * build actually runs (a repository that starts from an existing app's code, say). So nothing is
 * published automatically, and the reason says how to publish against a known base by hand.
 * @type {Plan}
 */
export const FIRST_COMMIT_PLAN = Object.freeze({
  decision: 'skip',
  reason: "head is the repository's first commit: there is no earlier commit to compare it with, so no update is published automatically (run this by hand with an explicit base, e.g. `gh workflow run ota-update.yml -f base=<commit> -f dry_run=false`, to publish one)",
  files: [],
  fingerprintChecked: false,
});

/** @returns {string[]} repo-relative paths changed between base and head, base and head included. */
export function changedFiles(base, head, cwd = REPO_ROOT) {
  return git(['diff', '--name-only', base, head], cwd)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// The same environment a production-channel publish runs under (publish-update.sh pins
// BOOKCLUB_APS_ENVIRONMENT=production; BOOKCLUB_SERVER_URL is left at its default, which is also
// what that script sets explicitly for "production"), held fixed across every ref this resolves
// so only a commit's own file content -- never an environment difference -- can move the hash.
export const PRODUCTION_ENV = { BOOKCLUB_APS_ENVIRONMENT: 'production' };

/**
 * The real iOS fingerprint (runtime version) at one commit, computed with the installed
 * `expo-updates` CLI, the same resolver Xcode's build phase and `eas update` run, inside a
 * disposable `git worktree` (sharing this clone's objects).
 *
 * @param {string} ref
 * @param {Record<string, string>} env
 * @param {{ installOwnDeps?: boolean }} [options] installOwnDeps: run a real, scoped
 *   `pnpm install --frozen-lockfile` inside the worktree against *this ref's own*
 *   package.json/pnpm-lock.yaml/patches, instead of reusing the caller's already-installed
 *   node_modules. Needed whenever apps/mobile/package.json, a root patch, or the lockfile
 *   differs from what is already installed (DEPENDENCY_SENSITIVE): reusing node_modules
 *   installed for different dependency versions would silently evaluate app.config.ts (and
 *   autolink its native modules) against the wrong package set. Slower, but only taken when the
 *   path filter says it is actually needed, and it reuses the shared pnpm store, so only truly
 *   new/changed packages are fetched.
 */
export function runtimeVersionAt(ref, env, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ota-plan-'));
  try {
    git(['worktree', 'add', '--detach', dir, ref]);
    try {
      if (options.installOwnDeps) {
        execFileSync('pnpm', ['--filter', '@bookclub/mobile...', 'install', '--frozen-lockfile'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      } else {
        const rootNodeModules = join(REPO_ROOT, 'node_modules');
        const mobileNodeModules = join(REPO_ROOT, 'apps/mobile/node_modules');
        if (!existsSync(rootNodeModules) || !existsSync(mobileNodeModules)) {
          throw new Error('apps/mobile has no installed node_modules; run `pnpm install` first (the fingerprint check reuses the caller\'s install for every ref it resolves, unless installOwnDeps is set)');
        }
        symlinkSync(rootNodeModules, join(dir, 'node_modules'));
        symlinkSync(mobileNodeModules, join(dir, 'apps/mobile/node_modules'));
      }
      const cli = join(dir, 'apps/mobile/node_modules/expo-updates/bin/cli.js');
      const out = execFileSync(process.execPath, [cli, 'runtimeversion:resolve', '--platform', 'ios'], {
        cwd: join(dir, 'apps/mobile'),
        encoding: 'utf8',
        env: { ...process.env, ...env },
        maxBuffer: 16 * 1024 * 1024,
      });
      const last = out.trim().split('\n').at(-1) ?? '';
      const parsed = JSON.parse(last);
      if (typeof parsed.runtimeVersion !== 'string') throw new Error(`expo-updates did not resolve a runtime version for ${ref}: ${last}`);
      return parsed.runtimeVersion;
    } finally {
      git(['worktree', 'remove', '--force', dir]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Compares the real iOS fingerprint (runtime version) at base and head.
 * @param {string} base
 * @param {string} head
 * @param {{ installAtBase?: boolean }} [options] see runtimeVersionAt's installOwnDeps: base
 *   needs its own install whenever a dependency-sensitive file (apps/mobile/package.json, a root
 *   patch, or the lockfile) changed between base and head. head always reuses the caller's own
 *   install, which in the real workflow *is* head's own (that is what it just checked out and
 *   ran `pnpm install` against).
 */
export function fingerprintDiffers(base, head, options = {}) {
  const baseVersion = runtimeVersionAt(base, PRODUCTION_ENV, { installOwnDeps: options.installAtBase ?? false });
  const headVersion = runtimeVersionAt(head, PRODUCTION_ENV);
  return { changed: baseVersion !== headVersion, baseVersion, headVersion };
}

/**
 * Whether an "update" is actually safe to publish: the installed TestFlight build's own runtime
 * version (set once per upload from its .ipa's own EXUpdates.bundle/fingerprint -- ground truth,
 * never re-derived) must equal what this publish will carry. The base-vs-head fingerprint
 * comparison alone does not prove this: the resolver can give a different value for the very same
 * commit depending on small environment differences between where a build was archived and where
 * this runs (D180's README documents several already) -- measured directly: the commit TestFlight
 * 1.0.0 (4) was archived from resolves to a different hash here than that .ipa's own embedded one.
 *
 * @param {string} headRuntimeVersion what `eas update` will publish this commit under
 * @param {string | undefined} liveRuntimeVersion the live build's own; empty/undefined means unset
 */
export function liveRuntimeMatches(headRuntimeVersion, liveRuntimeVersion) {
  const live = (liveRuntimeVersion ?? '').trim();
  return { ok: live !== '' && live === headRuntimeVersion, live, head: headRuntimeVersion };
}

// --- CLI ---------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { fingerprint: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--base':
        args.base = argv[++i];
        break;
      case '--before':
        args.before = argv[++i];
        break;
      case '--head':
        args.head = argv[++i];
        break;
      case '--fingerprint':
        args.fingerprint = true;
        break;
      case '--live-runtime':
        args.liveRuntime = argv[++i];
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  return args;
}

const USAGE = `usage: node tools/ota-plan.mjs (--base <sha> | --before <sha-or-empty>) --head <sha> [--fingerprint] [--live-runtime <sha-or-empty>] [--json]

  --base <sha>        an explicit base commit to diff from
  --before <sha>      github.event.before; falls back to head~1 (then the empty tree) when empty
                       or all-zeros
  --head <sha>        the commit being evaluated (required)
  --fingerprint       also run the real iOS fingerprint (runtime version) check when the path
                       filter alone would say "update" -- needs apps/mobile/node_modules installed
  --live-runtime <v>  the installed TestFlight build's own runtime version (its .ipa's
                       EXUpdates.bundle/fingerprint; a repo variable in CI,
                       vars.IOS_LIVE_RUNTIME_VERSION). When given, a would-be "update" also needs
                       this to equal head's own resolved runtime version, or it becomes "build"
                       instead -- the base-vs-head fingerprint comparison alone does not prove an
                       update reaches the live build (see liveRuntimeMatches's doc comment).
                       Empty or omitted skips this check.
  --json              print one JSON object instead of the human-readable report

Exactly one of --base/--before is required. Always exits 0 on a successful plan (including
"build"): a calling workflow decides what to do with the decision, this tool only makes it.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!args.head) throw new Error(`--head is required\n\n${USAGE}`);
  if ((args.base == null) === (args.before == null)) throw new Error(`exactly one of --base/--before is required\n\n${USAGE}`);

  const { base, firstCommit } = planBase(args);
  const files = changedFiles(base, args.head);
  let plan = firstCommit ? { ...FIRST_COMMIT_PLAN } : classify(files, undefined);
  let fingerprint;

  if (!firstCommit && args.fingerprint && needsFingerprintCheck(files)) {
    fingerprint = fingerprintDiffers(base, args.head, { installAtBase: pathPlan(files).installAtBase });
    plan = classify(files, fingerprint.changed);
  }

  let liveRuntime;
  if (plan.decision === 'update' && args.liveRuntime !== undefined) {
    const headVersion = fingerprint ? fingerprint.headVersion : runtimeVersionAt(args.head, PRODUCTION_ENV);
    liveRuntime = liveRuntimeMatches(headVersion, args.liveRuntime);
    if (!liveRuntime.ok) {
      plan = {
        decision: 'build',
        reason: `the live build's runtime version (${liveRuntime.live || 'unset'}) does not match what this publish would carry (${liveRuntime.head}): new build needed (or the variable is stale)`,
        files: plan.files,
        fingerprintChecked: plan.fingerprintChecked,
      };
    }
  }

  const result = { ...plan, base, head: args.head, changedFiles: files, ...(fingerprint ? { fingerprint } : {}), ...(liveRuntime ? { liveRuntime } : {}) };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`decision: ${result.decision}\n`);
    process.stdout.write(`reason: ${result.reason}\n`);
    process.stdout.write(`base: ${result.base}\n`);
    process.stdout.write(`head: ${result.head}\n`);
    process.stdout.write(`fingerprint checked: ${result.fingerprintChecked}\n`);
    if (fingerprint) process.stdout.write(`fingerprint: base=${fingerprint.baseVersion} head=${fingerprint.headVersion} changed=${fingerprint.changed}\n`);
    if (liveRuntime) process.stdout.write(`live runtime: live=${liveRuntime.live || '(unset)'} head=${liveRuntime.head} ok=${liveRuntime.ok}\n`);
    process.stdout.write(`deciding files (${result.files.length}):\n${result.files.map((f) => `  ${f}\n`).join('')}`);
    process.stdout.write(`all changed files (${files.length}):\n${files.map((f) => `  ${f}\n`).join('')}`);
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `decision=${result.decision}\nreason=${result.reason.replace(/\n/g, ' ')}\nfingerprint_checked=${result.fingerprintChecked}\n`);
  }
}

// Only run the CLI when this file is the entry point, so tests can import classify/resolveBase/
// etc. without it diffing or shelling out to git.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
