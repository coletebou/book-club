import { describe, expect, it, vi } from 'vitest';
import { CARPLAY_ROLE, CARPLAY_SCENE_DELEGATE, withCarPlayScene, withOneWindow } from '../plugins/with-carplay';

/** The scene manifest Expo SDK 58's template writes (its SceneDelegate, the iOS 27 SDK's scene life cycle). */
const PHONE = { UIApplicationSupportsMultipleScenes: false, UISceneConfigurations: { UIWindowSceneSessionRoleApplication: [{ UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate' }] } };

describe('CarPlay in the app’s Info.plist and config (D221)', () => {
  it('adds the car’s scene with its own delegate, and leaves the phone’s exactly as it was', () => {
    const out = withCarPlayScene({ CFBundleName: 'Book Club', UIApplicationSceneManifest: PHONE });
    const manifest = out.UIApplicationSceneManifest as typeof PHONE & { UISceneConfigurations: Record<string, unknown> };
    expect(manifest.UISceneConfigurations[CARPLAY_ROLE]).toEqual([{ UISceneClassName: 'CPTemplateApplicationScene', UISceneConfigurationName: 'CarPlay', UISceneDelegateClassName: CARPLAY_SCENE_DELEGATE }]);
    expect(manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication).toEqual(PHONE.UISceneConfigurations.UIWindowSceneSessionRoleApplication);
    // The car's screen is a second scene of the app (D232): Apple's own CarPlay manifest sets this, and
    // documents that with it false UIKit never creates more than one scene.
    expect(manifest.UIApplicationSupportsMultipleScenes).toBe(true);
    expect(out.CFBundleName).toBe('Book Club');
    expect(withCarPlayScene(out)).toEqual(out); // a second prebuild
  });

  it('keeps the app to one window now that it supports several scenes: a second window closes before React Native starts in it (D232)', () => {
    // Expo SDK 58's template (expo/template.tgz, ios/HelloWorld/SceneDelegate.swift), as prebuild writes it.
    const template = 'internal import Expo\n\n@objc(SceneDelegate)\nclass SceneDelegate: ExpoAppSceneDelegate {\n  // Extension point for config plugins.\n}\n';
    const out = withOneWindow(template);
    expect(out).toContain('import UIKit\n');
    expect(out).toContain('override func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {');
    // The refusal comes before the template's own start of React Native in the new window.
    expect(out.indexOf('requestSceneSessionDestruction(session')).toBeGreaterThan(0);
    expect(out.indexOf('requestSceneSessionDestruction(session')).toBeLessThan(out.indexOf('super.scene(scene, willConnectTo: session, options: connectionOptions)'));
    expect(out.trimEnd().endsWith('}')).toBe(true);
    // A link the second window was opened for goes to the window there is, which comes forward.
    expect(out).toContain('scene(existing, openURLContexts: connectionOptions.urlContexts)');
    expect(out.indexOf('requestSceneSessionActivation(existing.session')).toBeLessThan(out.indexOf('requestSceneSessionDestruction(session'));
    expect(withOneWindow(out)).toBe(out); // a second prebuild
    // A file an older version of the plugin wrote is not kept without a word.
    expect(() => withOneWindow(out.replace('requestSceneSessionActivation', 'requestSceneActivation'))).toThrow(/clean prebuild/);
    expect(() => withOneWindow('class SceneDelegate: UIResponder {}\n')).toThrow(/SceneDelegate\.swift is not the Expo SDK 58 template/);
  });

  it('fails loudly on an app that is not scene-based, rather than make a manifest up', () => {
    expect(() => withCarPlayScene({ CFBundleName: 'Book Club' })).toThrow(/UIApplicationSceneManifest/);
  });

  it('is in a store build once the repository says so (the entitlement granted, the App ID carrying it)', async () => {
    const { STORE_TARGETS, carPlayEnabled } = await import('../app.config');
    // On in the repository since build 7 (Apple granted the audio entitlement on 2026-11-27): every
    // machine computing the runtime version sees the same config (D180).
    expect(STORE_TARGETS.carplay).toBe(true);
    expect(carPlayEnabled({})).toBe(true);
    const off = { carplay: false };
    expect(carPlayEnabled({}, off)).toBe(false);
    expect(carPlayEnabled({ BOOKCLUB_CARPLAY: '0' }, off)).toBe(false);
    expect(carPlayEnabled({ BOOKCLUB_CARPLAY: '1' }, off)).toBe(true);
  });

  it('reaches the plugin as `enabled`, whatever BOOKCLUB_CARPLAY says, now the repository has it on', async () => {
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
      expect(await enabled(undefined)).toBe(true);
      expect(await enabled('0')).toBe(true);
      expect(await enabled('1')).toBe(true);
    } finally {
      if (before === undefined) delete process.env.BOOKCLUB_CARPLAY;
      else process.env.BOOKCLUB_CARPLAY = before;
    }
  });
});
