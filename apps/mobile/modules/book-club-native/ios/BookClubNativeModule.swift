// Book Club's local Expo module (D189): the JavaScript side's way to the widget extension (through
// the App Group), to the audiobook's Live Activity, and to CarPlay's templates (D221). The work is in
// NowPlayingController.swift and CarPlayController.swift.
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

    /** The Live Activity's Play/Pause was pressed (JavaScript has the player toggle); a row was tapped in the car. */
    Events("onTogglePlayback", "onCarPlayCommand")

    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(forName: BookClubShared.togglePlayback, object: nil, queue: .main) { [weak self] _ in
        self?.sendEvent("onTogglePlayback", [:])
      }
      // A row tapped in the car (D221): its id, for src/carplay/CarPlayDriver.ts. Set on the main
      // thread, where CarPlay's taps and models are handled.
      DispatchQueue.main.async {
        BookClubCarPlay.shared.onCommand = { [weak self] id in self?.sendEvent("onCarPlayCommand", ["id": id]) }
      }
    }

    OnStopObserving {
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
      self.observer = nil
      DispatchQueue.main.async { BookClubCarPlay.shared.onCommand = nil }
    }

    AsyncFunction("setWidgetSnapshot") { (json: String, covers: [String: String]) in
      await BookClubShared.setWidgetSnapshot(json: json, covers: covers)
    }

    Function("clearWidgets") {
      BookClubShared.clearWidgets()
    }

    /** What CarPlay shows (D221, src/carplay/model.ts), drawn as is while a car is connected. */
    Function("setCarPlayModel") { (json: String) in
      BookClubCarPlay.shared.setModel(json)
    }

    /** The widgets' snapshot as the App Group keeps it (D188): the books the car lists. */
    Function("widgetSnapshot") { () -> String? in
      BookClubShared.widgetSnapshot()
    }

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
