// What a Book Club message in iMessage says (D220): the Swift half of
// packages/shared/src/messages/imessage.ts, held to the same golden vectors
// (imessage-vectors.json, checked by scripts/test-messages-swift.sh). Ids, the book's title and
// the sender's own chapter only: never a passage, a comment, a cover or anyone else's progress,
// since everyone in the thread sees the same bubble and not all of them are in the club.
import Foundation

enum BookClubMessage: Equatable {
  case invite(club: String, code: String, clubName: String)
  case progress(club: String, book: String, title: String, percent: Int, chapter: Int?)
  case quote(club: String, book: String, title: String, comment: String, chapter: Int)
  case vote(club: String, round: String)
  case rsvp(club: String, book: String, title: String)

  static let version = 1
  static let path = "/m"

  // MARK: Validation (the same rules as the zod schema)

  static func isId(_ s: String) -> Bool {
    (6...64).contains(s.count) && s.unicodeScalars.allSatisfy { CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-").contains($0) }
  }
  static func cleanTitle(_ s: String) -> String? {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (1...120).contains(t.count), !t.contains(where: { "<>\n\r".contains($0) }) else { return nil }
    return t
  }
  static func isCount(_ n: Int) -> Bool { (0...100_000).contains(n) }

  var isValid: Bool {
    switch self {
    case let .invite(c, i, n): return Self.isId(c) && Self.isId(i) && i.count >= 8 && Self.cleanTitle(n) == n
    case let .progress(c, b, t, p, ch): return Self.isId(c) && Self.isId(b) && Self.cleanTitle(t) == t && (0...100).contains(p) && (ch.map(Self.isCount) ?? true)
    case let .quote(c, b, t, q, ch): return Self.isId(c) && Self.isId(b) && Self.isId(q) && Self.cleanTitle(t) == t && Self.isCount(ch)
    case let .vote(c, r): return Self.isId(c) && Self.isId(r)
    case let .rsvp(c, b, t): return Self.isId(c) && Self.isId(b) && Self.cleanTitle(t) == t
    }
  }

  // MARK: Fields, in the one order both sides write them

  private var fields: [(String, String)] {
    switch self {
    case let .invite(c, i, n): return [("k", "invite"), ("c", c), ("i", i), ("n", n)]
    case let .progress(c, b, t, p, ch): return [("k", "progress"), ("c", c), ("b", b), ("t", t), ("p", String(p))] + (ch.map { [("ch", String($0))] } ?? [])
    case let .quote(c, b, t, q, ch): return [("k", "quote"), ("c", c), ("b", b), ("q", q), ("t", t), ("ch", String(ch))]
    case let .vote(c, r): return [("k", "vote"), ("c", c), ("r", r)]
    case let .rsvp(c, b, t): return [("k", "rsvp"), ("c", c), ("b", b), ("t", t)]
    }
  }

  /// The URL the message carries: `<origin>/m#v=1&k=…`, or nil for a message that is not valid.
  func url(origin: String) -> URL? {
    guard isValid else { return nil }
    let base = origin.hasSuffix("/") ? String(origin.dropLast()) : origin
    let query = ([("v", String(Self.version))] + fields).map { "\(Self.formEncode($0.0))=\(Self.formEncode($0.1))" }.joined(separator: "&")
    return URL(string: "\(base)\(Self.path)#\(query)")
  }

  /// A message's payload, or nil for anything this version does not read.
  init?(url: URL) {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.path == Self.path, let fragment = parts.percentEncodedFragment else { return nil }
    var f: [String: String] = [:]
    for pair in fragment.split(separator: "&", omittingEmptySubsequences: true) {
      let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard let key = Self.formDecode(String(kv[0])) else { return nil }
      let value = kv.count > 1 ? Self.formDecode(String(kv[1])) : ""
      guard let value else { return nil }
      f[key] = value
    }
    guard f["v"] == String(Self.version), let kind = f["k"] else { return nil }
    f["v"] = nil
    func id(_ k: String) -> String? { f[k].flatMap { Self.isId($0) ? $0 : nil } }
    func title(_ k: String) -> String? { f[k].flatMap(Self.cleanTitle) }
    func count(_ k: String) -> Int? { f[k].flatMap { Int($0) }.flatMap { Self.isCount($0) ? $0 : nil } }
    func only(_ keys: Set<String>) -> Bool { Set(f.keys) == keys }
    let message: BookClubMessage?
    switch kind {
    case "invite":
      message = only(["k", "c", "i", "n"]) ? zip3(id("c"), id("i"), title("n")).map { .invite(club: $0, code: $1, clubName: $2) } : nil
    case "progress":
      let hasCh = f["ch"] != nil
      if only(hasCh ? ["k", "c", "b", "t", "p", "ch"] : ["k", "c", "b", "t", "p"]), let c = id("c"), let b = id("b"), let t = title("t"), let p = f["p"].flatMap({ Int($0) }), (0...100).contains(p), !hasCh || count("ch") != nil {
        message = .progress(club: c, book: b, title: t, percent: p, chapter: hasCh ? count("ch") : nil)
      } else { message = nil }
    case "quote":
      if only(["k", "c", "b", "t", "q", "ch"]), let c = id("c"), let b = id("b"), let t = title("t"), let q = id("q"), let ch = count("ch") { message = .quote(club: c, book: b, title: t, comment: q, chapter: ch) } else { message = nil }
    case "vote":
      if only(["k", "c", "r"]), let c = id("c"), let r = id("r") { message = .vote(club: c, round: r) } else { message = nil }
    case "rsvp":
      if only(["k", "c", "b", "t"]), let c = id("c"), let b = id("b"), let t = title("t") { message = .rsvp(club: c, book: b, title: t) } else { message = nil }
    default:
      message = nil
    }
    guard let message, message.isValid else { return nil }
    self = message
  }

  /// Where it opens, a path on this site only (the same as `messageTarget`).
  var target: String {
    switch self {
    case let .invite(_, code, _): return "/join/\(code)"
    case let .progress(_, book, _, _, _), let .rsvp(_, book, _): return "/books/\(book)"
    case let .quote(_, book, _, comment, _): return "/books/\(book)#note-\(comment)"
    case let .vote(club, _): return "/clubs/\(club)/next"
    }
  }

  // MARK: application/x-www-form-urlencoded, exactly as URLSearchParams writes it

  private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._")

  static func formEncode(_ s: String) -> String {
    var out = ""
    for byte in s.utf8 {
      let scalar = Unicode.Scalar(byte)
      if byte == 0x20 { out += "+" }
      else if byte < 0x80, unreserved.contains(scalar) { out.unicodeScalars.append(scalar) }
      else { out += String(format: "%%%02X", byte) }
    }
    return out
  }

  static func formDecode(_ s: String) -> String? {
    s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding
  }
}

/// The chapter number in a place as friends see it ("Chapter 4 · 23%"), as `chapterOfLabel` reads it.
func chapterOfLabel(_ label: String) -> Int? {
  let t = label.trimmingCharacters(in: .whitespacesAndNewlines)
  guard t.hasPrefix("Chapter ") else { return nil }
  let digits = t.dropFirst("Chapter ".count).prefix { $0.isASCII && $0.isNumber }
  guard (1...5).contains(digits.count) else { return nil }
  let rest = t.dropFirst("Chapter ".count + digits.count)
  guard rest.first.map({ !($0.isLetter || $0.isNumber || $0 == "_") }) ?? true else { return nil }
  return Int(digits)
}

private func zip3<A, B, C>(_ a: A?, _ b: B?, _ c: C?) -> (A, B, C)? {
  guard let a, let b, let c else { return nil }
  return (a, b, c)
}
