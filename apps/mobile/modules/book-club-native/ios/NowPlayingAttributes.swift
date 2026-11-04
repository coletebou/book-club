// The audiobook's Live Activity (D189). KEEP IDENTICAL to
// apps/mobile/modules/book-club-native/ios/NowPlayingAttributes.swift: ActivityKit pairs the app's
// activity with this extension's view by the type's name and shape (src/widgets/files.test.ts checks).
import ActivityKit
import Foundation

public struct NowPlayingAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /** The chapter playing, as the lock screen names it. */
    public var chapter: String
    public var playing: Bool
    /** When the chapter (the file playing) would have started, at this speed: elapsed time is drawn from it. */
    public var startedAt: Date
    /** When it would end, at this speed. */
    public var endsAt: Date
    /** Where in it playback is, 0 to 1 (shown while paused). */
    public var fraction: Double
    /** How far through the book, 0 to 100. */
    public var bookPercent: Int
  }

  public var bookId: String
  public var title: String
  public var author: String
}
