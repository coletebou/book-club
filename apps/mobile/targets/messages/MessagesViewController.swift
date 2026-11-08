// Book Club in iMessage (D220): the extension's one view controller and its model. Compose a
// message (invite, your place, a vote, a meet-up), or, for a vote or meet-up in the thread, answer
// it, which updates that same bubble (its MSSession) for everyone.
import Messages
import SwiftUI
import UIKit

final class MessagesViewController: MSMessagesAppViewController {
  private let model = MessagesModel()

  override func viewDidLoad() {
    super.viewDidLoad()
    let host = UIHostingController(rootView: MessagesRoot(model: model))
    host.view.backgroundColor = .clear
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
    model.insert = { [weak self] message in
      guard let conversation = self?.activeConversation else { return }
      conversation.insert(message) { _ in }
      self?.dismiss()
    }
    model.expand = { [weak self] in self?.requestPresentationStyle(.expanded) }
    model.openApp = { [weak self] path in
      guard let url = URL(string: "bookclub://\(path)") else { return }
      self?.extensionContext?.open(url, completionHandler: nil)
    }
  }

  override func willBecomeActive(with conversation: MSConversation) {
    model.activate(conversation: conversation, style: presentationStyle)
  }

  override func didSelect(_ message: MSMessage, conversation: MSConversation) {
    model.activate(conversation: conversation, style: presentationStyle)
  }

  override func didTransition(to presentationStyle: MSMessagesAppPresentationStyle) {
    model.style = presentationStyle
  }

  /** A live bubble's height in the transcript: the card, at the width Messages gives it. */
  override func contentSizeThatFits(_ size: CGSize) -> CGSize {
    CGSize(width: size.width, height: min(size.width * 0.75, 260))
  }
}

@MainActor
final class MessagesModel: ObservableObject {
  enum Screen: Equatable { case home, invite, vote(ClubSummary), rsvp(BookSummary, ClubSummary), open(BookClubMessage) }
  enum Phase: Equatable { case loading, signedOut, ready, failed, notice(String) }

  @Published var style: MSMessagesAppPresentationStyle = .compact
  @Published var phase: Phase = .loading
  @Published var screen: Screen = .home
  @Published var me: MeUser?
  @Published var clubs: [ClubSummary] = []
  @Published var snapshot: Snapshot?
  /** The tapped vote is not this reader's to see (not in that club), rather than closed. */
  @Published var selectedHidden = false
  /** Clubs with a vote open (the next-book picker, D214; none on a server without it). */
  @Published var openRounds: [(club: ClubSummary, round: Round)] = []
  /** Books with a meet-up day to answer for (D206; none on a server without it). */
  @Published var meetups: [(book: BookSummary, club: ClubSummary)] = []
  /** The message the person tapped in the thread, if it is ours. */
  @Published var selected: BookClubMessage?
  @Published var round: Round?
  @Published var meeting: Meeting?

  var insert: (MSMessage) -> Void = { _ in }
  var expand: () -> Void = {}
  var openApp: (String) -> Void = { _ in }
  private(set) var conversation: MSConversation?
  private var api: BookClubAPI?

  func activate(conversation: MSConversation, style: MSMessagesAppPresentationStyle) {
    self.conversation = conversation
    self.style = style
    selected = conversation.selectedMessage?.url.flatMap(BookClubMessage.init(url:))
    guard let session = SharedSession.load() else { phase = .signedOut; return }
    api = BookClubAPI(session: session)
    Task { await load() }
  }

  func load() async {
    guard let api else { return }
    phase = .loading
    do {
      me = try await api.me()
      clubs = try await api.clubs()
      snapshot = SnapshotStore.load()
      await loadSelected()
      if style != .transcript { await loadOptional() }
      phase = .ready
    } catch APIError.signedOut {
      phase = .signedOut
    } catch {
      phase = .failed
    }
  }

  /** What the tapped vote or meet-up says now, fetched as this reader (the server's own gate). */
  func loadSelected() async {
    guard let api, let selected else { return }
    switch selected {
    case let .vote(club, roundId):
      do {
        let state = try await api.nextBook(club: club)
        round = state.round?.id == roundId ? state.round : nil
        selectedHidden = false
      } catch {
        // Not this reader's club (the server answers as for nothing there), or no answer: not "closed".
        round = nil
        selectedHidden = true
      }
      if let summary = clubs.first(where: { $0.id == club }), style == .expanded { screen = .vote(summary) }
    case let .rsvp(club, book, _):
      let books = (try? await api.books(club: club)) ?? []
      meeting = books.first(where: { $0.id == book })?.meeting
      if let b = books.first(where: { $0.id == book }), let c = clubs.first(where: { $0.id == club }), style == .expanded { screen = .rsvp(b, c) }
    case .invite, .progress, .quote:
      // Nothing live to answer: the way into the app at what it is about (its own gates apply there).
      if style == .expanded { screen = .open(selected) }
    }
  }

