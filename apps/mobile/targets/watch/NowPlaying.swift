// What the watch shows (D222): the Live Activity's own record of what plays on the iPhone
// (src/widgets/NativeExtras.ts's `recordOf`), as the phone sends it. Foundation only, so
// scripts/test-watch-swift.sh checks it against the TypeScript vectors with plain swiftc.
import Foundation

struct NowPlaying: Decodable, Equatable {
  let bookId: String
  let title: String
  let author: String
  let chapter: String
  let playing: Bool
  /** When the file playing would have started and would end, at this speed (ms since the epoch). */
  let startedAt: Double
  let endsAt: Double
  /** How far through the file, 0 to 1, when the record was made. */
  let fraction: Double
  /** How far through the audiobook, 0 to 100. */
  let bookPercent: Int

  /** The record in the phone's message (`np`): nil for nothing playing, or anything unreadable. */
  static func from(_ context: [String: Any]) -> NowPlaying? {
    guard let json = context["np"] as? String, !json.isEmpty, let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(NowPlaying.self, from: data)
  }

  var start: Date { Date(timeIntervalSince1970: startedAt / 1000) }
  var end: Date { Date(timeIntervalSince1970: endsAt / 1000) }
  /** The file's span, for a progress bar that runs by itself while it plays; nil when its length is unknown. */
  var span: ClosedRange<Date>? { endsAt > startedAt ? start...end : nil }

  /** How far through the file at `now`: from the clock while playing, as recorded while paused. */
  func progress(at now: Date) -> Double {
    guard playing, let span else { return min(1, max(0, fraction)) }
    let total = span.upperBound.timeIntervalSince(span.lowerBound)
    return min(1, max(0, now.timeIntervalSince(span.lowerBound) / total))
  }

  /** "12 min left" in the chapter at `now` (at this speed), or nil when its length is unknown. */
  func leftLabel(at now: Date) -> String? {
    guard span != nil else { return nil }
    let left = playing ? end.timeIntervalSince(now) : (1 - fraction) * end.timeIntervalSince(start)
    let minutes = Int((max(0, left) / 60).rounded(.up))
    return minutes <= 1 ? "1 min left" : "\(minutes) min left"
  }
}
