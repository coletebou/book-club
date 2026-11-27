// CarPlay (D221): an audio app's templates, drawn from the model JavaScript gives
// (src/carplay/model.ts, CarPlayModel.swift), with every tap sent back to it as the row's id. The
// player is the app's one AVPlayer (expo-audio, driven by NativeAudioEngine.ts), so the Now Playing
// screen is CarPlay's own, fed by the same Now Playing info and remote commands as the lock screen.
// The scene delegate that connects this is in the app target, and only in a build whose config has
// CarPlay on (plugins/with-carplay.ts): in any other build none of this ever runs.
//
// Now Playing's own buttons, the chapters behind its Up Next button, an action sheet and the voice
// screen (D232) are drawn from the model too, so what they are and what they do is JavaScript's,
// and can change without a new build. A model without them draws CarPlay's plain Now Playing.
//
// Every call that shows a template passes a completion: CarPlay throws when one fails with none
// (a second alert while one is up, a template already on the stack), and a throw there ends the app.
// A template the app's category may not show throws too (CarPlay Developer Guide, "Templates"), so
// the action sheet (an audio app's from iOS 17) and the voice screen (from iOS 27) are shown only
// where they exist, and JavaScript is told where they do not.
//
// No text here asks the driver to use the phone (the guide's guideline 2): it states the condition.
import CarPlay
import Foundation
import UIKit

public final class BookClubCarPlay: NSObject, CPNowPlayingTemplateObserver, CPInterfaceControllerDelegate {
  public static let shared = BookClubCarPlay()

  /** Now Playing takes at most five buttons (CPNowPlayingTemplate.updateNowPlayingButtons). */
  static let maximumButtons = 5

  private var interface: CPInterfaceController?
  /** The car's templates: made when a car connects, never in a build or a run without one. */
  private var screens: Screens?
  private var model = CarModel.empty
  private var navSeq = 0
  private var covers: [String: UIImage] = [:]
  /** What Now Playing's buttons were last drawn from; drawn again only when it changes. */
  private var drawnControls: CarControls?
  private var controlsDrawn = false
  /** The chapters pushed from Now Playing's Up Next button, while they are on the stack. */
  private weak var upNextList: CPListTemplate?
  /** The voice screen, while it is up, and the states it was made with. */
  private var voice: CPVoiceControlTemplate?
  private var voiceStates: [CarVoiceState] = []

  private struct Screens {
    let tabs: CPTabBarTemplate
    let continueList: CPListTemplate
    let booksList: CPListTemplate
    let chaptersList: CPListTemplate
  }

  /**
   * Taps and events, to JavaScript (BookClubNativeModule's `onCarPlayCommand`). Those sent before
   * it listens wait, in order (a car that started the app sends `connected`, then perhaps a tap,
   * before the JavaScript has run); only the newest few are kept.
   */
  var onCommand: ((String) -> Void)? {
    didSet {
      guard let onCommand, !pending.isEmpty else { return }
      let waiting = pending
      pending = []
      waiting.forEach(onCommand)
    }
  }
  private var pending: [String] = []
  static let maximumPending = 8

  private override init() {
    super.init()
  }

