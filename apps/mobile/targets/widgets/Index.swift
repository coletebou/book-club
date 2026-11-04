// The widget extension's widgets (D189).
import SwiftUI
import WidgetKit

@main
struct BookClubWidgets: WidgetBundle {
  var body: some Widget {
    CurrentBookWidget()
    NextStopWidget()
    NowPlayingLiveActivity()
  }
}
