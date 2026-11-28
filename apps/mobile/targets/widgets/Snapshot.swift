// What the widgets show (D188, D189): the page's snapshot, kept by the app in the shared App Group.
import Foundation
import UIKit

let appGroup = "group.ai.badland.books"

struct WidgetStop: Codable, Hashable {
  let label: String
  let on: String?
  let toGo: Double
  let reached: Bool
}

struct WidgetBook: Codable, Hashable, Identifiable {
  let bookId: String
  let clubName: String
  let title: String
  let author: String
  let percent: Int
  let label: String
  let format: String?
  let finished: Bool
  let stop: WidgetStop?
  var id: String { bookId }
}

struct WidgetSnapshot: Codable {
  let generatedAt: Double
  let current: WidgetBook?
  let others: [WidgetBook]
}

enum SnapshotStore {
  private struct Publication: Decodable {
    struct Cover: Decodable { let image: Data }
    let snapshot: String?
    let covers: [String: Cover]
  }

  private final class PublicationCache: @unchecked Sendable {
    let lock = NSLock()
    var entry: (date: Date, inode: UInt64, value: Publication)?
  }
  private static let publicationCache = PublicationCache()

  /** Read build 8's single publication. An unreadable file counts as an empty display (D268). */
  private static func published(in directory: URL) -> Publication? {
    let file = directory.appendingPathComponent("widget-publication.plist")
    let cache = publicationCache
    cache.lock.lock()
    defer { cache.lock.unlock() }
    let empty = Publication(snapshot: nil, covers: [:])
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path) else {
      cache.entry = nil
      return FileManager.default.fileExists(atPath: file.path) ? empty : nil
    }
    let date = attributes[.modificationDate] as? Date
    let inode = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value
    if let entry = cache.entry, entry.date == date && entry.inode == inode { return entry.value }
    cache.entry = nil
    guard let data = try? Data(contentsOf: file),
          let publication = try? PropertyListDecoder().decode(Publication.self, from: data) else { return empty }
    if let date, let inode { cache.entry = (date, inode, publication) }
    return publication
  }

  /** The latest snapshot the app was given, or nil (signed out, or never opened). */
  static func load() -> WidgetSnapshot? {
    let text: String?
    if let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup), let publication = published(in: directory) {
      text = publication.snapshot
    } else {
      text = UserDefaults(suiteName: appGroup)?.string(forKey: "snapshot")
    }
    guard let data = text?.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
  }

  /** A book's cover, as published with the widget snapshot. */
  static func cover(_ bookId: String) -> UIImage? {
    guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
    if let publication = published(in: dir) { return publication.covers[bookId].flatMap { UIImage(data: $0.image) } }
    let file = dir.appendingPathComponent("covers").appendingPathComponent("\(bookId).img")
    guard let data = try? Data(contentsOf: file) else { return nil }
    return UIImage(data: data)
  }

  /** The app's own link to a book (D134's format): opens it on the book page. */
  static func link(_ bookId: String?) -> URL? {
    guard let bookId else { return URL(string: "bookclub:///") }
    return URL(string: "bookclub:///books/\(bookId)")
  }
}
