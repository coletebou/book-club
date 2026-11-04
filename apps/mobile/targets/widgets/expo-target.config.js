/**
 * The widget extension (D189): the Home Screen and Lock Screen widgets and the audiobook's Live
 * Activity, one WidgetKit target made by @bacons/apple-targets at prebuild. Its bundle id is the
 * app's plus `.widgets` (`ai.badland.books.widgets`); it shares the app's App Group, through which
 * the app hands it what to show (the page's snapshot, D188, and each book's cover).
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: 'widget',
  name: 'BookClubWidgets',
  bundleIdentifier: '.widgets',
  // Live Activities with buttons (App Intents in widgets) need iOS 17.
  deploymentTarget: '17.0',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit', 'AppIntents'],
  entitlements: {
    'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
  },
  colors: {
    // The manuscript look (D117): parchment, ink, the sanguine accent.
    $accent: { light: '#93361c', dark: '#b8552f' },
    $widgetBackground: { light: '#f4ead2', dark: '#1f160e' },
    ink: { light: '#2a1c12', dark: '#f0e2c2' },
    faint: { light: '#634e3a', dark: '#b9a37f' },
  },
});
