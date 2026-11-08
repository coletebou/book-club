// The images a message's bubble falls back to (D220): drawn on the sender's phone, the same for
// everyone in the thread, so they hold only what the sender chose to say about themselves. Never a
// cover (only club members may see one), a passage, or anyone else's place.
import SwiftUI
import UIKit

enum Card {
  static let size = CGSize(width: 300, height: 200)
  @MainActor static func image<V: View>(_ view: V) -> UIImage? {
    let renderer = ImageRenderer(content: view.frame(width: size.width, height: size.height))
    renderer.scale = 3
    return renderer.uiImage
  }
}

/// The open codex with its ribbon (the app's mark, D137), drawn, not a bitmap.
struct Codex: View {
  var body: some View {
    ZStack {
      Image(systemName: "book.pages").font(.system(size: 34)).foregroundStyle(Color.ink)
      Rectangle().fill(Color.sanguine).frame(width: 4, height: 22).offset(x: 0, y: 12)
    }
  }
}

private struct CardFrame<Content: View>: View {
  let eyebrow: String
  @ViewBuilder let content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack { Text(eyebrow.uppercased()).font(.caption2.weight(.bold)).kerning(1.2).foregroundStyle(Color.sanguine); Spacer(); Codex().scaleEffect(0.6) }
      content
      Spacer(minLength: 0)
    }
    .padding(16)
    .background(Color.parchment)
    .foregroundStyle(Color.ink)
  }
}

struct InviteCard: View {
  let clubName: String
  var body: some View {
    CardFrame(eyebrow: "An invite") {
      Text("Join \(clubName)").font(.system(.title2, design: .serif).weight(.bold)).lineLimit(2)
      Text("Read one book together, with notes that never spoil.").font(.footnote)
    }
  }
}

struct ProgressCard: View {
  let title: String, chapter: Int?, percent: Int
  var body: some View {
    CardFrame(eyebrow: "Reading") {
      Text(title).font(.system(.title2, design: .serif).weight(.bold)).lineLimit(2)
      Text(chapter.map { "Chapter \($0) · \(percent)%" } ?? "\(percent)%").font(.subheadline)
      GeometryReader { g in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.ink.opacity(0.12))
          Capsule().fill(Color.sanguine).frame(width: g.size.width * CGFloat(percent) / 100)
        }
      }
      .frame(height: 6)
      Text("No spoilers: just how far.").font(.caption).foregroundStyle(Color.faint)
    }
  }
}

struct VoteCard: View {
  let clubName: String, count: Int
  var body: some View {
    CardFrame(eyebrow: "\(clubName) · vote") {
      Text("What do we read next?").font(.system(.title2, design: .serif).weight(.bold))
      Text("\(count) books nominated. Tap to vote.").font(.subheadline)
    }
  }
}

struct RsvpCard: View {
  let title: String, when: String
  var body: some View {
    CardFrame(eyebrow: "Meet-up") {
      Text(title).font(.system(.title2, design: .serif).weight(.bold)).lineLimit(2)
      Text(when).font(.subheadline)
      Text("Going · Maybe · Can’t").font(.caption).foregroundStyle(Color.faint)
    }
  }
}
