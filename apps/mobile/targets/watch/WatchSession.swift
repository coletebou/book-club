// The watch's half of WatchConnectivity (D222): what plays on the iPhone, from its application
// context (there whenever the watch opens) and its messages while both are awake; and the buttons,
// sent to the iPhone, whose player acts on them.
import Foundation
import WatchConnectivity

@MainActor
final class WatchSession: NSObject, ObservableObject, WCSessionDelegate {
  @Published private(set) var nowPlaying: NowPlaying?
  @Published private(set) var reachable = false
  @Published private(set) var heard = false

  func start() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  /** "toggle", "back" or "forward", to the iPhone; nothing when it cannot be reached. */
  func send(_ command: String) {
    let session = WCSession.default
    guard session.activationState == .activated, session.isReachable else { return }
    session.sendMessage(["command": command], replyHandler: nil, errorHandler: nil)
    // Shown at once; the iPhone's next state says what really happened.
    if command == "toggle", let np = nowPlaying {
      nowPlaying = NowPlaying(bookId: np.bookId, title: np.title, author: np.author, chapter: np.chapter, playing: !np.playing,
                              startedAt: np.startedAt, endsAt: np.endsAt, fraction: np.progress(at: Date()), bookPercent: np.bookPercent)
    }
  }

  private func apply(_ context: [String: Any]) {
    guard context["np"] != nil else { return }
    heard = true
    nowPlaying = NowPlaying.from(context)
  }

  nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    let context = session.receivedApplicationContext
    let reachable = session.isReachable
    Task { @MainActor in
      self.reachable = reachable
      self.apply(context)
    }
  }

  nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
    let reachable = session.isReachable
    Task { @MainActor in self.reachable = reachable }
  }

  nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    let context = applicationContext
    Task { @MainActor in self.apply(context) }
  }

  nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    let context = message
    Task { @MainActor in self.apply(context) }
  }
}
