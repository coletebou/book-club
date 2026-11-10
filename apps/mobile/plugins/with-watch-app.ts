import fs from 'node:fs';
import path from 'node:path';
import { type ConfigPlugin, withDangerousMod } from 'expo/config-plugins';

/**
 * The watch app's Info.plist (D222): `@bacons/apple-targets` writes its `watch` type's with nothing
 * in it, and a single-target watchOS app is one only with `WKApplication` (what Xcode's own template
 * sets); it needs its iPhone app to run (v1 is a remote, D222). Listed before
 * `@bacons/apple-targets` in app.config.ts, so it runs after that plugin wrote the file.
 */
export const WATCH_KEYS = { WKApplication: true, WKRunsIndependentlyOfCompanionApp: false } as const;

/** `xml` (a plist whose root is a dict) with WATCH_KEYS set; the same file again when it has them. */
export function watchInfoPlist(xml: string): string {
  const entries = Object.entries(WATCH_KEYS).filter(([key]) => !xml.includes(`<key>${key}</key>`));
  if (entries.length === 0) return xml;
  const add = entries.map(([key, value]) => `<key>${key}</key>\n    <${value ? 'true' : 'false'}/>`).join('\n    ');
  if (/<dict\s*\/>/.test(xml)) return xml.replace(/<dict\s*\/>/, `<dict>\n    ${add}\n  </dict>`);
  const open = xml.indexOf('<dict>');
  if (open < 0) throw new Error('withWatchApp: the watch app Info.plist has no root dict');
  return `${xml.slice(0, open + '<dict>'.length)}\n    ${add}${xml.slice(open + '<dict>'.length)}`;
}

const withWatchApp: ConfigPlugin = (config) =>
  withDangerousMod(config, [
    'ios',
    async (config) => {
      const file = path.join(config.modRequest.projectRoot, 'targets', 'watch', 'Info.plist');
      if (!fs.existsSync(file)) throw new Error(`withWatchApp: ${file} was not written; is @bacons/apple-targets listed after this plugin?`);
      fs.writeFileSync(file, watchInfoPlist(fs.readFileSync(file, 'utf8')));
      return config;
    },
  ]);

export default withWatchApp;
