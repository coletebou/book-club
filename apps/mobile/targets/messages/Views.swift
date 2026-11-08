// The extension's screens (D220), in the manuscript look (D117). Compact: the four actions.
// Expanded: picking a club, voting, answering a meet-up. Transcript: a live vote or meet-up
// bubble, drawn on each reader's phone from what the server tells that reader.
import Messages
import SwiftUI

extension Color {
  static let ink = Color("ink")
  static let parchment = Color("parchment")
  static let faint = Color("faint")
  static let sanguine = Color("AccentColor")
}

struct MessagesRoot: View {
  @ObservedObject var model: MessagesModel

  var body: some View {
    ZStack {
      Color.parchment.ignoresSafeArea()
      switch model.phase {
      case .loading: ProgressView().tint(.sanguine)
      case .signedOut: SignedOut(open: { model.openApp("/") })
      case .failed: Notice(text: "Book Club could not be reached. Try again in a moment.", action: ("Try again", { Task { await model.load() } }))
      case .ready:
        if model.style == .transcript, let selected = model.selected { LiveBubble(model: model, message: selected) }
        else { Screens(model: model) }
      }
    }
    .foregroundStyle(Color.ink)
  }
}

private struct Screens: View {
  @ObservedObject var model: MessagesModel
  var body: some View {
    switch model.screen {
    case .home: Home(model: model)
    case .invite: ClubPicker(clubs: model.clubs, pick: model.sendInvite, back: { model.screen = .home })
    case let .vote(club): VoteScreen(model: model, club: club)
    case let .rsvp(book, club): RsvpScreen(model: model, book: book, club: club)
    }
  }
}

private struct Home: View {
  @ObservedObject var model: MessagesModel
  var body: some View {
    ScrollView {
      VStack(spacing: 10) {
        Action(icon: "person.badge.plus", title: "Invite to a club", enabled: !model.clubs.isEmpty) {
          if model.clubs.count == 1 { model.sendInvite(model.clubs[0]) } else { model.screen = .invite; model.expand() }
        }
        Action(icon: "bookmark", title: model.snapshot?.current.map { "Share my place in \($0.title)" } ?? "Share my place", enabled: model.snapshot?.current != nil) {
          if let book = model.snapshot?.current { model.sendProgress(book) }
        }
        ForEach(model.openRounds, id: \.round.id) { item in
          Action(icon: "checklist", title: "Vote on \(item.club.name)’s next book", enabled: true) { model.sendVote(item.club, item.round) }
        }
        ForEach(model.meetups, id: \.book.id) { item in
          Action(icon: "calendar", title: "Meet-up: \(item.book.title)", enabled: true) { model.sendRsvp(item.book, item.club) }
        }
      }
      .padding(14)
    }
  }
}

private struct Action: View {
  let icon: String, title: String, enabled: Bool, run: () -> Void
  var body: some View {
    Button(action: run) {
      HStack(spacing: 12) {
        Image(systemName: icon).font(.title3).foregroundStyle(Color.sanguine).frame(width: 28)
        Text(title).font(.system(.body, design: .serif).weight(.semibold)).lineLimit(2).multilineTextAlignment(.leading)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 14).padding(.vertical, 12)
      .background(RoundedRectangle(cornerRadius: 12).fill(Color.ink.opacity(0.06)))
    }
    .buttonStyle(.plain).disabled(!enabled).opacity(enabled ? 1 : 0.45)
  }
}

private struct ClubPicker: View {
  let clubs: [ClubSummary], pick: (ClubSummary) -> Void, back: () -> Void
  var body: some View {
    List {
      Section("Invite to which club?") {
        ForEach(clubs) { club in Button(club.name) { pick(club) }.font(.system(.body, design: .serif)) }
      }
      Button("Back", action: back)
    }
    .scrollContentBackground(.hidden)
  }
}