  /** The car connected (BookClubCarPlaySceneDelegate): the tabs, drawn from the model as it is now. */
  public func connect(_ interface: CPInterfaceController) {
    let continueList = CPListTemplate(title: "Continue", sections: [])
    continueList.tabImage = UIImage(systemName: "play.circle")
    continueList.emptyViewTitleVariants = ["Nothing to continue"]
    continueList.emptyViewSubtitleVariants = ["Audiobooks you have started appear here"]
    let booksList = CPListTemplate(title: "Club Books", sections: [])
    booksList.tabImage = UIImage(systemName: "books.vertical")
    booksList.emptyViewTitleVariants = ["No club books"]
    booksList.emptyViewSubtitleVariants = ["Your clubs' books appear here once you are signed in"]
    let chaptersList = CPListTemplate(title: "Chapters", sections: [])
    chaptersList.tabImage = UIImage(systemName: "list.bullet")
    chaptersList.emptyViewTitleVariants = ["No audiobook yet"]
    let tabs = CPTabBarTemplate(templates: [continueList, booksList, chaptersList])
    let nowPlaying = CPNowPlayingTemplate.shared
    nowPlaying.isUpNextButtonEnabled = false
    nowPlaying.isAlbumArtistButtonEnabled = false
    nowPlaying.add(self)
    interface.delegate = self
    self.interface = interface
    screens = Screens(tabs: tabs, continueList: continueList, booksList: booksList, chaptersList: chaptersList)
    controlsDrawn = false
    draw()
    interface.setRootTemplate(tabs, animated: false) { _, _ in }
    // A car is connected: recording is not allowed while it is (the guide's "Recording"), so
    // JavaScript makes the audio session playback-only until `disconnected` (appAudio.ts).
    send("connected")
  }

  public func disconnect() {
    CPNowPlayingTemplate.shared.remove(self)
    interface?.delegate = nil
    interface = nil
    screens = nil
    voice = nil
    voiceStates = []
    upNextList = nil
    controlsDrawn = false
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
    if let onCommand {
      onCommand(id)
    } else {
      pending.append(id)
      if pending.count > BookClubCarPlay.maximumPending { pending.removeFirst(pending.count - BookClubCarPlay.maximumPending) }
    }
  }

  private func draw() {
    guard let screens else { return }
    screens.continueList.updateSections(model.continueRow.map { [CPListSection(items: [item($0)])] } ?? [])
    screens.booksList.updateSections(model.books.isEmpty ? [] : [CPListSection(items: model.books.map(item))])
    screens.chaptersList.updateSections(chapterSections())
    upNextList?.updateSections(chapterSections())
    drawControls()
  }

  /** Now Playing's buttons and its Up Next button (D232), from the model; none of either without `controls`. */
  private func drawControls() {
    let controls = model.controls
    if controlsDrawn && controls == drawnControls { return }
    controlsDrawn = true
    drawnControls = controls
    let nowPlaying = CPNowPlayingTemplate.shared
    nowPlaying.updateNowPlayingButtons((controls?.buttons ?? []).compactMap(button).prefix(BookClubCarPlay.maximumButtons).map { $0 })
    nowPlaying.isUpNextButtonEnabled = controls?.upNext != nil
    if let title = controls?.upNext { nowPlaying.upNextTitle = title }
  }

