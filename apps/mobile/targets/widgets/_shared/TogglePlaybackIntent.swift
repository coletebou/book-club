// Play and Pause from the Live Activity (D189). Linked into the app and the widget extension
// (@bacons/apple-targets' `_shared`): a LiveActivityIntent runs in the app's process, where the
// local module (BookClubNativeModule) hears this notification and has the player toggle.
import AppIntents
import Foundation

public let bookClubTogglePlayback = Notification.Name("ai.badland.books.toggle-playback")

@available(iOS 17.0, *)
public struct TogglePlaybackIntent: LiveActivityIntent {
  public static var title: LocalizedStringResource = "Play or pause the audiobook"
  public static var isDiscoverable: Bool = false

  public init() {}

  public func perform() async throws -> some IntentResult {
    await MainActor.run { NotificationCenter.default.post(name: bookClubTogglePlayback, object: nil) }
    return .result()
  }
}
