// @ts-check
/**
 * What the runtime version (app.config.ts, `runtimeVersion: { policy: 'fingerprint' }`) is a hash
 * of (D180). An over-the-air update runs only on a build whose fingerprint matches its own, and the
 * fingerprint is computed three times on three machines: by `expo prebuild`, again by Xcode's
 * expo-updates build phase during `xcodebuild archive`, and by `eas update` wherever it is run.
 * Each evaluates app.config.ts with its own environment, so whatever the environment changes that
 * is not native has to be left out here, or a build and its own updates disagree and the updates
 * are silently never downloaded.
 *
 * Left out, because none of it changes the native code an update's JavaScript runs against:
 * - the preset's own skips ("balanced": versions and build numbers, eas.json, autolinking paths,
 *   which differ between a pnpm and an npm install of the same packages);
 * - the EAS project id and `extra` (the server URL there is JavaScript's copy; its native half,
 *   `WKAppBoundDomains`, is the app-bound-domains plugin's props, which stay in);
 * - package.json scripts (adding a script is not a native change);
 * - the whole `updates` section (the update URL, the channel request header, and when to check:
 *   Expo.plist settings, the same for every JavaScript bundle);
 * - the manual-signing plugin's props (which certificate signs the archive, set only for it).
 *
 * Kept, because they really do make two builds different: every native dependency and its
 * version, every config plugin and its props (the APNs environment, the app-bound domains), and
 * the rest of the app config (bundle id, permissions, icon, splash).
 *
 * Check it with `pnpm --filter @bookclub/mobile runtime-version` (scripts/runtime-version.sh).
 */
// @expo/fingerprint loads this file with require(), so it is CommonJS like Expo's other config files.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SourceSkips } = require('expo/fingerprint');

const MANUAL_SIGNING_PLUGIN = './plugins/with-manual-signing';

/** @param {string} contents the evaluated app config, as JSON */
function withoutNonNativeConfig(contents) {
  const config = JSON.parse(contents);
  delete config.updates;
  if (Array.isArray(config.plugins)) {
    config.plugins = config.plugins.map((/** @type {unknown} */ entry) =>
      Array.isArray(entry) && entry[0] === MANUAL_SIGNING_PLUGIN ? MANUAL_SIGNING_PLUGIN : entry,
    );
  }
  return JSON.stringify(config);
}

/** @type {import('expo/fingerprint').Config} */
const config = {
  sourceSkips:
    // the "balanced" preset's (the default this replaces)
    SourceSkips.PackageJsonAndroidAndIosScriptsIfNotContainRun |
    SourceSkips.ExpoConfigVersions |
    SourceSkips.ExpoConfigRuntimeVersionIfString |
    SourceSkips.EasJson |
    SourceSkips.Easignore |
    SourceSkips.AutolinkingConfigPaths |
    // this project's
    SourceSkips.ExpoConfigEASProject |
    SourceSkips.ExpoConfigExtraSection |
    SourceSkips.PackageJsonScriptsAll,
  fileHookTransform(source, chunk) {
    if (source.type === 'contents' && source.id === 'expoConfig' && typeof chunk === 'string') {
      return withoutNonNativeConfig(chunk);
    }
    return chunk;
  },
};

module.exports = config;
