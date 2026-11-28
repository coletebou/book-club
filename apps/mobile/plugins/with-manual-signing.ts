import { withXcodeProjectBeta } from '@bacons/apple-targets/build/with-bacons-xcode';
import { type ConfigPlugin } from 'expo/config-plugins';

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
 * Manual signing for the App Store archive (D137 addendum): the app and its configured native
 * targets sign with a named Apple Distribution certificate and their own App Store profiles.
 * Automatic signing (`-allowProvisioningUpdates`) asks the portal for a development
 * certificate "for this machine" first, and on a shared Mac whose development certificate's key
 * lives elsewhere it stops there, offering only to revoke someone else's. Setting these on the
 * xcodebuild command line instead would reach every CocoaPods target too, which refuse a
 * provisioning profile. Off (a no-op) unless the archive asks for it, so simulator and development
 * builds stay as they were.
 */
const withManualSigning: ConfigPlugin<ManualSigningProps | null> = (config, props) => {
  if (!props) return config;
  // apple-targets adds the extension targets after Expo's normal xcodeproj mod. The beta mod runs
  // on that same project, after apple-targets when listed immediately before it in app.config.ts.
  return withXcodeProjectBeta(config, (config) => {
    const { rootObject } = config.modResults;
    const bundleId = config.ios?.bundleIdentifier;
    const identity = props.identity ?? 'Apple Distribution';
    let touched = 0;
    for (const target of rootObject.props.targets) {
      let signed = false;
      for (const { props: { buildSettings: settings } } of target.props.buildConfigurationList.props.buildConfigurations) {
        const builds = settings.PRODUCT_BUNDLE_IDENTIFIER;
        if (!builds) continue;
        const profile = builds === bundleId ? props.profile : props.extensions?.[builds];
        if (!profile) continue;
        Object.assign(settings, {
          CODE_SIGN_STYLE: 'Manual',
          DEVELOPMENT_TEAM: props.team,
          CODE_SIGN_IDENTITY: identity,
          'CODE_SIGN_IDENTITY[sdk=iphoneos*]': identity,
          PROVISIONING_PROFILE_SPECIFIER: profile,
        });
        signed = true;
        if (builds === bundleId) touched++;
      }
      if (signed) {
        const signing = rootObject.props.attributes.TargetAttributes?.[target.uuid];
        if (signing) Object.assign(signing, { ProvisioningStyle: 'Manual', DevelopmentTeam: props.team });
      }
    }
    if (touched === 0) throw new Error(`withManualSigning: no build configuration builds ${bundleId}`);
    return config;
  });
};

export default withManualSigning;
