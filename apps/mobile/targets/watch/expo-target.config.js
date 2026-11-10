/**
 * The watch app (D222): what plays now on the iPhone, its place in the chapter and the book, and the
 * lock screen's own buttons (15 s back, play/pause, 30 s forward). Made by @bacons/apple-targets at
 * prebuild as its `watch` type (a single-target SwiftUI watchOS app, embedded in the iPhone app);
 * plugins/with-watch-app.ts adds what that type leaves out of its Info.plist. It plays nothing
 * itself: the audio is the iPhone's (v1; D222 has the plan for listening on the watch alone).
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = () => ({
  type: 'watch',
  name: 'BookClubWatch',
  displayName: 'Book Club',
  bundleIdentifier: '.watchkitapp',
  deploymentTarget: '10.0',
  icon: '../../assets/icon.png',
  frameworks: ['WatchConnectivity', 'SwiftUI'],
  colors: {
    $accent: { light: '#b8552f', dark: '#b8552f' },
    parchment: { light: '#f4ead2', dark: '#f4ead2' },
  },
});
