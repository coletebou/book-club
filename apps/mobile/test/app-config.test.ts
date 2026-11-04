import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type ExpoConfig } from 'expo/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Over-the-air updates (D180): what `app.config.ts` says about updates, and what the runtime
 * version (`fingerprint.config.js`) does and does not depend on. The second half runs the real
 * expo-updates resolver, the same code Xcode's build phase and `eas update` run.
 */

const BOOK_CLUB_PROJECT_ID = '1b9b49f4-73c8-477e-8b2e-2433b98a4faf';
const PROJECT_ID = '00000000-0000-4000-8000-000000000000';
const ENV_NAMES = [
  'EAS_PROJECT_ID',
  'EAS_OWNER',
  'BOOKCLUB_UPDATE_CHANNEL',
  'BOOKCLUB_APS_ENVIRONMENT',
  'BOOKCLUB_SERVER_URL',
  'BOOKCLUB_SIGNING_TEAM',
  'BOOKCLUB_SIGNING_PROFILE',
] as const;
type Env = Partial<Record<(typeof ENV_NAMES)[number], string>>;

async function configWith(env: Env): Promise<ExpoConfig> {
  for (const name of ENV_NAMES) vi.stubEnv(name, env[name] ?? '');
  vi.resetModules();
  return (await import('../app.config')).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('app.config.ts for App Store Connect', () => {
  it('declares no non-exempt encryption, in every build, so TestFlight skips Missing Compliance', async () => {
    for (const env of [{}, { BOOKCLUB_APS_ENVIRONMENT: 'production' }] satisfies Env[]) {
      expect((await configWith(env)).ios?.infoPlist?.ITSAppUsesNonExemptEncryption).toBe(false);
    }
  });
});

describe('app.config.ts updates', () => {
  it("points at the app's own EAS project and checks on launch without waiting for the network", async () => {
    const config = await configWith({});
    // No owner unless one is named: EAS reads it from the project (SDK 53 and later).
    expect(config.owner).toBeUndefined();
    expect(config.runtimeVersion).toEqual({ policy: 'fingerprint' });
    expect(config.updates).toEqual({
      enabled: true,
      url: `https://u.expo.dev/${BOOK_CLUB_PROJECT_ID}`,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
      requestHeaders: { 'expo-channel-name': 'development' },
    });
    expect(config.extra?.eas).toEqual({ projectId: BOOK_CLUB_PROJECT_ID });
  });

  it('lets EAS_PROJECT_ID point a build at another project, and EAS_OWNER name its owner', async () => {
    const config = await configWith({ EAS_PROJECT_ID: PROJECT_ID });
    expect(config.updates?.url).toBe(`https://u.expo.dev/${PROJECT_ID}`);
    expect(config.extra?.eas).toEqual({ projectId: PROJECT_ID });
    expect((await configWith({ EAS_PROJECT_ID: PROJECT_ID, EAS_OWNER: 'someone' })).owner).toBe('someone');
  });

  it('puts a TestFlight archive on the production channel, and lets a build choose another', async () => {
    const archive = await configWith({ EAS_PROJECT_ID: PROJECT_ID, BOOKCLUB_APS_ENVIRONMENT: 'production' });
    expect(archive.updates?.requestHeaders).toEqual({ 'expo-channel-name': 'production' });
    const preview = await configWith({
      EAS_PROJECT_ID: PROJECT_ID,
      BOOKCLUB_APS_ENVIRONMENT: 'production',
      BOOKCLUB_UPDATE_CHANNEL: 'preview',
    });
    expect(preview.updates?.requestHeaders).toEqual({ 'expo-channel-name': 'preview' });
  });

  it('refuses a channel no eas.json profile publishes to', async () => {
    await expect(configWith({ EAS_PROJECT_ID: PROJECT_ID, BOOKCLUB_UPDATE_CHANNEL: 'prod' })).rejects.toThrow(
      /BOOKCLUB_UPDATE_CHANNEL must be one of development, preview, production/,
    );
  });
});

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expoUpdatesCli = join(dirname(createRequire(import.meta.url).resolve('expo-updates/package.json')), 'bin/cli.js');
const run = promisify(execFile);

async function runtimeVersion(env: Env & { NODE_PATH?: string }): Promise<string> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ENV_NAMES) delete childEnv[name];
  const { stdout } = await run(process.execPath, [expoUpdatesCli, 'runtimeversion:resolve', '--platform', 'ios'], {
    cwd: projectRoot,
    env: { ...childEnv, ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
  const resolved = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { runtimeVersion?: string };
  expect(resolved.runtimeVersion).toMatch(/^[0-9a-f]{40}$/);
  return resolved.runtimeVersion as string;
}

describe('the runtime version (fingerprint.config.js)', { timeout: 120_000 }, () => {
  it('ignores what only the build or the publisher knows: the project and its owner, the channel, signing', async () => {
    const development = await runtimeVersion({});
    expect(await runtimeVersion({ EAS_PROJECT_ID: PROJECT_ID })).toBe(development);
    expect(await runtimeVersion({ EAS_PROJECT_ID: PROJECT_ID, EAS_OWNER: 'someone' })).toBe(development);
    expect(await runtimeVersion({ EAS_PROJECT_ID: PROJECT_ID, BOOKCLUB_UPDATE_CHANNEL: 'preview' })).toBe(development);

    // `eas update --channel production` (no signing variables) against `xcodebuild archive` (all of them)
    const publisher = await runtimeVersion({ EAS_PROJECT_ID: PROJECT_ID, BOOKCLUB_APS_ENVIRONMENT: 'production' });
    const archive = await runtimeVersion({
      BOOKCLUB_APS_ENVIRONMENT: 'production',
      BOOKCLUB_SIGNING_TEAM: 'TEAM123456',
      BOOKCLUB_SIGNING_PROFILE: 'Book Club App Store',
    });
    expect(archive).toBe(publisher);
  });

  it('changes with what makes two builds different natively: the APNs entitlement, the app-bound domains', async () => {
    const development = await runtimeVersion({});
    const production = await runtimeVersion({ BOOKCLUB_APS_ENVIRONMENT: 'production' });
    const localServer = await runtimeVersion({ BOOKCLUB_SERVER_URL: 'http://127.0.0.1:47140' });
    expect(new Set([development, production, localServer]).size).toBe(3);
    expect(await runtimeVersion({ BOOKCLUB_SERVER_URL: 'https://books.badland.ai' })).toBe(development);
  });

  it('is the same under pnpm, whose bin shims put the workspace store (and apps/web\'s react-dom) on NODE_PATH', async () => {
    // Xcode's build phase hashes with no NODE_PATH; `pnpm --filter @bookclub/mobile runtime-version`
    // and a publish run through pnpm's `.bin` shims, which set it to the hoisted store. Expo adds
    // "web" to the platforms it detects if react-dom resolves, so without `platforms` pinned the two
    // disagree and no update published that way ever reaches a build (TestFlight 1.0.0 (3)).
    const hoisted = join(projectRoot, '..', '..', 'node_modules', '.pnpm', 'node_modules');
    expect(existsSync(join(hoisted, 'react-dom', 'package.json'))).toBe(true);
    const xcode = await runtimeVersion({ BOOKCLUB_APS_ENVIRONMENT: 'production', NODE_PATH: '' });
    expect(await runtimeVersion({ BOOKCLUB_APS_ENVIRONMENT: 'production', NODE_PATH: hoisted })).toBe(xcode);
  });
});
