import { type ConfigPlugin, withXcodeProject } from 'expo/config-plugins';

export interface ManualSigningProps {
  /** The Apple Developer Team ID (10 characters). */
  readonly team: string;
  /** The App Store provisioning profile's name, as App Store Connect shows it. */
  readonly profile: string;
  /** The signing identity's common-name prefix. */
  readonly identity?: string;
  /** App extensions' App Store profiles, by their bundle id (the widget extension, D189). */
  readonly extensions?: Readonly<Record<string, string>>;
}

/**
 * Manual signing for the App Store archive (D137 addendum): the app target, and only it, signs with
 * a named Apple Distribution certificate and App Store profile, both made through the App Store
 * Connect API. Automatic signing (`-allowProvisioningUpdates`) asks the portal for a development
 * certificate "for this machine" first, and on a shared Mac whose development certificate's key
 * lives elsewhere it stops there, offering only to revoke someone else's. Setting these on the
 * xcodebuild command line instead would reach every CocoaPods target too, which refuse a
 * provisioning profile. Off (a no-op) unless the archive asks for it, so simulator and development
 * builds stay as they were.
 */
const withManualSigning: ConfigPlugin<ManualSigningProps | null> = (config, props) => {
  if (!props) return config;
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const bundleId = config.ios?.bundleIdentifier;
    const configurations = project.pbxXCBuildConfigurationSection() as Record<string, { buildSettings?: Record<string, string> } | string>;
    let touched = 0;
    for (const entry of Object.values(configurations)) {
      if (typeof entry === 'string' || !entry.buildSettings) continue;
      const settings = entry.buildSettings;
      // The app target's configurations are the ones that build its bundle id; an extension's, its own.
      const builds = settings.PRODUCT_BUNDLE_IDENTIFIER?.replace(/"/g, '');
      const profile = builds === bundleId ? props.profile : builds ? props.extensions?.[builds] : undefined;
      if (!profile) continue;
      settings.CODE_SIGN_STYLE = 'Manual';
      settings.DEVELOPMENT_TEAM = props.team;
      settings.CODE_SIGN_IDENTITY = `"${props.identity ?? 'Apple Distribution'}"`;
      settings['"CODE_SIGN_IDENTITY[sdk=iphoneos*]"'] = `"${props.identity ?? 'Apple Distribution'}"`;
      settings.PROVISIONING_PROFILE_SPECIFIER = `"${profile}"`;
      if (builds === bundleId) touched++;
    }
    if (touched === 0) throw new Error(`withManualSigning: no build configuration builds ${bundleId}`);
    return config;
  });
};

export default withManualSigning;