private struct VoteScreen: View {
  @ObservedObject var model: MessagesModel
  let club: ClubSummary
  var body: some View {
    List {
      Section("What do we read next? · \(club.name)") {
        ForEach(model.round?.nominations ?? []) { n in
          Button { model.toggleVote(n, club: club) } label: {
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(n.title).font(.system(.body, design: .serif).weight(.semibold))
                if let author = n.author { Text(author).font(.footnote).foregroundStyle(Color.faint) }
              }
              Spacer()
              Text("\(n.votes)").font(.system(.title3, design: .serif).weight(.bold))
              Image(systemName: n.votedByMe ? "checkmark.circle.fill" : "circle").foregroundStyle(Color.sanguine)
            }
          }
          .buttonStyle(.plain)
        }
      }
      if model.round == nil { Text("This vote has closed.").foregroundStyle(Color.faint) }
    }
    .scrollContentBackground(.hidden)
  }
}

private struct RsvpScreen: View {
  @ObservedObject var model: MessagesModel
  let book: BookSummary, club: ClubSummary
  var body: some View {
    VStack(spacing: 16) {
      Text(book.title).font(.system(.title2, design: .serif).weight(.bold))
      if let m = model.meeting ?? book.meeting {
        Text(MeetingText.when(m)).foregroundStyle(Color.faint)
        let c = MeetingText.counts(m)
        HStack(spacing: 10) {
          Answer(label: "Going", count: c.yes) { model.answer("yes", book: book, club: club) }
          Answer(label: "Maybe", count: c.maybe) { model.answer("maybe", book: book, club: club) }
          Answer(label: "Can’t", count: c.no) { model.answer("no", book: book, club: club) }
        }
      } else {
        Text("There is no day to answer for yet.").foregroundStyle(Color.faint)
      }
    }
    .padding()
  }
}

private struct Answer: View {
  let label: String, count: Int, run: () -> Void
  var body: some View {
    Button(action: run) {
      VStack { Text(label).font(.headline); Text("\(count)").font(.footnote) }
        .frame(maxWidth: .infinity).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 10).stroke(Color.sanguine, lineWidth: 1.5))
    }
    .buttonStyle(.plain)
  }
}

/// A vote or meet-up bubble as this reader sees it now; any other kind has its template image.
private struct LiveBubble: View {
  @ObservedObject var model: MessagesModel
  let message: BookClubMessage
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      switch message {
      case .vote:
        Text("WHAT DO WE READ NEXT?").font(.caption2.weight(.bold)).foregroundStyle(Color.sanguine)
        if let round = model.round {
          ForEach(round.nominations.sorted { $0.votes > $1.votes }.prefix(3)) { n in
            HStack { Text(n.title).font(.system(.subheadline, design: .serif).weight(.semibold)).lineLimit(1); Spacer(); Text("\(n.votes)").bold() }
          }
          Text("Tap to vote").font(.caption).foregroundStyle(Color.faint)
        } else { Text("This vote has closed.").foregroundStyle(Color.faint) }
      case let .rsvp(_, _, title):
        Text("MEET-UP").font(.caption2.weight(.bold)).foregroundStyle(Color.sanguine)
        Text(title).font(.system(.headline, design: .serif))
        if let m = model.meeting {
          let c = MeetingText.counts(m)
          Text(MeetingText.when(m)).font(.subheadline)
          Text("\(c.yes) going · \(c.maybe) maybe · \(c.no) can’t").font(.caption).foregroundStyle(Color.faint)
        }
      default:
        EmptyView()
      }
    }
    .padding(12).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

private struct SignedOut: View {
  let open: () -> Void
  var body: some View { Notice(text: "Open Book Club and sign in to send invites, your place, votes and meet-ups from here.", action: ("Open Book Club", open)) }
}

private struct Notice: View {
  let text: String, action: (String, () -> Void)
  var body: some View {
    VStack(spacing: 12) {
      Text(text).multilineTextAlignment(.center).font(.system(.body, design: .serif))
      Button(action.0, action: action.1).buttonStyle(.borderedProminent).tint(.sanguine)
    }
    .padding()
  }
}
