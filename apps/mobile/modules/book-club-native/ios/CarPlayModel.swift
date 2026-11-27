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

/** One choice of an action sheet (D232): its tap comes back as `id`. */
public struct CarAction: Decodable, Equatable {
  public let id: String
  public let title: String
  /** "cancel" or "destructive"; anything else is an ordinary choice. */
  public let style: String?
}

/** One state of the voice screen (D232): its title, and the SF Symbol drawn above it. */
public struct CarVoiceState: Decodable, Equatable {
  public let id: String
  public let title: String
  public let symbol: String?
}

/** The voice screen (D232): its states (at most five), the one showing, and a bar button that ends it. */
public struct CarVoice: Decodable, Equatable {
  public let states: [CarVoiceState]
  public let state: String
  public let cancel: String?
}

public struct CarNav: Decodable, Equatable {
  public let seq: Int
  /** "nowPlaying", "chapters", "message", and (D232) "sheet", "voice" or "dismiss". */
  public let to: String
  public let message: String?
  /** A sheet's choices. */
  public let actions: [CarAction]?
  /** The voice screen to show, or the state to move the one showing to. */
  public let voice: CarVoice?

  public init(seq: Int, to: String, message: String? = nil, actions: [CarAction]? = nil, voice: CarVoice? = nil) {
    self.seq = seq
    self.to = to
    self.message = message
    self.actions = actions
    self.voice = voice
  }
}

/** One of Now Playing's buttons (D232): an SF Symbol of the app's own, or one of CarPlay's ("rate"). */
public struct CarButton: Decodable, Equatable {
  public let id: String
  public let symbol: String?
  public let system: String?
}

/** Now Playing's own controls (D232): its buttons, and the title of the button that opens the chapters. */
public struct CarControls: Decodable, Equatable {
  public let buttons: [CarButton]
  public let upNext: String?
}

public struct CarModel: Decodable, Equatable {
  public let continueRow: CarRow?
  public let books: [CarRow]
  public let chapters: CarChapters?
  public let nav: CarNav?
  /** Absent in a model from JavaScript older than D232: Now Playing is then CarPlay's plain one. */
  public let controls: CarControls?

  enum CodingKeys: String, CodingKey {
    case continueRow = "continue"
    case books, chapters, nav, controls
  }

  public static let empty = CarModel(continueRow: nil, books: [], chapters: nil, nav: nil, controls: nil)

  /** The model in `json`, or nil when it is not one (nothing is drawn from a malformed one). */
  public static func decode(_ json: String) -> CarModel? {
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(CarModel.self, from: data)
  }
}
