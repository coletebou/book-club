// What CarPlay shows (D221), as JavaScript builds it (src/carplay/model.ts's CarPlayModel): drawn as
// is by CarPlayController.swift. Foundation only, so scripts/test-carplay-swift.sh decodes the
// shared vectors (src/carplay/carplay-vectors.json) with plain swiftc on macOS.
import Foundation

public struct CarRow: Decodable, Equatable {
  public let id: String
  public let title: String
  public let detail: String?
  public let coverBookId: String?
  public let playing: Bool
  /** Club books only: whether it plays in the car (its audiobook was opened on this phone). */
  public let playable: Bool?
}

public struct CarChapters: Decodable, Equatable {
  public let bookId: String
  public let title: String
  public let rows: [CarRow]
}

public struct CarNav: Decodable, Equatable {
  public let seq: Int
  /** "nowPlaying", "chapters" or "message". */
  public let to: String
  public let message: String?
}

public struct CarModel: Decodable, Equatable {
  public let continueRow: CarRow?
  public let books: [CarRow]
  public let chapters: CarChapters?
  public let nav: CarNav?

  enum CodingKeys: String, CodingKey {
    case continueRow = "continue"
    case books, chapters, nav
  }

  public static let empty = CarModel(continueRow: nil, books: [], chapters: nil, nav: nil)

  /** The model in `json`, or nil when it is not one (nothing is drawn from a malformed one). */
  public static func decode(_ json: String) -> CarModel? {
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(CarModel.self, from: data)
  }
}
