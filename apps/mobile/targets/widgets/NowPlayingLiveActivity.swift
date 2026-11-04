// The audiobook as a Live Activity (D189), when turned on (Settings, D188): on the Lock Screen and
// in the Dynamic Island, the book, the chapter, how far through and Play/Pause. Elapsed time is
// drawn by the system from the chapter's start and end (`timerInterval`), so the app updates the
// activity only when something changes (play, pause, a seek, a new chapter).
import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct NowPlayingLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: NowPlayingAttributes.self) { context in
      HStack(spacing: 12) {
        CoverTile(bookId: context.attributes.bookId).frame(width: 52, height: 52)
        VStack(alignment: .leading, spacing: 3) {
          Text(context.attributes.title).font(.headline).lineLimit(1)
          Text(context.state.chapter).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
          ChapterProgress(state: context.state)
        }
        PlayPause(playing: context.state.playing)
      }
      .padding()
      .activityBackgroundTint(Color("$widgetBackground"))
      .widgetURL(SnapshotStore.link(context.attributes.bookId))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { CoverTile(bookId: context.attributes.bookId).frame(width: 44, height: 44) }
        DynamicIslandExpandedRegion(.center) {
          VStack(alignment: .leading, spacing: 2) {
            Text(context.attributes.title).font(.headline).lineLimit(1)
            Text(context.state.chapter).font(.caption).lineLimit(1)
          }
        }
        DynamicIslandExpandedRegion(.trailing) { PlayPause(playing: context.state.playing) }
        DynamicIslandExpandedRegion(.bottom) { ChapterProgress(state: context.state) }
      } compactLeading: {
        Image(systemName: context.state.playing ? "headphones" : "pause.fill")
      } compactTrailing: {
        Text("\(context.state.bookPercent)%").monospacedDigit()
      } minimal: {
        Image(systemName: "headphones")
      }
      .widgetURL(SnapshotStore.link(context.attributes.bookId))
    }
  }
}

private struct ChapterProgress: View {
  let state: NowPlayingAttributes.ContentState
  var body: some View {
    if state.playing && state.endsAt > state.startedAt {
      ProgressView(timerInterval: state.startedAt...state.endsAt, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
        .tint(Color("$accent"))
    } else {
      ProgressView(value: state.fraction).tint(Color("$accent"))
    }
  }
}

private struct PlayPause: View {
  let playing: Bool
  var body: some View {
    Button(intent: TogglePlaybackIntent()) {
      Image(systemName: playing ? "pause.fill" : "play.fill").font(.title2)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(playing ? "Pause the audiobook" : "Play the audiobook")
  }
}

private struct CoverTile: View {
  let bookId: String
  var body: some View {
    if let image = SnapshotStore.cover(bookId) {
      Image(uiImage: image).resizable().scaledToFill().clipShape(RoundedRectangle(cornerRadius: 6))
    } else {
      RoundedRectangle(cornerRadius: 6).fill(Color("$accent").opacity(0.25)).overlay(Image(systemName: "headphones"))
    }
  }
}
