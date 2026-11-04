// Your club's next stop (D53, D189): where the club will talk the book over next, by when, and how
// much of the book is left to it for you.
import SwiftUI
import WidgetKit

struct NextStopView: View {
  @Environment(\.widgetFamily) private var family
  let entry: BookEntry

  var body: some View {
    Group {
      if let book = entry.book, let stop = book.stop {
        let toGo = Int((stop.toGo * 100).rounded(.up))
        if family == .accessoryRectangular {
          VStack(alignment: .leading, spacing: 1) {
            Text(stop.reached ? "You are at the stop" : "Next stop: \(toGo)% to go").font(.headline).lineLimit(1)
            Text(stop.label).font(.caption).lineLimit(1)
            if let on = stop.on { Text(on).font(.caption2).lineLimit(1) }
          }
        } else {
          VStack(alignment: .leading, spacing: 4) {
            Text(book.clubName).font(.caption.bold()).foregroundStyle(Color("$accent")).lineLimit(1)
            Text(stop.reached ? "You are there" : "\(toGo)% to go").font(.title3.bold()).foregroundStyle(Color("ink"))
            Text(stop.label).font(.caption).foregroundStyle(Color("faint")).lineLimit(2)
            Spacer(minLength: 0)
            if let on = stop.on { Text("by \(on)").font(.caption2).foregroundStyle(Color("faint")) }
          }
        }
      } else {
        VStack(alignment: .leading, spacing: 4) {
          Image(systemName: "flag")
          Text("No next stop set for your book.").font(.caption).foregroundStyle(Color("faint"))
        }
      }
    }
    .widgetURL(SnapshotStore.link(entry.book?.bookId))
    .containerBackground(Color("$widgetBackground"), for: .widget)
  }
}

struct NextStopWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "NextStop", provider: BookProvider()) { entry in NextStopView(entry: entry) }
      .configurationDisplayName("Next club stop")
      .description("Where your club talks about the book next, and how far you have to go.")
      .supportedFamilies([.systemSmall, .accessoryRectangular])
  }
}
