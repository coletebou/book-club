// The watch app (D222): one screen, what plays on the iPhone. v1 is a remote and a progress view;
// the audio stays on the phone.
import SwiftUI

@main
struct BookClubWatchApp: App {
  @StateObject private var session = WatchSession()

  var body: some Scene {
    WindowGroup {
      NowPlayingView(session: session)
        .onAppear { session.start() }
    }
  }
}

struct NowPlayingView: View {
  @ObservedObject var session: WatchSession

  var body: some View {
    if let np = session.nowPlaying {
      Playing(np: np, reachable: session.reachable, send: session.send)
    } else {
      VStack(spacing: 8) {
        Image(systemName: "book.closed").font(.title2).foregroundStyle(Color("$accent"))
        Text(session.heard ? "Nothing playing" : "Book Club").font(.headline)
        Text("Play an audiobook in Book Club on your iPhone.").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
      }
      .padding()
    }
  }
}

private struct Playing: View {
  let np: NowPlaying, reachable: Bool, send: (String) -> Void

  var body: some View {
    VStack(spacing: 6) {
      Text(np.title).font(.headline).lineLimit(2).multilineTextAlignment(.center)
      Text(np.chapter).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
      TimelineView(.periodic(from: .now, by: 15)) { context in
        VStack(spacing: 2) {
          if np.playing, let span = np.span {
            ProgressView(timerInterval: span, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }.tint(Color("$accent"))
          } else {
            ProgressView(value: np.progress(at: context.date)).tint(Color("$accent"))
          }
          HStack {
            Text("\(np.bookPercent)% of the book")
            Spacer()
            if let left = np.leftLabel(at: context.date) { Text(left) }
          }
          .font(.caption2).foregroundStyle(.secondary)
        }
      }
      HStack(spacing: 4) {
        Button { send("back") } label: { Image(systemName: "gobackward.15") }.accessibilityLabel("Back 15 seconds")
        Button { send("toggle") } label: { Image(systemName: np.playing ? "pause.fill" : "play.fill").font(.title3) }
          .accessibilityLabel(np.playing ? "Pause" : "Play")
        Button { send("forward") } label: { Image(systemName: "goforward.30") }.accessibilityLabel("Forward 30 seconds")
      }
      .disabled(!reachable)
      if !reachable { Text("iPhone not reachable").font(.caption2).foregroundStyle(.secondary) }
    }
    .padding(.horizontal, 4)
  }
}
