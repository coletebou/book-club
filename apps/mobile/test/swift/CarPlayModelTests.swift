// CarPlayModel.swift (D221) against the shared vectors that src/carplay/carplay.test.ts checks
// model.ts builds: what JavaScript sends, native reads, field for field. Run by
// scripts/test-carplay-swift.sh with plain swiftc (Foundation only).
import Foundation

@main
struct CarPlayModelTests {
  @MainActor static func main() throws {
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
    check(model.books[1].detail == "Not ready for the car yet", "unplayable book says why")
    check(model.chapters?.bookId == "b1" && model.chapters?.title == "Earthsea", "chapters book")
    check(model.chapters?.rows.map(\.id) == ["chapter:b1:0", "chapter:b1:1"], "chapter ids")
    check(model.chapters?.rows.map(\.playing) == [false, true], "chapter playing")
    check(model.chapters?.rows.allSatisfy { $0.detail == nil && $0.coverBookId == nil } == true, "chapters have no detail or cover")
    check(model.upNext?.rows.map(\.id) == ["chapter:b1:0", "chapter:b1:1"], "active chapters read as Up Next")
    check(model.nav == CarNav(seq: 3, to: "nowPlaying", message: nil), "nav")
    check(model.controls?.buttons == [CarButton(id: "cal", symbol: "sparkles", system: nil), CarButton(id: "speed", symbol: nil, system: "rate")], "Now Playing's buttons")
    check(model.controls?.upNext == "Chapters", "the Up Next button's title")

    // The steps a sheet, the voice screen and their dismissal are sent as (D232): each as the model's nav.
    let navs = try (root["navs"] as! [Any]).map { nav -> CarNav in
      let withNav = ["continue": NSNull(), "books": [Any](), "chapters": NSNull(), "nav": nav] as [String: Any]
      guard let decoded = CarModel.decode(String(data: try JSONSerialization.data(withJSONObject: withNav), encoding: .utf8)!)?.nav else { fail("a vector's nav does not decode") }
      return decoded
    }
    check(navs.map(\.to) == ["sheet", "voice", "dismiss"], "the steps")
    check(navs[0].message == "React" && navs[0].actions == [CarAction(id: "react:heart", title: "Loved that", style: nil), CarAction(id: "react:none", title: "Cancel", style: "cancel")], "a sheet's choices")
    check(navs[1].voice == CarVoice(states: [CarVoiceState(id: "listening", title: "Listening…", symbol: "waveform"), CarVoiceState(id: "thinking", title: "Thinking…", symbol: nil)], state: "listening", cancel: "Done"), "the voice screen")
    check(navs[2].actions == nil && navs[2].voice == nil, "a dismissal carries nothing")

    check(CarModel.decode("not json") == nil, "malformed JSON draws nothing")
    check(CarModel.decode(#"{"books":[{"id":1}]}"#) == nil, "a malformed row draws nothing")
    // A model from JavaScript older than D232 has no controls: Now Playing is then CarPlay's plain one.
    check(CarModel.decode(#"{"continue":null,"books":[],"chapters":null,"nav":null}"#) == .empty, "the empty model")
    check(CarModel.empty.controls == nil, "no controls unless the model gives them")
    // What an update made after this build sends decodes on its own: controls without their buttons,
    // or a nav that is not one, are left out, and the rows in the same model are still drawn.
    let rows = #""continue":null,"books":[{"id":"book:b1","title":"Earthsea","detail":null,"coverBookId":"b1","playing":false}],"chapters":null"#
    let badControls = CarModel.decode("{\(rows),\"nav\":null,\"controls\":{\"upNext\":\"Chapters\"}}")
    check(badControls?.books.map(\.id) == ["book:b1"] && badControls?.controls == nil, "malformed controls leave the rows")
    let badNav = CarModel.decode("{\(rows),\"nav\":{\"to\":7},\"controls\":{\"buttons\":[]}}")
    check(badNav?.books.count == 1 && badNav?.nav == nil && badNav?.controls == CarControls(buttons: [], upNext: nil), "a malformed nav leaves the rows and the controls")

    var previous = root["model"] as! [String: Any]
    previous.removeValue(forKey: "upNext")
    let legacy = CarModel.decode(String(data: try JSONSerialization.data(withJSONObject: previous), encoding: .utf8)!)
    check(legacy?.upNext?.bookId == "b1", "old models use Chapters for Up Next")
    previous["upNext"] = NSNull()
    let idle = CarModel.decode(String(data: try JSONSerialization.data(withJSONObject: previous), encoding: .utf8)!)
    check(idle?.chapters?.bookId == "b1" && idle?.upNext == nil, "no active chapters is explicit")

    let longBook = CarChapters(bookId: "b1", title: "Earthsea", rows: ["bookmark:b1", "chapter:b1:0", "chapter:b1:1", "chapter:b1:2"].map {
      CarRow(id: $0, title: $0, detail: nil, coverBookId: nil, playing: false, playable: nil)
    })
    check(longBook.rows(limitedTo: 4) == longBook.rows, "uncapped list stays ordered")
    check(longBook.rows(limitedTo: 3).map(\.id) == ["bookmark:b1", "chapter:b1:0", "chapter:b1:2"], "bookmark and final chapter both fit")
    check(longBook.rows(limitedTo: 2).map(\.id) == ["bookmark:b1", "chapter:b1:2"], "two slots keep both required rows")
    check(longBook.rows(limitedTo: 1).map(\.id) == ["chapter:b1:2"], "a one-slot list keeps the final chapter")
    checkConnection()
    checkStartupGate()
    try checkWidgetPublication()
    print("CarPlay model, connection and widget publication: all checks passed")
  }

  static func checkConnection() {
    let connection = CarPlayConnection()
    var events: [String] = []
    func recordingBlocked() -> Bool {
      let request = NSMutableDictionary()
      NotificationCenter.default.post(name: Notification.Name("ai.badland.books.carplay-audio-mode"), object: request)
      return request["recordingBlocked"] as? Bool == true
    }
    check(!recordingBlocked(), "the phone may record when there is no car")
    connection.onCommand = { events.append($0) }
    check(events == ["disconnected"], "an initial subscriber receives disconnected")
    connection.onCommand = nil
    connection.setConnected(true)
    connection.send("previous tap")
    connection.setConnected(false)
    connection.setConnected(true)
    connection.send("continue")
    check(connection.isConnected, "the getter sees the connection before a listener")
    check(recordingBlocked(), "a native mode written before JavaScript listens must be playback-only")
    events.removeAll()
    connection.onCommand = { events.append($0) }
    check(events == ["connected", "continue"], "only the current connection's tap follows the initial state")
    connection.setConnected(false)
    check(events == ["connected", "continue", "disconnected"] && !connection.isConnected, "the next edge reaches the listener and getter")
    check(!recordingBlocked(), "disconnect releases the native audio mode guard")
  }

  @MainActor static func checkStartupGate() {
    let gate = CarPlayStartupGate()
    var timeout: (@MainActor () -> Void)?
    var selections = 0
    var started: [String] = []
    var paths: [String] = []
    let downloaded = URL(fileURLWithPath: "/tmp/downloaded.jsbundle")
    gate.prepare(window: false, start: { started.append("car") }, select: { selections += 1 },
                 scheduleTimeout: { timeout = $0 }, report: { paths.append($0) })
    gate.prepare(window: true, start: { started.append("phone") }, select: { selections += 1 },
                 scheduleTimeout: { _ in fail("both scenes select once") }, report: { paths.append($0) })
    check(selections == 1 && started.isEmpty && timeout != nil, "both scenes wait on the first selection")
    timeout?() // The stubbed updates controller never called back.
    check(started == ["phone", "car"] && gate.bundleURL == nil, "timeout opens both scenes with the default bundle")
    gate.finish(bundle: downloaded, path: "late update", report: { paths.append($0) })
    check(gate.bundleURL == nil && started.count == 2 && paths == ["timeout (embedded fallback)"], "a late callback cannot switch bundles or restart a scene")

    let successful = CarPlayStartupGate()
    successful.prepare(window: false, start: { started.append("ready") }, select: {},
                       scheduleTimeout: { timeout = $0 }, report: { paths.append($0) })
    successful.finish(bundle: downloaded, path: "Expo Updates", report: { paths.append($0) })
    timeout?()
    successful.prepare(window: true, start: { started.append("later phone") }, select: { fail("selection already finished") },
                       scheduleTimeout: { _ in fail("timer already scheduled") }, report: { paths.append($0) })
    check(successful.bundleURL == downloaded && started.suffix(2) == ["ready", "later phone"], "a completed selection survives the timeout and a later phone scene")
    check(paths.last == "Expo Updates" && paths.count == 2, "only the winning launch paths are recorded")
  }

  static func checkWidgetPublication() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("widget-publication.plist")
    let store = WidgetPublicationStore { file }
    check(store.load() == nil, "an absent file can migrate the previous build")
    let old = WidgetPublication(snapshot: "previous account", covers: [
      "b1": .init(url: "https://example.test/previous", image: Data([1, 2])),
      "oversized": .init(url: "https://example.test/oversized", image: Data(repeating: 0xff, count: 60 * 1024 + 1)),
    ])
    check(store.publish(old, generation: store.begin()), "the first snapshot and cover are committed")
    check(store.load()?.snapshot == "previous account" && store.load()?.covers["b1"]?.image == Data([1, 2]), "both values read from one publication")
    check(store.load()?.covers["oversized"] == nil, "an oversized cover cannot bloat the publication")
    let reader = WidgetPublicationStore { file }
    check(reader.load()?.snapshot == "previous account", "a second process can cache the decoded publication")
    let previousDate = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as! Date
    let downloading = store.begin()
    store.clear()
    try FileManager.default.setAttributes([.modificationDate: previousDate], ofItemAtPath: file.path)
    check(!store.publish(old, generation: downloading), "an old download cannot recreate the cleared cover")
    check(reader.load()?.snapshot == nil && reader.load()?.covers.isEmpty == true, "atomic replacement invalidates the cache even when modification times match")
    let reopened = WidgetPublicationStore { file }
    check(reopened.load()?.snapshot == nil && reopened.load()?.covers.isEmpty == true, "a new process sees a cleared publication")
    let newer = WidgetPublication(snapshot: "new account", covers: [:])
    check(store.publish(newer, generation: store.begin()), "a new account can publish after clearing")
    check(!store.publish(old, generation: downloading) && store.load()?.snapshot == "new account", "a late write cannot replace the new account")
    let many = Dictionary(uniqueKeysWithValues: (1...20).map { ("b\($0)", WidgetPublication.Cover(url: "https://example.test/cover", image: Data([1]))) })
    check(store.publish(.init(snapshot: "new account", covers: many), generation: store.begin()), "a large cover set publishes")
    check(store.load()?.covers.count == 16, "the aggregate cover set stays bounded")
  }

  static func check(_ ok: Bool, _ what: String) {
    if !ok { fail(what) }
  }

  static func fail(_ what: String) -> Never {
    FileHandle.standardError.write("CarPlayModel FAILED: \(what)\n".data(using: .utf8)!)
    exit(1)
  }
}
