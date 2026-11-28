import Foundation

/** Wait once for the launch bundle, with a bounded fallback shared by both scenes (D265). */
@MainActor
public final class CarPlayStartupGate {
  private final class Selection: @unchecked Sendable {
    let lock = NSLock()
    var url: URL?
  }

  private nonisolated let selection = Selection()
  private var ready = false
  private var pending: [(window: Bool, start: () -> Void)] = []

  public nonisolated init() {}

  public nonisolated var bundleURL: URL? {
    selection.lock.lock()
    defer { selection.lock.unlock() }
    return selection.url
  }

  public func prepare(window: Bool, start: @escaping () -> Void, select: () -> Void,
                      scheduleTimeout: (@escaping @MainActor () -> Void) -> Void,
                      report: @escaping @MainActor (String) -> Void) {
    if ready { start(); return }
    pending.append((window, start))
    guard pending.count == 1 else { return }
    scheduleTimeout { [weak self] in self?.finish(bundle: nil, path: "timeout (embedded fallback)", report: report) }
    select()
  }

  public func finish(bundle: URL?, path: String, report: (String) -> Void) {
    guard !ready else { return }
    ready = true
    selection.lock.lock()
    selection.url = bundle
    selection.lock.unlock()
    report(path)
    let waiting = pending
    pending.removeAll()
    // If the phone arrives during selection, its launch options belong to the initial host.
    for next in waiting where next.window { next.start() }
    for next in waiting where !next.window { next.start() }
  }
}
