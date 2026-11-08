import { describe, expect, it, vi } from 'vitest';
import { CARPLAY_ROLE, CARPLAY_SCENE_DELEGATE, withCarPlayScene } from '../plugins/with-carplay';

/** The scene manifest Expo SDK 58's template writes (its SceneDelegate, the iOS 27 SDK's scene life cycle). */
const PHONE = { UIApplicationSupportsMultipleScenes: false, UISceneConfigurations: { UIWindowSceneSessionRoleApplication: [{ UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate' }] } };

describe('CarPlay in the app’s Info.plist and config (D221)', () => {
  it('adds the car’s scene with its own delegate, and leaves the phone’s exactly as it was', () => {
    const out = withCarPlayScene({ CFBundleName: 'Book Club', UIApplicationSceneManifest: PHONE });
    const manifest = out.UIApplicationSceneManifest as typeof PHONE & { UISceneConfigurations: Record<string, unknown> };
    expect(manifest.UISceneConfigurations[CARPLAY_ROLE]).toEqual([{ UISceneClassName: 'CPTemplateApplicationScene', UISceneConfigurationName: 'CarPlay', UISceneDelegateClassName: CARPLAY_SCENE_DELEGATE }]);
    expect(manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication).toEqual(PHONE.UISceneConfigurations.UIWindowSceneSessionRoleApplication);
    expect(manifest.UIApplicationSupportsMultipleScenes).toBe(false);
    expect(out.CFBundleName).toBe('Book Club');
    expect(withCarPlayScene(out)).toEqual(out); // a second prebuild
  });

  it('fails loudly on an app that is not scene-based, rather than make a manifest up', () => {
    expect(() => withCarPlayScene({ CFBundleName: 'Book Club' })).toThrow(/UIApplicationSceneManifest/);
  });

  it('is off unless BOOKCLUB_CARPLAY=1: a build signs before Apple grants the entitlement', async () => {
    const enabled = async (value: string | undefined) => {
      vi.resetModules();
      if (value === undefined) delete process.env.BOOKCLUB_CARPLAY;
      else process.env.BOOKCLUB_CARPLAY = value;
      const plugins = (await import('../app.config')).default.plugins ?? [];
      const entry = plugins.find((p) => Array.isArray(p) && p[0] === './plugins/with-carplay') as [string, { enabled: boolean }] | undefined;
      return entry?.[1].enabled;
    };
    const before = process.env.BOOKCLUB_CARPLAY;
    try {
      expect(await enabled(undefined)).toBe(false);
      expect(await enabled('0')).toBe(false);
      expect(await enabled('1')).toBe(true);
    } finally {
      if (before === undefined) delete process.env.BOOKCLUB_CARPLAY;
      else process.env.BOOKCLUB_CARPLAY = before;
    }
  });
});
