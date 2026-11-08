// The signed-in session, shared from the app to its Messages extension (D220). One file, kept
// byte-identical in modules/book-club-native/ios/ (which writes it) and targets/messages/_shared/
// (which reads it); test/shared-session.test.ts holds them to that.
//
// The app's WebView already mirrors its session cookie into the system cookie store
// (`sharedCookiesEnabled`, D133). The app copies that one cookie into a keychain item in the App
// Group's access group (`group.ai.badland.books`, which the widgets already need, so no new
// entitlement), readable only by this app and its extensions, only after the phone's first unlock,
// and never synced off the device. The extension sends it as the request's Cookie, exactly as the
// app's own native requests do. Signing out deletes it.
import Foundation
import Security

struct SharedSession: Codable, Equatable {
  /** The server, e.g. `https://books.badland.ai`. */
  let origin: String
  /** The cookie's name (`__Host-bc_session` over HTTPS, `bc_session` on a plain-HTTP dev server). */
  let name: String
  let value: String
  /** When it expires (seconds since 1970), or nil for a session cookie. */
  let expires: Double?

  static let accessGroup = "group.ai.badland.books"
  static let service = "ai.badland.books.session"
  static let account = "session"
  static let cookieNames = ["__Host-bc_session", "bc_session"]

  /** The value for a request's Cookie header. */
  var cookieHeader: String { "\(name)=\(value)" }

  func isExpired(now: Date = Date()) -> Bool { expires.map { $0 <= now.timeIntervalSince1970 } ?? false }

  /** The session cookie the system holds for `origin`, if signed in there. */
  static func fromCookies(_ cookies: [HTTPCookie], origin: String) -> SharedSession? {
    for name in cookieNames {
      if let c = cookies.first(where: { $0.name == name && !$0.value.isEmpty }) {
        return SharedSession(origin: origin, name: c.name, value: c.value, expires: c.expiresDate?.timeIntervalSince1970)
      }
    }
    return nil
  }

  private static var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
     kSecAttrAccessGroup as String: accessGroup]
  }

  /** Keep it for the extensions (replacing any other), or delete it when `session` is nil. */
  @discardableResult
  static func store(_ session: SharedSession?) -> Bool {
    SecItemDelete(query as CFDictionary)
    guard let session, let data = try? JSONEncoder().encode(session) else { return true }
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
  }

  /** What the app last shared, if it is still good. */
  static func load(now: Date = Date()) -> SharedSession? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
          let session = try? JSONDecoder().decode(SharedSession.self, from: data), !session.isExpired(now: now) else { return nil }
    return session
  }
}
