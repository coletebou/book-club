import * as FileSystem from 'expo-file-system/legacy';
import { AppState } from 'react-native';
import { BookClubNative } from '../../modules/book-club-native';
import { CarPlayDriver, type ServerPlace } from '../carplay/CarPlayDriver';
import { KeptQueues } from '../carplay/keptQueues';
import { SERVER_URL } from '../config';
import { LiveActivityDriver, NativeExtras } from '../widgets/NativeExtras';
import { NativeAudioEngine, type SendToWeb, configureAudioSession } from './NativeAudioEngine';
import { readKept, writeKept } from './keptFile';
import { createMediaTickets } from './mediaTicket';

/**
 * The app's one audiobook player (D221), made as the JavaScript starts rather than by the page's
 * WebView: CarPlay can start the app with no phone screen, so no React tree and no WebView (its
 * scene starts only the JavaScript, CarPlaySceneDelegate.swift), and must still find the player,
 * the kept place (D196) and the place saved while no page is open (D182). The WebView attaches
 * to it while it is mounted (`attachPage`); with none, what the player would tell a page goes
 * nowhere.
 */
let page: SendToWeb | null = null;
/** CarPlay's side (D221), made once the player is; none where this build has no native module. */
let car: CarPlayDriver | null = null;

// One AVAudioSession for the whole app (D132, D182), set before anything can play: the car too.
void configureAudioSession();

/** The widgets' data and the Live Activity (D188, D189). */
export const activity = new LiveActivityDriver(BookClubNative);

const QUEUES_FILE = `${FileSystem.documentDirectory ?? ''}bookclub-kept-queues.json`;
const queues = new KeptQueues(
  {
    read: () => FileSystem.getInfoAsync(QUEUES_FILE).then((info) => (info.exists ? FileSystem.readAsStringAsync(QUEUES_FILE) : null)),
    write: (json) => FileSystem.writeAsStringAsync(QUEUES_FILE, json),
    remove: () => FileSystem.deleteAsync(QUEUES_FILE, { idempotent: true }),
  },
  () => car?.refresh(),
);

export const engine: NativeAudioEngine = new NativeAudioEngine((json) => page?.(json), {
  // The place saved while the page sleeps (D182), or while CarPlay plays a book the page does not
  // have (D221); the same session cookie as the page (D133); and kept on the device (D196).
  progress: { serverUrl: SERVER_URL, fetch: (url, init) => fetch(url, init), now: Date.now, inBackground: () => engine.drivenByCar() || AppState.currentState !== 'active', keep: writeKept },
  // Streaming with a ticket (D219): AVPlayer's own requests carry no session cookie.
  tickets: createMediaTickets(SERVER_URL, (url, init) => fetch(url, init)),
  readKept,
  // The Live Activity follows the player, page asleep or not (D189), and so does the car.
  onNowPlaying: (np) => {
    activity.update(np);
    car?.setNowPlaying(np);
  },
  // Each audiobook opened on the phone, for the car to play later (D221).
  onQueue: (queue, metadata) =>
    queues.keep({
      bookId: queue.bookId,
      editionId: queue.editionId,
      userId: typeof queue.userId === 'string' ? queue.userId : null,
      title: metadata?.albumTitle ?? '',
      author: metadata?.artist ?? '',
      artworkUrl: metadata?.artworkUrl ?? null,
      tracks: queue.tracks.map((t) => ({ url: t.url, title: t.title })),
      at: Date.now(),
    }),
});

/** Your own place in a book, as the server has it: null when never started, undefined when it could not be asked. */
async function serverPlace(bookId: string): Promise<ServerPlace | null | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${SERVER_URL}/api/books/${encodeURIComponent(bookId)}/progress`, { credentials: 'include', signal: controller.signal });
    if (!res.ok) return undefined;
    const mine = ((await res.json()) as { mine?: unknown }).mine;
    if (mine === null) return null;
    if (!mine || typeof mine !== 'object') return undefined;
    const m = mine as { editionId?: unknown; locator?: unknown; at?: unknown };
    return {
      editionId: typeof m.editionId === 'string' ? m.editionId : null,
      locator: m.locator && typeof m.locator === 'object' ? (m.locator as ServerPlace['locator']) : null,
      at: typeof m.at === 'number' ? m.at : 0,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

car = BookClubNative ? new CarPlayDriver({ native: BookClubNative, engine, queues, serverPlace }) : null;
// A row tapped in the car (CarPlayController.swift); and the model drawn once at start.
BookClubNative?.addListener('onCarPlayCommand', (event) => void car?.command(event.id));
void queues.ready.then(() => car?.refresh());

/** The page's messages for the widgets and the Live Activity; a snapshot is also the car's book list. */
export const extras = new NativeExtras(BookClubNative, activity, SERVER_URL, (signedOut) => {
  if (signedOut) queues.clear();
  car?.refresh();
});

// The Live Activity's Play/Pause, pressed on the Lock Screen or in the Dynamic Island.
BookClubNative?.addListener('onTogglePlayback', () => engine.toggle());
AppState.addEventListener('change', (state) => {
  if (state === 'background') engine.backgrounded();
  // The Messages extension's session (D220): current again each time the app is opened.
  if (state === 'active') extras.shareSession();
});

/** The WebView's page, while it is there: what the player tells it. Returns the detach. */
export function attachPage(send: SendToWeb): () => void {
  page = send;
  return () => {
    if (page === send) page = null;
  };
}
