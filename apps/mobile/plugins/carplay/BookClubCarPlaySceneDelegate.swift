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
    startJavaScriptIfNeeded()
    BookClubCarPlay.shared.connect(interfaceController)
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
