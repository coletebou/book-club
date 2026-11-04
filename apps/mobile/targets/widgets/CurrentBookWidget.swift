// Your book on the Home Screen and the Lock Screen (D189): its cover, how far you are, the
// chapter; a tap opens it. Drawn from the page's snapshot (D188), refreshed when the app gives a
// new one (it reloads the timelines) and at least every few hours.
import SwiftUI
import WidgetKit

struct BookEntry: TimelineEntry {
  let date: Date
  let book: WidgetBook?
}

struct BookProvider: TimelineProvider {
  func placeholder(in context: Context) -> BookEntry {
    BookEntry(date: .now, book: WidgetBook(bookId: "", clubName: "Your club", title: "Your book", author: "", percent: 42, label: "Chapter 4 · 42%", format: "epub", finished: false, stop: nil))
  }

  func getSnapshot(in context: Context, completion: @escaping (BookEntry) -> Void) {
    completion(BookEntry(date: .now, book: SnapshotStore.load()?.current ?? placeholder(in: context).book))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<BookEntry>) -> Void) {
    let entry = BookEntry(date: .now, book: SnapshotStore.load()?.current)
    completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(4 * 3600))))
  }
}

struct CurrentBookView: View {
  @Environment(\.widgetFamily) private var family
  let entry: BookEntry

  var body: some View {
    Group {
      if let book = entry.book {
        switch family {
        case .accessoryCircular:
          Gauge(value: Double(book.percent), in: 0...100) { Image(systemName: "book.closed") } currentValueLabel: { Text("\(book.percent)") }
            .gaugeStyle(.accessoryCircularCapacity)
        case .accessoryRectangular:
          VStack(alignment: .leading, spacing: 1) {
            Text(book.title).font(.headline).lineLimit(1)
            Text(book.label).font(.caption).lineLimit(1)
            ProgressView(value: Double(book.percent), total: 100)
          }
        case .accessoryInline:
          Text("\(book.title) · \(book.percent)%")
        case .systemMedium:
          HStack(spacing: 12) {
            Cover(bookId: book.bookId).frame(width: 96, height: 96)
            Details(book: book)
          }
        default:
          VStack(alignment: .leading, spacing: 6) {
            Cover(bookId: book.bookId).frame(width: 56, height: 56)
            Text(book.title).font(.headline).foregroundStyle(Color("ink")).lineLimit(2)
            Spacer(minLength: 0)
            Text(book.finished ? "Finished" : "\(book.percent)%").font(.caption.bold()).foregroundStyle(Color("$accent"))
            ProgressView(value: Double(book.percent), total: 100).tint(Color("$accent"))
          }
        }
      } else {
        VStack(alignment: .leading, spacing: 4) {
          Image(systemName: "book.closed")
          Text("Open Book Club to see your book here.").font(.caption).foregroundStyle(Color("faint"))
        }
      }
    }
    .widgetURL(SnapshotStore.link(entry.book?.bookId))
    .containerBackground(Color("$widgetBackground"), for: .widget)
  }
}

struct Cover: View {
  let bookId: String
  var body: some View {
    if let image = SnapshotStore.cover(bookId) {
      Image(uiImage: image).resizable().scaledToFill().clipShape(RoundedRectangle(cornerRadius: 4))
    } else {
      RoundedRectangle(cornerRadius: 4).fill(Color("$accent").opacity(0.25)).overlay(Image(systemName: "book.closed").foregroundStyle(Color("$accent")))
    }
  }
}

struct Details: View {
  let book: WidgetBook
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(book.title).font(.headline).foregroundStyle(Color("ink")).lineLimit(2)
      Text(book.label).font(.caption).foregroundStyle(Color("faint")).lineLimit(1)
      ProgressView(value: Double(book.percent), total: 100).tint(Color("$accent"))
      if let stop = book.stop {
        Text(stop.reached ? "At the club’s stop: \(stop.label)" : "Next stop: \(stop.label)\(stop.on.map { " · \($0)" } ?? "")")
          .font(.caption2).foregroundStyle(Color("faint")).lineLimit(2)
      } else {
        Text(book.clubName).font(.caption2).foregroundStyle(Color("faint")).lineLimit(1)
      }
    }
  }
}

struct CurrentBookWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "CurrentBook", provider: BookProvider()) { entry in CurrentBookView(entry: entry) }
      .configurationDisplayName("Your book")
      .description("The book you are reading or hearing, and how far you are.")
      .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}
