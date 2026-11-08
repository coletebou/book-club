import fs from 'node:fs';
import path from 'node:path';
import { type ConfigPlugin, IOSConfig, withDangerousMod, withEntitlementsPlist, withInfoPlist, withXcodeProject } from 'expo/config-plugins';

export interface CarPlayProps {
  /** BOOKCLUB_CARPLAY=1 (D221): off by default, so a build signs with profiles made before Apple grants the entitlement. */
  readonly enabled: boolean;
}

export const CARPLAY_ENTITLEMENT = 'com.apple.developer.carplay-audio';
export const CARPLAY_ROLE = 'CPTemplateApplicationSceneSessionRoleApplication';
export const CARPLAY_SCENE_DELEGATE = 'BookClubCarPlaySceneDelegate';
const DELEGATE_FILE = `${CARPLAY_SCENE_DELEGATE}.swift`;

type Plist = Record<string, unknown>;

/**
 * The Info.plist with CarPlay's scene beside the phone's (D221). Expo's own template already makes
 * the app scene-based (its SceneDelegate, required by the iOS 27 SDK): the car is one more role,
 * its own delegate, and the phone's scene is left exactly as it was. Fails loudly without that
 * manifest rather than make one up.
 */
export function withCarPlayScene(plist: Plist): Plist {
  const manifest = plist.UIApplicationSceneManifest as { UISceneConfigurations?: Record<string, unknown[]> } | undefined;
  if (!manifest?.UISceneConfigurations) throw new Error('withCarPlay: the Info.plist has no UIApplicationSceneManifest; the app must be scene-based (Expo SDK 58)');
  const configuration = { UISceneClassName: 'CPTemplateApplicationScene', UISceneConfigurationName: 'CarPlay', UISceneDelegateClassName: CARPLAY_SCENE_DELEGATE };
  return {
    ...plist,
    UIApplicationSceneManifest: { ...manifest, UISceneConfigurations: { ...manifest.UISceneConfigurations, [CARPLAY_ROLE]: [configuration] } },
  };
}

/**
 * CarPlay (D221), only when enabled: the audio entitlement, the car's scene in the Info.plist, and
 * its scene delegate (plugins/carplay/BookClubCarPlaySceneDelegate.swift) in the app target. The
 * templates themselves are in the BookClubNative module, in every build: with this off nothing
 * connects them.
 */
const withCarPlay: ConfigPlugin<CarPlayProps> = (config, { enabled }) => {
  if (!enabled) return config;
  config = withEntitlementsPlist(config, (config) => {
    config.modResults[CARPLAY_ENTITLEMENT] = true;
    return config;
  });
  config = withInfoPlist(config, (config) => {
    config.modResults = withCarPlayScene(config.modResults) as typeof config.modResults;
    return config;
  });
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(config.modRequest.projectRoot);
      const to = path.join(config.modRequest.platformProjectRoot, projectName, DELEGATE_FILE);
      fs.copyFileSync(path.join(config.modRequest.projectRoot, 'plugins', 'carplay', DELEGATE_FILE), to);
      return config;
    },
  ]);
  return withXcodeProject(config, (config) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(config.modRequest.projectRoot);
    const filepath = `${projectName}/${DELEGATE_FILE}`;
    if (!config.modResults.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath, groupName: projectName, project: config.modResults });
    }
    return config;
  });
};

export default withCarPlay;
