// The watch app (D222), the phone's half: what plays now goes to the watch (WatchConnectivity's
// application context, which the watch reads whenever it opens, and a message too while it is
// awake), and the watch's buttons come back as commands for the one player, through JavaScript
// (BookClubNativeModule's `onWatchCommand`). Nothing but the Live Activity's own record travels:
// your book's title, author and chapter, and your place in it.
import Foundation
import WatchConnectivity

public final class BookClubWatch: NSObject, WCSessionDelegate {
  public static let shared = BookClubWatch()
  /** Posted on the main thread with `userInfo["command"]`: "toggle", "back" or "forward". */
  static let command = Notification.Name("ai.badland.books.watch-command")
  static let commands: Set<String> = ["toggle", "back", "forward"]

  private var started = false
  /** The newest state, sent once the session is active (the app may be told before it is). */
  private var latest: [String: Any] = ["np": ""]

  private override init() {
    super.init()
  }

  /** Called as the module is created: a session only on a phone that can pair a watch. */
  func start() {
    guard WCSession.isSupported(), !started else { return }
    started = true
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  /** What plays now (a NowPlayingRecord as JSON), or nil for nothing. */
  func update(_ json: String?) {
    let next: [String: Any] = ["np": json ?? "", "sent": Date().timeIntervalSince1970]
    // On the main thread, as every delegate callback here sends from it too.
    DispatchQueue.main.async {
      self.latest = next
      self.send()
    }
  }

  private func send() {
    guard started else { return }
    let session = WCSession.default
    guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
    try? session.updateApplicationContext(latest)
    if session.isReachable { session.sendMessage(latest, replyHandler: nil, errorHandler: nil) }
  }

  public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    if activationState == .activated { DispatchQueue.main.async { self.send() } }
  }

  public func sessionDidBecomeInactive(_ session: WCSession) {}

  /** Another watch was paired: the session starts again for it. */
  public func sessionDidDeactivate(_ session: WCSession) {
    WCSession.default.activate()
  }

  public func sessionReachabilityDidChange(_ session: WCSession) {
    if session.isReachable { DispatchQueue.main.async { self.send() } }
  }

  public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    received(message)
  }

  public func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    received(message)
    replyHandler([:])
  }

  private func received(_ message: [String: Any]) {
    guard let command = message["command"] as? String, Self.commands.contains(command) else { return }
    DispatchQueue.main.async {
      NotificationCenter.default.post(name: Self.command, object: nil, userInfo: ["command": command])
      // A watch opened since: it gets what plays now at once.
      self.send()
    }
  }
}
