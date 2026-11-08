import { describe, expect, it, vi } from 'vitest';
import { MESSAGES_PRINCIPAL_CLASS, messagesInfoPlist } from '../plugins/with-messages-extension';

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

  it('is listed before @bacons/apple-targets, so its mods run after that plugin wrote the target', async () => {
    vi.resetModules();
    const plugins = ((await import('../app.config')).default.plugins ?? []).map((p) => (Array.isArray(p) ? p[0] : p));
    const ours = plugins.indexOf('./plugins/with-messages-extension');
    expect(ours).toBeGreaterThanOrEqual(0);
    expect(ours).toBeLessThan(plugins.indexOf('@bacons/apple-targets'));
  });
});
