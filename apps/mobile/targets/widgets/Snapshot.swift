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
  /** The latest snapshot the app was given, or nil (signed out, or never opened). */
  static func load() -> WidgetSnapshot? {
    guard let text = UserDefaults(suiteName: appGroup)?.string(forKey: "snapshot"), let data = text.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
  }

  /** A book's cover, as the app downloaded it into the App Group (covers/<book id>.img). */
  static func cover(_ bookId: String) -> UIImage? {
    guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
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
