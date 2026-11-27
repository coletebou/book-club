// CarPlay's scene (D221), copied into the app target by plugins/with-carplay.ts, and only for a build
// made with BOOKCLUB_CARPLAY=1 (the entitlement Apple grants for an audio app). Its templates are
// in the BookClubNative module (CarPlayController.swift); this connects them, and starts the
// JavaScript when the car opened the app with no phone screen: the player lives there.
internal import Expo
internal import BookClubNative
import CarPlay
import React
import UIKit

@objc(BookClubCarPlaySceneDelegate)
class BookClubCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
    // The car's screens first: they are native and drawn from whatever model there is (none yet on
    // a car-first start), so the car never waits on the JavaScript for something to show.
    BookClubCarPlay.shared.connect(interfaceController)
    startJavaScriptIfNeeded()
  }

  func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didDisconnectInterfaceController interfaceController: CPInterfaceController) {
    BookClubCarPlay.shared.disconnect()
  }

  /**
   * The phone's scene (Expo's SceneDelegate) starts React Native with its window; a car alone has
   * none, so the host starts here, with no surface: index.ts runs, and with it the player
   * (src/audio/appAudio.ts). Done at most once: a phone screen opened later gets the same host
   * (RCTRootViewFactory creates one only if there is none: `createReactHostIfNeeded`, so calling
   * this with a host already running does nothing), and the app never has two players.
   *
   * Known limit (D232): a host started here runs the JavaScript built into the app, not an
   * over-the-air update. Expo Updates picks the bundle only when a window's root view is made
   * (its ExpoUpdatesReactDelegateHandler), and a phone window opened later joins this host. So on
   * a car-first start the car's features are the build's own until the app is next started from
   * the phone. Starting Expo Updates from here is not done blind: its controller has one delegate,
   * and taking it while a phone window is starting would leave that window on its splash screen.
   */
  private func startJavaScriptIfNeeded() {
    guard let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
          let factory = provider.reactNativeFactory else { return }
    factory.rootViewFactory.initializeReactHost(
      launchOptions: nil,
      bundleConfiguration: factory.bundleConfiguration,
      devMenuConfiguration: factory.devMenuConfiguration ?? RCTDevMenuConfiguration.default()
    )
  }
}
