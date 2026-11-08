/**
 * The Messages extension (D220): invite to a club, share how far you are, vote on the next book and
 * answer a meet-up, from inside a conversation. Made by @bacons/apple-targets at prebuild as its
 * `imessage` type, which plugins/with-messages-extension.ts turns from a sticker pack into an app
 * extension with this folder's Swift. Its bundle id is the app's plus `.messages`; it shares the
 * app's App Group, through which it reads the signed-in session (SharedSession.swift) and the
 * widgets' snapshot (your current book).
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: 'imessage',
  name: 'BookClubMessages',
  displayName: 'Book Club',
  bundleIdentifier: '.messages',
  deploymentTarget: '17.0',
  frameworks: ['Messages', 'SwiftUI'],
  entitlements: {
    'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
  },
  colors: {
    $accent: { light: '#93361c', dark: '#b8552f' },
    parchment: { light: '#f4ead2', dark: '#1f160e' },
    ink: { light: '#2a1c12', dark: '#f0e2c2' },
    faint: { light: '#634e3a', dark: '#b9a37f' },
  },
});
