// Book Club's local Expo module (D189): the JavaScript side's way to the widget extension (through
// the App Group) and to the audiobook's Live Activity. The work is in NowPlayingController.swift.
import ExpoModulesCore

struct NowPlayingRecord: Record {
  @Field var bookId: String = ""
  @Field var title: String = ""
  @Field var author: String = ""
  @Field var chapter: String = ""
  @Field var playing: Bool = false
  @Field var startedAt: Double = 0
  @Field var endsAt: Double = 0
  @Field var fraction: Double = 0
  @Field var bookPercent: Int = 0
}

public class BookClubNativeModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("BookClubNative")

    /** The Live Activity's Play/Pause was pressed: JavaScript has the player toggle. */
    Events("onTogglePlayback")

    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(forName: BookClubShared.togglePlayback, object: nil, queue: .main) { [weak self] _ in
        self?.sendEvent("onTogglePlayback", [:])
      }
    }

    OnStopObserving {
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
      self.observer = nil
    }

    AsyncFunction("setWidgetSnapshot") { (json: String, covers: [String: String]) in
      await BookClubShared.setWidgetSnapshot(json: json, covers: covers)
    }

    Function("clearWidgets") {
      BookClubShared.clearWidgets()
    }

    /**
     * Share the signed-in session with the Messages extension (D220), or delete what was shared
     * when there is none: whether the system holds a session cookie for `origin` is the truth.
     */
    /**
     * The session for the Messages extension (D220): kept only in a build that has the extension,
     * and only while the page says someone is signed in; deleted otherwise.
     */
    Function("shareSession") { (origin: String, signedIn: Bool) -> Bool in
      let hasExtension = Bundle.main.builtInPlugInsURL.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("BookClubMessages.appex").path) } ?? false
      guard signedIn, hasExtension, let url = URL(string: origin) else {
        SharedSession.store(nil)
        return false
      }
      let cookies = HTTPCookieStorage.shared.cookies(for: url) ?? []
      return SharedSession.store(SharedSession.fromCookies(cookies, origin: origin))
    }

    Function("liveActivitiesAllowed") { () -> Bool in
      NowPlayingActivity.allowed
    }

    AsyncFunction("showNowPlaying") { (record: NowPlayingRecord) in
      await NowPlayingActivity.show(NowPlayingInput(bookId: record.bookId, title: record.title, author: record.author, chapter: record.chapter, playing: record.playing, startedAtMs: record.startedAt, endsAtMs: record.endsAt, fraction: record.fraction, bookPercent: record.bookPercent))
    }

    AsyncFunction("endNowPlaying") {
      await NowPlayingActivity.end()
    }
  }
}
