// The widgets' data and the audiobook's Live Activity (D189), without Expo: plain Swift the module
// (BookClubNativeModule.swift) calls, so this compiles and typechecks against the iOS SDK alone.
import ActivityKit
import Foundation
import WidgetKit

public enum BookClubShared {
  public static let appGroup = "group.ai.badland.books"
  /** Posted by the Live Activity's Play/Pause (TogglePlaybackIntent, in the app's process). */
  public static let togglePlayback = Notification.Name("ai.badland.books.toggle-playback")

  static var container: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) }
  static let widgetPublications = WidgetPublicationStore { BookClubShared.container?.appendingPathComponent("widget-publication.plist") }

  /**
   * Keep the page's snapshot for the widgets (D188) and each book's cover, which the widgets
   * cannot fetch (they have no session; this app's URLSession has the page's cookies, D133), then
   * have them draw again. Covers already kept are not fetched again unless their URL changed.
   */
  static func setWidgetSnapshot(json: String, covers: [String: String], generation: String) async -> Bool {
    let prior = widgetPublications.load()
    let legacyURLs = prior == nil ? UserDefaults(suiteName: appGroup)?.dictionary(forKey: "coverUrls") as? [String: String] : nil
    var staged: [String: WidgetPublication.Cover] = [:]
    for (bookId, url) in covers {
      guard widgetPublications.isCurrent(generation) else { return false }
      if let kept = prior?.covers[bookId], kept.url == url {
        staged[bookId] = kept
      } else if legacyURLs?[bookId] == url, let image = legacyCover(bookId) {
        staged[bookId] = .init(url: url, image: image)
      } else if let remote = URL(string: url), remote.scheme == "https" || remote.scheme == "http",
                let (data, response) = try? await URLSession.shared.data(from: remote),
                (response as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty {
        staged[bookId] = .init(url: url, image: data)
      }
    }
    guard widgetPublications.publish(.init(snapshot: json, covers: staged), generation: generation) else { return false }
    if prior == nil { clearLegacyWidgets() }
    WidgetCenter.shared.reloadAllTimelines()
    return true
  }

  /** Forget everything the widgets show (signing out clears the device, D9 of the web app's offline rules). */
  public static func clearWidgets() {
    // Clear the legacy fallback before replacing the publication with a tombstone (D268).
    clearLegacyWidgets()
    widgetPublications.clear()
    WidgetCenter.shared.reloadAllTimelines()
  }

  private static func clearLegacyWidgets() {
    let defaults = UserDefaults(suiteName: appGroup)
    defaults?.removeObject(forKey: "snapshot")
    defaults?.removeObject(forKey: "coverUrls")
    if let dir = container?.appendingPathComponent("covers") { try? FileManager.default.removeItem(at: dir) }
  }

  /** The snapshot the widgets draw, as the page last gave it (D188), or nil. */
  public static func widgetSnapshot() -> String? {
    if let published = widgetPublications.load() { return published.snapshot }
    return UserDefaults(suiteName: appGroup)?.string(forKey: "snapshot")
  }

  /** Where a book's cover is kept for the widgets, if it is (CarPlay draws it too, D221). */
  public static func widgetCover(_ bookId: String) -> Data? {
    if let published = widgetPublications.load() { return published.covers[bookId]?.image }
    return legacyCover(bookId)
  }

  private static func legacyCover(_ bookId: String) -> Data? {
    guard let file = container?.appendingPathComponent("covers").appendingPathComponent("\(safe(bookId)).img") else { return nil }
    return try? Data(contentsOf: file)
  }

  private static func safe(_ id: String) -> String { id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" } }
}

/** A Live Activity's state, as the module is given it (times in ms since the epoch). */
public struct NowPlayingInput {
  public var bookId: String
  public var title: String
  public var author: String
  public var chapter: String
  public var playing: Bool
  public var startedAtMs: Double
  public var endsAtMs: Double
  public var fraction: Double
  public var bookPercent: Int

  public init(bookId: String, title: String, author: String, chapter: String, playing: Bool, startedAtMs: Double, endsAtMs: Double, fraction: Double, bookPercent: Int) {
    self.bookId = bookId
    self.title = title
    self.author = author
    self.chapter = chapter
    self.playing = playing
    self.startedAtMs = startedAtMs
    self.endsAtMs = endsAtMs
    self.fraction = fraction
    self.bookPercent = bookPercent
  }

  var state: NowPlayingAttributes.ContentState {
    .init(chapter: chapter, playing: playing, startedAt: Date(timeIntervalSince1970: startedAtMs / 1000), endsAt: Date(timeIntervalSince1970: endsAtMs / 1000), fraction: min(1, max(0, fraction)), bookPercent: min(100, max(0, bookPercent)))
  }
}

public enum NowPlayingActivity {
  /** Whether the person allows this app's Live Activities (iOS's own switch, Settings › Book Club). */
  public static var allowed: Bool {
    if #available(iOS 16.2, *) { return ActivityAuthorizationInfo().areActivitiesEnabled }
    return false
  }

  /**
   * Show the audiobook: update the activity already showing this book, else end any other and
   * start one. Paused, it is stale after ten minutes (the system dims it); playing, at the chapter's end.
   */
  public static func show(_ input: NowPlayingInput) async {
    guard #available(iOS 16.2, *), allowed else { return }
    let stale = input.playing ? Date(timeIntervalSince1970: input.endsAtMs / 1000) : Date().addingTimeInterval(600)
    let content = ActivityContent(state: input.state, staleDate: stale)
    let running = Activity<NowPlayingAttributes>.activities
    if let same = running.first(where: { $0.attributes.bookId == input.bookId && $0.activityState == .active }) {
      await same.update(content)
      for other in running where other.id != same.id { await other.end(nil, dismissalPolicy: .immediate) }
      return
    }
    for other in running { await other.end(nil, dismissalPolicy: .immediate) }
    _ = try? Activity.request(attributes: NowPlayingAttributes(bookId: input.bookId, title: input.title, author: input.author), content: content, pushType: nil)
  }

  /** The audiobook stopped (unloaded, signed out, the Live Activity turned off): the activity goes. */
  public static func end() async {
    guard #available(iOS 16.2, *) else { return }
    for activity in Activity<NowPlayingAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
  }
}
