// The extension's way to the server (D220): the app's own session (SharedSession), the same routes
// and the same gate as the app. Nothing here is cached beyond the moment it is shown.
import Foundation

struct ClubSummary: Decodable, Identifiable, Hashable { let id: String; let name: String }
struct ClubInvite: Decodable, Hashable { let code: String; let url: String }
struct ClubDetail: Decodable { let id: String; let name: String; let invite: ClubInvite? }

struct RoundPerson: Decodable, Hashable { let userId: String; let displayName: String }
struct Nomination: Decodable, Identifiable, Hashable {
  let id: String; let title: String; let author: String?; let votes: Int; let voters: [RoundPerson]; let votedByMe: Bool
}
struct Round: Decodable, Hashable { let id: String; let status: String; let nominations: [Nomination] }
struct NextBookState: Decodable { let round: Round? }

struct MeetupRsvp: Decodable, Hashable { let userId: String; let displayName: String; let answer: String }
struct Meeting: Decodable, Hashable { let label: String; let on: String?; let at: String?; let rsvps: [MeetupRsvp] }
struct BookSummary: Decodable, Identifiable, Hashable { let id: String; let title: String; let meeting: Meeting? }
struct Me: Decodable { let user: MeUser? }
struct MeUser: Decodable { let id: String; let displayName: String }

enum APIError: Error { case signedOut, notAvailable, status(Int) }

struct BookClubAPI {
  let session: SharedSession
  var origin: String { session.origin }

  private func request(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
    guard let url = URL(string: session.origin + path) else { throw APIError.status(0) }
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.httpShouldHandleCookies = false
    req.setValue(session.cookieHeader, forHTTPHeaderField: "Cookie")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body { req.httpBody = body; req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    let (data, response) = try await URLSession.shared.data(for: req)
    let code = (response as? HTTPURLResponse)?.statusCode ?? 0
    if code == 401 { throw APIError.signedOut }
    // A route this server does not have yet (the next-book picker, meet-ups): that feature is off.
    if code == 404 || code == 405 { throw APIError.notAvailable }
    guard (200..<300).contains(code) else { throw APIError.status(code) }
    return data
  }

  private func get<T: Decodable>(_ path: String) async throws -> T { try JSONDecoder().decode(T.self, from: try await request(path)) }

  func me() async throws -> MeUser { guard let user = (try await get("/api/session") as Me).user else { throw APIError.signedOut }; return user }
  func clubs() async throws -> [ClubSummary] { try await get("/api/clubs") }
  func club(_ id: String) async throws -> ClubDetail { try await get("/api/clubs/\(id)") }
  func books(club: String) async throws -> [BookSummary] { try await get("/api/clubs/\(club)/books") }
  func nextBook(club: String) async throws -> NextBookState { try await get("/api/clubs/\(club)/next-book") }
  func vote(_ nomination: String, on: Bool) async throws {
    _ = try await request("/api/nominations/\(nomination)/vote", method: on ? "PUT" : "DELETE", body: on ? Data("{}".utf8) : nil)
  }
  func rsvp(book: String, answer: String?) async throws {
    let body = try JSONSerialization.data(withJSONObject: ["answer": answer as Any? ?? NSNull()])
    _ = try await request("/api/books/\(book)/meeting/rsvp", method: "PUT", body: body)
  }
}

/// The widgets' snapshot (D188) the app keeps in the App Group: your current book, and the others.
struct SnapshotBook: Decodable, Hashable { let bookId: String; let clubId: String; let clubName: String; let title: String; let percent: Int; let label: String }
struct Snapshot: Decodable { let current: SnapshotBook?; let others: [SnapshotBook] }
enum SnapshotStore {
  static func load() -> Snapshot? {
    guard let text = UserDefaults(suiteName: SharedSession.accessGroup)?.string(forKey: "snapshot"), let data = text.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(Snapshot.self, from: data)
  }
}
