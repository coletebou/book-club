import Foundation

/** The App Group's one atomic widget publication (D268). The cover bytes share its lifetime. */
struct WidgetPublication: Codable {
  struct Cover: Codable {
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
    guard let url = fileURL(), FileManager.default.fileExists(atPath: url.path) else { return nil }
    guard let data = try? Data(contentsOf: url) else { return .empty }
    return (try? PropertyListDecoder().decode(WidgetPublication.self, from: data)) ?? .empty
  }

  func publish(_ publication: WidgetPublication, generation expected: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard generation == expected else { return false }
    return write(publication)
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
