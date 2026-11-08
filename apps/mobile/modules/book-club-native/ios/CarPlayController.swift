// CarPlay (D221): an audio app's templates, drawn from the model JavaScript gives
// (src/carplay/model.ts, CarPlayModel.swift), with every tap sent back to it as the row's id. The
// player is the app's one AVPlayer (expo-audio, driven by NativeAudioEngine.ts), so the Now Playing
// screen is CarPlay's own, fed by the same Now Playing info and remote commands as the lock screen.
// The scene delegate that connects this is in the app target, and only in a build made with
// BOOKCLUB_CARPLAY=1 (plugins/with-carplay.ts): in any other build none of this ever runs.
import CarPlay
import Foundation
import UIKit

public final class BookClubCarPlay: NSObject {
  public static let shared = BookClubCarPlay()

  private var interface: CPInterfaceController?
  /** The car's templates: made when a car connects, never in a build or a run without one. */
  private var screens: Screens?
  private var model = CarModel.empty
  private var navSeq = 0
  private var covers: [String: UIImage] = [:]

  private struct Screens {
    let tabs: CPTabBarTemplate
    let continueList: CPListTemplate
    let booksList: CPListTemplate
    let chaptersList: CPListTemplate
  }

  /** Taps, to JavaScript (BookClubNativeModule's `onCarPlayCommand`); the last one waits until it listens. */
  var onCommand: ((String) -> Void)? {
    didSet {
      if let id = pending, let onCommand {
        pending = nil
        onCommand(id)
      }
    }
  }
  private var pending: String?

  private override init() {
    super.init()
  }

  /** The car connected (BookClubCarPlaySceneDelegate): the tabs, drawn from the model as it is now. */
  public func connect(_ interface: CPInterfaceController) {
    let continueList = CPListTemplate(title: "Continue", sections: [])
    continueList.tabImage = UIImage(systemName: "play.circle")
    continueList.emptyViewTitleVariants = ["Nothing to continue"]
    continueList.emptyViewSubtitleVariants = ["Open an audiobook on your iPhone"]
    let booksList = CPListTemplate(title: "Club Books", sections: [])
    booksList.tabImage = UIImage(systemName: "books.vertical")
    booksList.emptyViewTitleVariants = ["No club books"]
    booksList.emptyViewSubtitleVariants = ["Sign in to Book Club on your iPhone"]
    let chaptersList = CPListTemplate(title: "Chapters", sections: [])
    chaptersList.tabImage = UIImage(systemName: "list.bullet")
    chaptersList.emptyViewTitleVariants = ["No audiobook yet"]
    let tabs = CPTabBarTemplate(templates: [continueList, booksList, chaptersList])
    let nowPlaying = CPNowPlayingTemplate.shared
    nowPlaying.isUpNextButtonEnabled = false
    nowPlaying.isAlbumArtistButtonEnabled = false
    self.interface = interface
    screens = Screens(tabs: tabs, continueList: continueList, booksList: booksList, chaptersList: chaptersList)
    draw()
    interface.setRootTemplate(tabs, animated: false, completion: nil)
  }

  public func disconnect() {
    interface = nil
    screens = nil
    // The page may have the player back now (NativeAudioEngine's `carDisconnected`).
    send("disconnected")
  }

  /** A new model from JavaScript (its JSON): kept, drawn while a car is connected, and its navigation followed once. */
  func setModel(_ json: String) {
    guard let next = CarModel.decode(json) else { return }
    DispatchQueue.main.async {
      // The App Group's covers may have changed with the books.
      if next.books != self.model.books { self.covers = [:] }
      self.model = next
      self.draw()
      if let nav = next.nav, nav.seq != self.navSeq {
        self.navSeq = nav.seq
        self.follow(nav)
      }
    }
  }

  private func send(_ id: String) {
    if let onCommand { onCommand(id) } else { pending = id }
  }

  private func draw() {
    guard let screens else { return }
    screens.continueList.updateSections(model.continueRow.map { [CPListSection(items: [item($0)])] } ?? [])
    screens.booksList.updateSections(model.books.isEmpty ? [] : [CPListSection(items: model.books.map(item))])
    screens.chaptersList.updateSections(chapterSections())
  }

  private func chapterSections() -> [CPListSection] {
    guard let chapters = model.chapters else { return [] }
    // The car shows at most this many items in a list; a longer book shows its first ones.
    let rows = chapters.rows.prefix(max(1, Int(CPListTemplate.maximumItemCount)))
    return [CPListSection(items: rows.map(item), header: chapters.title, sectionIndexTitle: nil)]
  }

  private func item(_ row: CarRow) -> CPListItem {
    let item = CPListItem(text: row.title, detailText: row.detail, image: row.coverBookId.flatMap(cover))
    item.isPlaying = row.playing
    item.handler = { [weak self] _, completion in
      self?.send(row.id)
      completion()
    }
    return item
  }

  private func follow(_ nav: CarNav) {
    guard let interface, let screens else { return }
    switch nav.to {
    case "nowPlaying":
      if interface.topTemplate !== CPNowPlayingTemplate.shared {
        interface.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
      }
    case "chapters":
      if #available(iOS 17.0, *) {
        screens.tabs.select(screens.chaptersList)
      } else {
        interface.pushTemplate(CPListTemplate(title: "Chapters", sections: chapterSections()), animated: true, completion: nil)
      }
    case "message":
      let alert = CPAlertTemplate(titleVariants: [nav.message ?? ""], actions: [
        CPAlertAction(title: "OK", style: .cancel) { [weak interface] _ in interface?.dismissTemplate(animated: true, completion: nil) },
      ])
      interface.presentTemplate(alert, animated: true, completion: nil)
    default:
      break
    }
  }

  /** A book's cover, as the widgets keep it in the App Group (BookClubShared.setWidgetSnapshot). */
  private func cover(_ bookId: String) -> UIImage? {
    if let image = covers[bookId] { return image }
    guard let file = BookClubShared.coverFile(bookId), let image = UIImage(contentsOfFile: file.path) else { return nil }
    covers[bookId] = image
    return image
  }
}
