import Foundation

/** CarPlay commands run on the main thread. Expo can read the connection from its JavaScript thread (D266). */
final class CarPlayConnection: @unchecked Sendable {
  static let changed = Notification.Name("ai.badland.books.carplay-connection")
  private static let audioModeQuery = Notification.Name("ai.badland.books.carplay-audio-mode")

  private let lock = NSLock()
  private var connected = false
  private var pending: [String] = []
  private var audioModeObserver: NSObjectProtocol?

  init() {
    // The patched Expo Audio setter asks on its category-writing queue while it applies a mode.
    audioModeObserver = NotificationCenter.default.addObserver(forName: Self.audioModeQuery, object: nil, queue: nil) { [weak self] note in
      if self?.isConnected == true { (note.object as? NSMutableDictionary)?["recordingBlocked"] = true }
    }
  }

  deinit {
    if let audioModeObserver { NotificationCenter.default.removeObserver(audioModeObserver) }
  }

  var isConnected: Bool {
    lock.lock()
    defer { lock.unlock() }
    return connected
  }

  var onCommand: ((String) -> Void)? {
    didSet {
      guard let onCommand else { return }
      let waiting = pending
      pending.removeAll()
      onCommand(isConnected ? "connected" : "disconnected")
      waiting.forEach(onCommand)
    }
  }

  func setConnected(_ value: Bool) {
    lock.lock()
    let changed = connected != value
    connected = value
    lock.unlock()
    guard changed else { return }
    if !value { pending.removeAll() }
    // The WebView's native capture gate is updated synchronously before any JavaScript event.
    NotificationCenter.default.post(name: Self.changed, object: nil, userInfo: ["connected": value])
    onCommand?(value ? "connected" : "disconnected")
  }

  func send(_ id: String) {
    guard isConnected else { return }
    if let onCommand {
      onCommand(id)
    } else {
      pending.append(id)
      if pending.count > 8 { pending.removeFirst() }
    }
  }
}
