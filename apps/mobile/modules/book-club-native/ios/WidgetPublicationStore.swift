import Foundation

/** The App Group's one atomic widget publication (D268). The cover bytes share its lifetime. */
struct WidgetPublication: Codable, Sendable {
  static let maximumCoverBytes = 60 * 1024
  static let maximumCovers = 16

  struct Cover: Codable, Sendable {
    let url: String
    let image: Data
  }

  let snapshot: String?
  let covers: [String: Cover]

  static let empty = WidgetPublication(snapshot: nil, covers: [:])
}

final class WidgetPublicationStore: @unchecked Sendable {
  private let fileURL: @Sendable () -> URL?
  private let lock = NSLock()
  private var generation = UUID().uuidString
  private var cached: (date: Date, inode: UInt64, value: WidgetPublication)?

  init(fileURL: @escaping @Sendable () -> URL?) {
    self.fileURL = fileURL
  }

  func begin() -> String {
    lock.lock()
    defer { lock.unlock() }
    generation = UUID().uuidString
    return generation
  }

  func isCurrent(_ expected: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return generation == expected
  }

  /** A present but unreadable file never falls back to an older publication. */
  func load() -> WidgetPublication? {
    lock.lock()
    defer { lock.unlock() }
    guard let url = fileURL() else { return nil }
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else {
      cached = nil
      return FileManager.default.fileExists(atPath: url.path) ? .empty : nil
    }
    let date = attributes[.modificationDate] as? Date
    let inode = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value
    if let cached, cached.date == date && cached.inode == inode { return cached.value }
    cached = nil
    guard let data = try? Data(contentsOf: url) else { return .empty }
    guard let publication = try? PropertyListDecoder().decode(WidgetPublication.self, from: data) else { return .empty }
    if let date, let inode { cached = (date, inode, publication) }
    return publication
  }

  func publish(_ publication: WidgetPublication, generation expected: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard generation == expected else { return false }
    let bounded = publication.covers.lazy
      .filter { !$0.value.image.isEmpty && $0.value.image.count <= WidgetPublication.maximumCoverBytes }
      .prefix(WidgetPublication.maximumCovers)
    let covers = Dictionary(uniqueKeysWithValues: bounded.map { ($0.key, $0.value) })
    return write(.init(snapshot: publication.snapshot, covers: covers))
  }

  /** Leave an empty record so a cleared account cannot reappear through the build 7 fallback. */
  func clear() {
    lock.lock()
    defer { lock.unlock() }
    generation = UUID().uuidString
    if !write(.empty), let url = fileURL() { try? FileManager.default.removeItem(at: url) }
  }

  private func write(_ publication: WidgetPublication) -> Bool {
    guard let url = fileURL() else { return false }
    cached = nil
    do {
      let encoder = PropertyListEncoder()
      encoder.outputFormat = .binary
      try encoder.encode(publication).write(to: url, options: .atomic)
      return true
    } catch {
      return false
    }
  }
}
