// The Swift half of the message format against the same golden vectors as the TypeScript half
// (packages/shared/src/messages/imessage-vectors.json). Run with scripts/test-messages-swift.sh:
// plain swiftc on macOS, no simulator, no Xcode project.
import Foundation

struct Vector: Decodable { let payload: [String: Value]; let url: String }
enum Value: Decodable {
  case s(String), n(Int)
  init(from d: Decoder) throws { let c = try d.singleValueContainer(); if let n = try? c.decode(Int.self) { self = .n(n) } else { self = .s(try c.decode(String.self)) } }
  var str: String { if case let .s(v) = self { return v }; if case let .n(v) = self { return String(v) }; return "" }
  var int: Int { if case let .n(v) = self { return v }; return Int(str) ?? -1 }
}
struct Vectors: Decodable { let origin: String; let valid: [Vector]; let invalid: [String] }

func message(_ p: [String: Value]) -> BookClubMessage {
  let s = { (k: String) in p[k]?.str ?? "" }, n = { (k: String) in p[k]?.int ?? -1 }
  switch s("k") {
  case "invite": return .invite(club: s("c"), code: s("i"), clubName: s("n"))
  case "progress": return .progress(club: s("c"), book: s("b"), title: s("t"), chapter: n("ch"), of: n("of"))
  case "quote": return .quote(club: s("c"), book: s("b"), title: s("t"), comment: s("q"), chapter: n("ch"))
  case "vote": return .vote(club: s("c"), round: s("r"))
  default: return .rsvp(club: s("c"), book: s("b"), title: s("t"))
  }
}

var failures = 0
func check(_ ok: Bool, _ what: String) { if !ok { failures += 1; print("FAIL: \(what)") } }

@main struct Main {
  static func main() throws {
    let path = CommandLine.arguments[1]
    let v = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    for vec in v.valid {
      let m = message(vec.payload)
      check(m.url(origin: v.origin)?.absoluteString == vec.url, "encode \(vec.url) got \(m.url(origin: v.origin)?.absoluteString ?? "nil")")
      check(m.url(origin: v.origin + "/")?.absoluteString == vec.url, "trailing slash \(vec.url)")
      check(BookClubMessage(url: URL(string: vec.url)!) == m, "decode \(vec.url)")
      check(m.target.hasPrefix("/") && !m.target.hasPrefix("//"), "target \(m.target)")
    }
    for bad in v.invalid { check(URL(string: bad).flatMap(BookClubMessage.init(url:)) == nil, "reject \(bad)") }
    // never a message it cannot carry
    check(BookClubMessage.progress(club: "club_0001", book: "book_00001", title: "<b>", chapter: 1, of: 2).url(origin: v.origin) == nil, "markup title")
    check(BookClubMessage.vote(club: "../etc", round: "round_0007").url(origin: v.origin) == nil, "path in id")
    print(failures == 0 ? "ok: \(v.valid.count) valid, \(v.invalid.count) invalid vectors" : "\(failures) failure(s)")
    exit(failures == 0 ? 0 : 1)
  }
}
