import { describe, expect, it, vi } from 'vitest';
import { MESSAGES_PRINCIPAL_CLASS, MESSAGES_PRODUCT_TYPE, MESSAGES_RELEASE_SETTINGS, MESSAGES_TARGET, makeMessagesAppExtension, messagesInfoPlist } from '../plugins/with-messages-extension';

/** What @bacons/apple-targets writes for its `imessage` (sticker pack) type, as of 5.x. */
const STICKER_PACK = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>NSExtension</key>
    <dict>
      <key>NSExtensionPointIdentifier</key>
      <string>com.apple.message-payload-provider</string>
      <key>NSExtensionPrincipalClass</key>
      <string>StickerBrowserViewController</string>
    </dict>
  </dict>
</plist>`;

describe('the Messages extension is an app extension, not a sticker pack (D220)', () => {
  it('names our view controller as the principal class, and nothing else changes', () => {
    const out = messagesInfoPlist(STICKER_PACK);
    expect(out).toContain(`<string>${MESSAGES_PRINCIPAL_CLASS}</string>`);
    expect(out).not.toContain('StickerBrowserViewController');
    expect(out.replace(`<string>${MESSAGES_PRINCIPAL_CLASS}</string>`, '<string>StickerBrowserViewController</string>')).toBe(STICKER_PACK);
  });

  it('is idempotent (a second prebuild), and fails loudly on a plist it does not recognise', () => {
    expect(messagesInfoPlist(messagesInfoPlist(STICKER_PACK))).toBe(messagesInfoPlist(STICKER_PACK));
    expect(() => messagesInfoPlist(STICKER_PACK.replace('com.apple.message-payload-provider', 'com.apple.widgetkit-extension'))).toThrow();
    expect(() => messagesInfoPlist(STICKER_PACK.replace('StickerBrowserViewController', 'SomethingElse'))).toThrow();
  });

  it('makes the Messages target an app extension, leaves the others alone, and fails loudly without it', () => {
    const app = { props: { name: 'BookClub', productType: 'com.apple.product-type.application' } };
    const widgets = { props: { name: 'widgets', productType: 'com.apple.product-type.app-extension' } };
    const configs = (release: Record<string, unknown>) => ({ props: { buildConfigurations: [{ props: { name: 'Debug', buildSettings: { SWIFT_OPTIMIZATION_LEVEL: '-Onone' } } }, { props: { name: 'Release', buildSettings: release } }] } });
    const messages = { props: { name: MESSAGES_TARGET, productType: 'com.apple.product-type.app-extension', buildConfigurationList: configs({ SWIFT_OPTIMIZATION_LEVEL: '-Onone', DEBUG_INFORMATION_FORMAT: 'dwarf', PRODUCT_NAME: '$(TARGET_NAME)' }) } };
    makeMessagesAppExtension([app, widgets, messages]);
    expect(messages.props.productType).toBe(MESSAGES_PRODUCT_TYPE);
    // Release is optimised, as the widgets' is (no debug dylib shipped); Debug and the rest unchanged.
    const [debug, release] = messages.props.buildConfigurationList.props.buildConfigurations;
    expect(release!.props.buildSettings).toEqual({ ...MESSAGES_RELEASE_SETTINGS, PRODUCT_NAME: '$(TARGET_NAME)' });
    expect(debug!.props.buildSettings).toEqual({ SWIFT_OPTIMIZATION_LEVEL: '-Onone' });
    expect(() => makeMessagesAppExtension([{ props: { name: MESSAGES_TARGET, buildConfigurationList: { props: { buildConfigurations: [] } } } }])).toThrow(/no Release configuration/);
    expect(app.props.productType).toBe('com.apple.product-type.application');
    expect(widgets.props.productType).toBe('com.apple.product-type.app-extension');
    expect(() => makeMessagesAppExtension([app, widgets])).toThrow(/no BookClubMessages target/);
  });

  it('is listed before @bacons/apple-targets, so its mods run after that plugin wrote the target', async () => {
    const before = process.env.BOOKCLUB_MESSAGES;
    process.env.BOOKCLUB_MESSAGES = '1';
    try {
      vi.resetModules();
      const plugins = ((await import('../app.config')).default.plugins ?? []).map((p) => (Array.isArray(p) ? p[0] : p));
      const ours = plugins.indexOf('./plugins/with-messages-extension');
      expect(ours).toBeGreaterThanOrEqual(0);
      expect(ours).toBeLessThan(plugins.indexOf('@bacons/apple-targets'));
    } finally {
      if (before === undefined) delete process.env.BOOKCLUB_MESSAGES;
      else process.env.BOOKCLUB_MESSAGES = before;
    }
  });

  it('is in a store build only once the repository says so, and in a local build with BOOKCLUB_MESSAGES=1', async () => {
    const { STORE_TARGETS, nativeTargets } = await import('../app.config');
    // On in the repository since build 6 (its App ID has a profile): every machine computing the
    // runtime version sees the same targets (D180).
    expect(STORE_TARGETS.messages).toBe(true);
    expect(nativeTargets({})).toContain('messages');
    const off = { messages: false, watch: false };
    expect(nativeTargets({}, off)).toEqual(['widgets']);
    expect(nativeTargets({ BOOKCLUB_MESSAGES: '0' }, off)).toEqual(['widgets']);
    expect(nativeTargets({ BOOKCLUB_MESSAGES: '1' }, off)).toEqual(['widgets', 'messages']);
    expect(nativeTargets({}, { messages: true, watch: false })).toEqual(['widgets', 'messages']);
  });
});
