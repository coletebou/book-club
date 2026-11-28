// CarPlay's scene (D221), copied into the app target by plugins/with-carplay.ts, and only for a build
// made with BOOKCLUB_CARPLAY=1 (the entitlement Apple grants for an audio app). Its templates are
// in the BookClubNative module (CarPlayController.swift); this connects them, and starts the
// JavaScript when the car opened the app with no phone screen: the player lives there.
internal import Expo
internal import EXUpdates
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
    BookClubReactStartup.shared.prepare { [weak self] in self?.startJavaScriptIfNeeded() }
  }

  func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didDisconnectInterfaceController interfaceController: CPInterfaceController) {
    BookClubCarPlay.shared.disconnect(interfaceController)
  }

  /**
   * A car alone starts the host without a surface, after the shared bundle selection (D265).
   * RCTRootViewFactory's createReactHostIfNeeded reuses the same host when a window arrives.
   */
  private func startJavaScriptIfNeeded() {
    guard BookClubCarPlay.shared.isConnected,
          let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
          let factory = provider.reactNativeFactory else { return }
    factory.rootViewFactory.initializeReactHost(
      launchOptions: nil,
      bundleConfiguration: factory.bundleConfiguration,
      devMenuConfiguration: factory.devMenuConfiguration ?? RCTDevMenuConfiguration.default()
    )
  }
}

/** In older WebKit a queued file request can still try to present a camera after the edge (D266). */
final class BookClubPhoneViewController: UIViewController {
  override func present(_ viewControllerToPresent: UIViewController, animated: Bool, completion: (() -> Void)? = nil) {
    if BookClubCarPlay.shared.isConnected, let picker = viewControllerToPresent as? UIImagePickerController,
       picker.sourceType == .camera {
      picker.delegate?.imagePickerControllerDidCancel?(picker)
      completion?()
      return
    }
    super.present(viewControllerToPresent, animated: animated, completion: completion)
  }
}

/** Select one Expo Updates launch bundle before either scene starts React Native (D265). */
@MainActor
final class BookClubReactStartup: NSObject, AppControllerDelegate {
  static let shared = BookClubReactStartup()

  // React Native can query its factory delegate off the main thread after startup.
  nonisolated static var bundleURL: URL? {
    AppController.isInitialized() ? AppController.sharedInstance.launchAssetUrl() : nil
  }

  private var ready = false
  private var pending: [(window: Bool, start: () -> Void)] = []

  func prepare(window: Bool = false, _ start: @escaping () -> Void) {
    if ready { start(); return }
    pending.append((window, start))
    guard pending.count == 1 else { return }

    AppController.initializeWithoutStarting()
    let updates = AppController.sharedInstance
    guard updates.isActiveController else { finish(); return }
    updates.delegate = self
    updates.start()
  }

  nonisolated func appController(_ appController: AppControllerInterface, didStartWithSuccess success: Bool) {
    DispatchQueue.main.async { self.finish() }
  }

  private func finish() {
    guard !ready else { return }
    ready = true
    let waiting = pending
    pending.removeAll()
    // If the phone arrives during selection, its launch options belong to the initial host.
    for next in waiting where next.window { next.start() }
    for next in waiting where !next.window { next.start() }
  }
}
