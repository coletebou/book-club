import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { IOSConfig } from 'expo/config-plugins';
import { expect, it } from 'vitest';

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = createRequire(import.meta.url).resolve('expo/bin/cli');
const run = promisify(execFile);
const files = ['app.config.ts', 'assets', 'package.json', 'plugins', 'targets'];
const team = 'TEAM123456';
const profiles = [
  ['ai.badland.books', 'Test App Distribution'],
  ['ai.badland.books.widgets', 'Test Widgets Distribution'],
  ['ai.badland.books.messages', 'Test Messages Distribution'],
  ['ai.badland.books.watchkitapp', 'Test-Watch-Distribution'],
] as const;

it('applies manual store signing to the app and all three native targets in a clean project', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bookclub-signing-'));
  try {
    await Promise.all(files.map((file) => cp(join(app, file), join(projectRoot, file), { recursive: true })));
    await symlink(join(app, 'node_modules'), join(projectRoot, 'node_modules'), 'dir');
    const manifest = await readFile(join(projectRoot, 'package.json'), 'utf8');
    await run(process.execPath, [cli, 'prebuild', '--platform', 'ios', '--no-install'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CI: '1',
        BOOKCLUB_APS_ENVIRONMENT: 'production',
        BOOKCLUB_SIGNING_TEAM: team,
        BOOKCLUB_SIGNING_PROFILE: profiles[0][1],
        BOOKCLUB_SIGNING_WIDGETS_PROFILE: profiles[1][1],
        BOOKCLUB_SIGNING_MESSAGES_PROFILE: profiles[2][1],
        BOOKCLUB_SIGNING_WATCH_PROFILE: profiles[3][1],
      },
    });
    const project = IOSConfig.XcodeUtils.getPbxproj(projectRoot);
    const configs = project.pbxXCBuildConfigurationSection() as Record<string, {
      name?: string;
      buildSettings?: Record<string, string>;
    } | string>;
    const decoded = (value: string | undefined) => value?.replace(/^"|"$/g, '');
    for (const [id, profile] of profiles) {
      const builds = Object.values(configs).flatMap((entry) =>
        typeof entry === 'object' && entry.buildSettings && decoded(entry.buildSettings.PRODUCT_BUNDLE_IDENTIFIER) === id
          ? [{ name: decoded(entry.name), settings: entry.buildSettings }]
          : []);
      expect(builds.map((c) => c.name).sort(), id).toEqual(['Debug', 'Release']);
      for (const { settings } of builds) {
        expect(decoded(settings.CODE_SIGN_STYLE), id).toBe('Manual');
        expect(decoded(settings.DEVELOPMENT_TEAM), id).toBe(team);
        expect(decoded(settings.CODE_SIGN_IDENTITY), id).toBe('Apple Distribution');
        expect(decoded(settings.PROVISIONING_PROFILE_SPECIFIER), id).toBe(profile);
      }
    }
    expect(await readFile(join(projectRoot, 'package.json'), 'utf8')).toBe(manifest);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}, 60_000);
