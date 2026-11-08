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

  /**
   * Keep the page's snapshot for the widgets (D188) and each book's cover, which the widgets
   * cannot fetch (they have no session; this app's URLSession has the page's cookies, D133), then
   * have them draw again. Covers already kept are not fetched again unless their URL changed.
   */
  public static func setWidgetSnapshot(json: String, covers: [String: String]) async {
    let defaults = UserDefaults(suiteName: appGroup)
    defaults?.set(json, forKey: "snapshot")
    if let dir = container?.appendingPathComponent("covers") {
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      var kept = defaults?.dictionary(forKey: "coverUrls") as? [String: String] ?? [:]
      for (bookId, url) in covers {
        let file = dir.appendingPathComponent("\(safe(bookId)).img")
        if kept[bookId] == url, FileManager.default.fileExists(atPath: file.path) { continue }
        guard let remote = URL(string: url), let (data, response) = try? await URLSession.shared.data(from: remote),
              (response as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else { continue }
        try? data.write(to: file, options: .atomic)
        kept[bookId] = url
      }
      defaults?.set(kept, forKey: "coverUrls")
    }
    WidgetCenter.shared.reloadAllTimelines()
  }

  /** Forget everything the widgets show (signing out clears the device, D9 of the web app's offline rules). */
  public static func clearWidgets() {
    let defaults = UserDefaults(suiteName: appGroup)
    defaults?.removeObject(forKey: "snapshot")
    defaults?.removeObject(forKey: "coverUrls")
    if let dir = container?.appendingPathComponent("covers") { try? FileManager.default.removeItem(at: dir) }
    WidgetCenter.shared.reloadAllTimelines()
  }

  /** The snapshot the widgets draw, as the page last gave it (D188), or nil. */
  public static func widgetSnapshot() -> String? {
    UserDefaults(suiteName: appGroup)?.string(forKey: "snapshot")
  }

  /** Where a book's cover is kept for the widgets, if it is (CarPlay draws it too, D221). */
  public static func coverFile(_ bookId: String) -> URL? {
    guard let file = container?.appendingPathComponent("covers").appendingPathComponent("\(safe(bookId)).img"),
          FileManager.default.fileExists(atPath: file.path) else { return nil }
    return file
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