  /** One of Now Playing's buttons: CarPlay's own speed button, or an SF Symbol; nil for a symbol this iOS lacks. */
  private func button(_ button: CarButton) -> CPNowPlayingButton? {
    let tapped: (CPNowPlayingButton) -> Void = { [weak self] _ in self?.send("control:\(button.id)") }
    if button.system == "rate" { return CPNowPlayingPlaybackRateButton(handler: tapped) }
    guard let symbol = button.symbol, let image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium)) else { return nil }
    return CPNowPlayingImageButton(image: image, handler: tapped)
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
      // Already showing, on the stack under the chapters, or not there yet.
      let nowPlaying = CPNowPlayingTemplate.shared
      if interface.topTemplate === nowPlaying { break }
      if interface.templates.contains(where: { $0 === nowPlaying }) {
        interface.pop(to: nowPlaying, animated: true) { _, _ in }
      } else {
        interface.pushTemplate(nowPlaying, animated: true) { _, _ in }
      }
    case "chapters":
      if #available(iOS 17.0, *) {
        screens.tabs.select(screens.chaptersList)
      } else {
        interface.pushTemplate(CPListTemplate(title: "Chapters", sections: chapterSections()), animated: true) { _, _ in }
      }
    case "message":
      present(CPAlertTemplate(titleVariants: [nav.message ?? ""], actions: [
        CPAlertAction(title: "OK", style: .cancel) { [weak self] _ in self?.dismiss() },
      ]))
    case "sheet":
      let actions = (nav.actions ?? []).map { action in
        CPAlertAction(title: action.title, style: style(action.style)) { [weak self] _ in
          self?.dismiss()
          self?.send("control:\(action.id)")
        }
      }
      guard !actions.isEmpty else { break }
      // An audio app may show an action sheet from iOS 17; before it CarPlay throws.
      if #available(iOS 17.0, *) {
        present(CPActionSheetTemplate(title: nav.message, message: nil, actions: actions))
      } else {
        send("sheet:unavailable")
      }
    case "voice":
      if let voice = nav.voice { showVoice(voice) }
    case "dismiss":
      dismiss()
    default:
      break
    }
  }

  private func style(_ style: String?) -> CPAlertAction.Style {
    switch style {
    case "cancel": return .cancel
    case "destructive": return .destructive
    default: return .default
    }
  }

  /** Shows a template over the others, in place of one already up: CarPlay takes one at a time. */
  private func present(_ template: CPTemplate, then: (() -> Void)? = nil) {
    guard let interface else { return }
    let show = { interface.presentTemplate(template, animated: true) { ok, _ in if ok { then?() } } }
    if interface.presentedTemplate != nil {
      voice = nil
      interface.dismissTemplate(animated: false) { _, _ in show() }
    } else {
      show()
    }
  }

  private func dismiss() {
    voice = nil
    interface?.dismissTemplate(animated: true) { _, _ in }
  }

  /**
   * The voice screen (D232): shown, or moved to another of its states while it is up. An audio app
   * may show it from iOS 27; on an older one JavaScript is told, and nothing is shown.
   */
  private func showVoice(_ next: CarVoice) {
    guard #available(iOS 27.0, *) else {
      send("voice:unavailable")
      return
    }
    // At most five states (CPVoiceControlTemplate); the first is the one shown until another is asked for.
    let states = Array(next.states.prefix(5))
    // Only a state the screen was made with can be shown.
    let asked = states.contains { $0.id == next.state } ? next.state : states.first?.id
    if let voice, voiceStates == next.states {
      if let asked { voice.activateVoiceControlState(withIdentifier: asked) }
      return
    }
    guard !states.isEmpty, let asked else { return }
    let template = CPVoiceControlTemplate(voiceControlStates: states.map { state in
      let image = state.symbol.flatMap { UIImage(systemName: $0, withConfiguration: UIImage.SymbolConfiguration(pointSize: 96, weight: .regular)) }
      return CPVoiceControlState(identifier: state.id, titleVariants: [state.title], image: image, repeats: true)
    })
    if let cancel = next.cancel {
      template.leadingNavigationBarButtons = [CPBarButton(title: cancel) { [weak self] _ in
        self?.dismiss()
        self?.send("voice:cancel")
      }]
    }
    present(template) { [weak self] in
      guard let self else { return }
      self.voice = template
      self.voiceStates = next.states
      template.activateVoiceControlState(withIdentifier: asked)
      self.send("voice:shown")
    }
  }

  // MARK: CPNowPlayingTemplateObserver

  /** Now Playing's Up Next button (D232): the chapters, as a list over it. A chapter's tap is a row's, as in the tab. */
  public func nowPlayingTemplateUpNextButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
    guard let interface, upNextList == nil else { return }
    let list = CPListTemplate(title: model.controls?.upNext ?? "Chapters", sections: chapterSections())
    upNextList = list
    interface.pushTemplate(list, animated: true) { [weak self] ok, _ in if !ok { self?.upNextList = nil } }
  }

  public func nowPlayingTemplateAlbumArtistButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {}

  // MARK: CPInterfaceControllerDelegate

  /** The voice screen went away by something other than JavaScript (the car's own back button): it is told. */
  public func templateDidDisappear(_ aTemplate: CPTemplate, animated: Bool) {
    if aTemplate === voice {
      voice = nil
      send("voice:closed")
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
