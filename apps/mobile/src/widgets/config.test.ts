import { describe, expect, it, vi } from 'vitest';

/** The widget extension's place in the build (D189). */
describe('the build’s widgets and Live Activity', () => {
  const load = async (env: Record<string, string | undefined>) => {
    vi.resetModules();
    const saved = { ...process.env };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return (await import('../../app.config')).default;
    } finally {
      process.env = saved;
    }
  };

  it('adds the extension, the App Group it shares with the app, and Live Activities', async () => {
    const config = await load({});
    // With the targets it carries (D220: the Messages extension only with BOOKCLUB_MESSAGES=1): the widgets always.
    expect(config.plugins).toContainEqual(['@bacons/apple-targets', { match: '@(widgets)' }]);
    expect(config.ios?.entitlements?.['com.apple.security.application-groups']).toEqual(['group.ai.badland.books']);
    expect(config.ios?.infoPlist?.NSSupportsLiveActivities).toBe(true);
  });

  it('the extension’s own App Store profile is signed with when given', async () => {
    const config = await load({ BOOKCLUB_SIGNING_TEAM: 'TEAM123456', BOOKCLUB_SIGNING_PROFILE: 'Book Club App Store', BOOKCLUB_SIGNING_WIDGETS_PROFILE: 'Book Club Widgets App Store' });
    const signing = config.plugins?.find((p) => Array.isArray(p) && p[0] === './plugins/with-manual-signing') as [string, { extensions?: Record<string, string> }];
    expect(signing[1].extensions).toEqual({ 'ai.badland.books.widgets': 'Book Club Widgets App Store' });
  });

  it('the widget target’s config takes the app’s App Group', async () => {
    const make = (await import('../../targets/widgets/expo-target.config.js')).default as (c: unknown) => { bundleIdentifier: string; entitlements: Record<string, unknown>; deploymentTarget: string };
    const target = make({ ios: { entitlements: { 'com.apple.security.application-groups': ['group.ai.badland.books'] } } });
    expect(target).toMatchObject({ bundleIdentifier: '.widgets', deploymentTarget: '17.0', entitlements: { 'com.apple.security.application-groups': ['group.ai.badland.books'] } });
  });
});
