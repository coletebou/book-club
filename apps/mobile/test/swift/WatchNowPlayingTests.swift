// The watch's NowPlaying.swift (D222) against the record test/watch-app.test.ts checks recordOf
// makes. Run by scripts/test-watch-swift.sh with plain swiftc (Foundation only).
import Foundation

@main
struct WatchNowPlayingTests {
  static var failures = 0
  static func check(_ ok: Bool, _ what: String) { if !ok { failures += 1; print("FAIL: \(what)") } }

  static func main() throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let root = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let record = String(data: try JSONSerialization.data(withJSONObject: root["record"]!), encoding: .utf8)!
    let now = Date(timeIntervalSince1970: (root["now"] as! Double) / 1000)

    guard let np = NowPlaying.from(["np": record]) else { print("FAIL: the record does not decode"); exit(1) }
    check(np.title == "A Wizard of Earthsea" && np.chapter == "Chapter 4" && np.playing && np.bookPercent == 32, "fields")
    check(abs(np.progress(at: now) - 0.25) < 0.0001, "progress now, from the clock")
    check(abs(np.progress(at: now.addingTimeInterval(400)) - 0.75) < 0.0001, "progress later (1.5x: 400 s of clock is 600 s of audio)")
    check(np.progress(at: now.addingTimeInterval(10_000)) == 1, "progress stops at the end")
    check(np.leftLabel(at: now) == "10 min left", "time left at this speed: \(np.leftLabel(at: now) ?? "nil")")

    let paused = record.replacingOccurrences(of: "\"playing\":true", with: "\"playing\":false")
    let p = NowPlaying.from(["np": paused])
    check(p?.playing == false && p?.progress(at: now.addingTimeInterval(400)) == 0.25, "paused: as recorded, whatever the clock")
    check(p?.leftLabel(at: now.addingTimeInterval(9_999)) == "10 min left", "paused: time left does not run")

    check(NowPlaying.from(["np": ""]) == nil, "nothing playing")
    check(NowPlaying.from([:]) == nil, "no state")
    check(NowPlaying.from(["np": "{\"bookId\":1}"]) == nil, "unreadable")
    let unknown = record.replacingOccurrences(of: "\"endsAt\":1800000600000", with: "\"endsAt\":1799999800000")
    check(NowPlaying.from(["np": unknown])?.span == nil && NowPlaying.from(["np": unknown])?.leftLabel(at: now) == nil, "length unknown")
    print(failures == 0 ? "NowPlaying (watch): all checks passed" : "\(failures) failure(s)")
    exit(failures == 0 ? 0 : 1)
  }
}
