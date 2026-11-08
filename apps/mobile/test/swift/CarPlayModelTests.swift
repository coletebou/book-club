// CarPlayModel.swift (D221) against the shared vectors that src/carplay/carplay.test.ts checks
// model.ts builds: what JavaScript sends, native reads, field for field. Run by
// scripts/test-carplay-swift.sh with plain swiftc (Foundation only).
import Foundation

@main
struct CarPlayModelTests {
  static func main() throws {
    let path = CommandLine.arguments[1]
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let root = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let json = String(data: try JSONSerialization.data(withJSONObject: root["model"]!), encoding: .utf8)!
    guard let model = CarModel.decode(json) else { fail("the vectors' model does not decode") }

    check(model.continueRow?.id == "continue", "continue row id")
    check(model.continueRow?.title == "Earthsea" && model.continueRow?.detail == "Chapter 2", "continue row text")
    check(model.continueRow?.playing == true && model.continueRow?.coverBookId == "b1", "continue row playing and cover")
    check(model.books.map(\.id) == ["book:b1", "book:b2"], "book ids")
    check(model.books.map { $0.playable ?? false } == [true, false], "books playable")
    check(model.books[1].detail == "Open its audiobook on your iPhone first", "unplayable book says why")
    check(model.chapters?.bookId == "b1" && model.chapters?.title == "Earthsea", "chapters book")
    check(model.chapters?.rows.map(\.id) == ["chapter:b1:0", "chapter:b1:1"], "chapter ids")
    check(model.chapters?.rows.map(\.playing) == [false, true], "chapter playing")
    check(model.chapters?.rows.allSatisfy { $0.detail == nil && $0.coverBookId == nil } == true, "chapters have no detail or cover")
    check(model.nav == CarNav(seq: 3, to: "nowPlaying", message: nil), "nav")

    check(CarModel.decode("not json") == nil, "malformed JSON draws nothing")
    check(CarModel.decode(#"{"books":[{"id":1}]}"#) == nil, "a malformed row draws nothing")
    check(CarModel.decode(#"{"continue":null,"books":[],"chapters":null,"nav":null}"#) == .empty, "the empty model")
    print("CarPlayModel: all checks passed")
  }

  static func check(_ ok: Bool, _ what: String) {
    if !ok { fail(what) }
  }

  static func fail(_ what: String) -> Never {
    FileHandle.standardError.write("CarPlayModel FAILED: \(what)\n".data(using: .utf8)!)
    exit(1)
  }
}