  /** The vote and meet-up actions, offered only where the server has them (PRs for D214 and D206). */
  private func loadOptional() async {
    guard let api else { return }
    var rounds: [(ClubSummary, Round)] = []
    var meets: [(BookSummary, ClubSummary)] = []
    for club in clubs {
      if let round = try? await api.nextBook(club: club.id).round, round.status == "open" { rounds.append((club, round)) }
      for book in (try? await api.books(club: club.id)) ?? [] where book.meeting?.on != nil || book.meeting?.at != nil { meets.append((book, club)) }
    }
    openRounds = rounds.map { (club: $0.0, round: $0.1) }
    meetups = meets.map { (book: $0.0, club: $0.1) }
  }

  // MARK: Composing

  private var origin: String { api?.origin ?? "" }
  func sendInvite(_ club: ClubSummary) {
    Task {
      guard let api, let detail = try? await api.club(club.id) else { phase = .failed; return }
      guard let invite = detail.invite,
            let url = BookClubMessage.invite(club: club.id, code: invite.code, clubName: club.name).url(origin: origin) else {
        phase = .notice("\(club.name) has no invite link right now. An owner can make one in the club’s settings.")
        return
      }
      let layout = MSMessageTemplateLayout()
      layout.image = Card.image(InviteCard(clubName: club.name))
      layout.caption = "Join \(club.name) on Book Club"
      layout.subcaption = "Read together, no spoilers"
      send(url: url, layout: layout, summary: "An invite to \(club.name)")
    }
  }

  func sendProgress(_ book: SnapshotBook) {
    let chapter = chapterOfLabel(book.label)
    guard let url = BookClubMessage.progress(club: book.clubId, book: book.bookId, title: book.title, percent: book.percent, chapter: chapter).url(origin: origin) else { return }
    let layout = MSMessageTemplateLayout()
    layout.image = Card.image(ProgressCard(title: book.title, chapter: chapter, percent: book.percent))
    layout.caption = progressCaption(name: me?.displayName, title: book.title, percent: book.percent, chapter: chapter)
    layout.subcaption = "Book Club · \(book.clubName)"
    send(url: url, layout: layout, summary: "Reading \(book.title)")
  }

  func sendVote(_ club: ClubSummary, _ round: Round) {
    let vote = BookClubMessage.vote(club: club.id, round: round.id)
    guard let url = vote.url(origin: origin) else { return }
    let layout = MSMessageTemplateLayout()
    layout.image = Card.image(VoteCard(clubName: club.name, count: round.nominations.count))
    layout.caption = "What do we read next?"
    layout.subcaption = "\(club.name) · tap to vote"
    send(url: url, layout: MSMessageLiveLayout(alternateLayout: layout), summary: "A vote on the next book", live: vote)
  }

  func sendRsvp(_ book: BookSummary, _ club: ClubSummary) {
    let rsvp = BookClubMessage.rsvp(club: club.id, book: book.id, title: book.title)
    guard let url = rsvp.url(origin: origin) else { return }
    let layout = MSMessageTemplateLayout()
    layout.image = Card.image(RsvpCard(title: book.title, when: book.meeting.map(MeetingText.when) ?? ""))
    layout.caption = "Meet-up: \(book.title)"
    layout.subcaption = "\(club.name) · are you coming?"
    send(url: url, layout: MSMessageLiveLayout(alternateLayout: layout), summary: "A meet-up for \(book.title)", live: rsvp)
  }

  /** A vote, or a meet-up answer, then the same bubble again (its session) so the thread sees it moved. */
  func toggleVote(_ nomination: Nomination, club: ClubSummary) {
    Task {
      guard let api else { return }
      try? await api.vote(nomination.id, on: !nomination.votedByMe)
      round = try? await api.nextBook(club: club.id).round
      if let round { sendVote(club, round) }
    }
  }

  func answer(_ answer: String?, book: BookSummary, club: ClubSummary) {
    Task {
      guard let api else { return }
      try? await api.rsvp(book: book.id, answer: answer)
      let books = (try? await api.books(club: club.id)) ?? []
      meeting = books.first(where: { $0.id == book.id })?.meeting
      sendRsvp(books.first(where: { $0.id == book.id }) ?? book, club)
    }
  }

  /**
   * `live`: a vote or a meet-up, whose bubble answers update. It reuses the tapped bubble's session
   * only when that bubble is this same vote or meet-up; anything else starts its own.
   */
  private func send(url: URL, layout: MSMessageLayout, summary: String, live: BookClubMessage? = nil) {
    let message: MSMessage
    if let live {
      let same = live == selected ? conversation?.selectedMessage?.session : nil
      message = MSMessage(session: same ?? MSSession())
    } else {
      message = MSMessage()
    }
    message.url = url
    message.layout = layout
    message.summaryText = summary
    insert(message)
  }
}

enum MeetingText {
  static func when(_ m: Meeting) -> String {
    if let at = m.at, let date = ISO8601DateFormatter().date(from: at) { return date.formatted(date: .abbreviated, time: .shortened) }
    if let on = m.on { return on }
    // Not the stop's label: its chapter's name would reach everyone in the thread, members or not.
    return "Date to be set"
  }
  static func counts(_ m: Meeting) -> (yes: Int, maybe: Int, no: Int) {
    (m.rsvps.filter { $0.answer == "yes" }.count, m.rsvps.filter { $0.answer == "maybe" }.count, m.rsvps.filter { $0.answer == "no" }.count)
  }
}
