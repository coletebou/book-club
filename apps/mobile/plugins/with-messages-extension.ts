import fs from 'node:fs';
import path from 'node:path';
import { withXcodeProjectBeta } from '@bacons/apple-targets/build/with-bacons-xcode';
import { type ConfigPlugin, withDangerousMod } from 'expo/config-plugins';

/** The Messages extension's target, as `targets/messages/expo-target.config.js` names it. */
export const MESSAGES_TARGET = 'BookClubMessages';
export const MESSAGES_PRODUCT_TYPE = 'com.apple.product-type.app-extension.messages';
export const MESSAGES_PRINCIPAL_CLASS = '$(PRODUCT_MODULE_NAME).MessagesViewController';

/**
 * A Messages *app* extension, not a sticker pack (D220). `@bacons/apple-targets` makes the target
 * (its `imessage` type: the extension point, the build settings, the App Group), but that type is a
 * sticker pack, with `StickerBrowserViewController` as its principal class and no code of its own.
 * This turns it into an app extension with Swift (`targets/messages`): the product type Xcode's own
 * iMessage extension template uses, and our view controller. It must be listed *before*
 * `@bacons/apple-targets` in app.config.ts: a plugin listed earlier has its mods run later, so this
 * runs after that one wrote the target's Info.plist and project entry.
 */
const withMessagesExtension: ConfigPlugin = (config) => {
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const file = path.join(config.modRequest.projectRoot, 'targets', 'messages', 'Info.plist');
      if (!fs.existsSync(file)) throw new Error(`withMessagesExtension: ${file} was not written; is @bacons/apple-targets listed after this plugin?`);
      fs.writeFileSync(file, messagesInfoPlist(fs.readFileSync(file, 'utf8')));
      return config;
    },
  ]);
  // The target is made in @bacons/apple-targets' own project mod, which runs after Expo's
  // `xcodeproj` mod has already been written: a `withXcodeProject` here never sees it.
  return withXcodeProjectBeta(config, (config) => {
    makeMessagesAppExtension(config.modResults.rootObject.props.targets);
    return config;
  });
};

/**
 * The extension's Info.plist (as `@bacons/apple-targets` writes it for its sticker-pack type) with
 * our view controller as its principal class. Fails loudly on anything else, rather than guess.
 */
export function messagesInfoPlist(xml: string): string {
  if (!xml.includes('<string>com.apple.message-payload-provider</string>')) throw new Error('withMessagesExtension: the Messages target is not a com.apple.message-payload-provider extension');
  if (xml.includes(`<string>${MESSAGES_PRINCIPAL_CLASS}</string>`)) return xml;
  const sticker = '<string>StickerBrowserViewController</string>';
  if (!xml.includes(sticker)) throw new Error('withMessagesExtension: unexpected NSExtensionPrincipalClass in the Messages target');
  return xml.replace(sticker, `<string>${MESSAGES_PRINCIPAL_CLASS}</string>`);
}

/** The project's targets, as `@bacons/xcode` gives them: only the fields this plugin reads or sets. */
type BuildConfiguration = { props: { name?: string; buildSettings: Record<string, unknown> } };
type Target = { props: { name?: string; productType?: string; buildConfigurationList?: { props: { buildConfigurations: BuildConfiguration[] } } } };

/**
 * A Release build of the extension's Swift as the widgets' is: optimised, whole-module, with dSYMs.
 * The sticker-pack type has no code, so @bacons/apple-targets leaves its Release at `-Onone`, which
 * also has Xcode put a debug dylib and a previews stub in the shipped extension.
 */
export const MESSAGES_RELEASE_SETTINGS = { SWIFT_OPTIMIZATION_LEVEL: '-O', SWIFT_COMPILATION_MODE: 'wholemodule', DEBUG_INFORMATION_FORMAT: 'dwarf-with-dsym' } as const;

/**
 * Gives the Messages target the product type of an app extension and an optimised Release build.
 * Fails loudly when the target, or its Release configuration, is missing.
 */
export function makeMessagesAppExtension(targets: readonly Target[]): void {
  const target = targets.find((t) => t.props.name === MESSAGES_TARGET);
  if (!target) throw new Error(`withMessagesExtension: no ${MESSAGES_TARGET} target in the Xcode project; is @bacons/apple-targets listed after this plugin?`);
  target.props.productType = MESSAGES_PRODUCT_TYPE;
  const release = target.props.buildConfigurationList?.props.buildConfigurations.find((c) => c.props.name === 'Release');
  if (!release) throw new Error(`withMessagesExtension: the ${MESSAGES_TARGET} target has no Release configuration`);
  Object.assign(release.props.buildSettings, MESSAGES_RELEASE_SETTINGS);
}

export default withMessagesExtension;
