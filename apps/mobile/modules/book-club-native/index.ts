import { type EventSubscription, requireOptionalNativeModule } from 'expo';

/**
 * Book Club's local Expo module (D189, ios/BookClubNativeModule.swift): the widgets' data, the
 * audiobook's Live Activity, and CarPlay's lists (D221). Optional: a build made before it (or
 * Expo Go) has none, and every caller then does nothing.
 */
export interface NowPlayingRecord {
  readonly bookId: string;
  readonly title: string;
  readonly author: string;
  readonly chapter: string;
  readonly playing: boolean;
  /** When the file playing would have started and would end, at this speed (ms since the epoch). */
  readonly startedAt: number;
  readonly endsAt: number;
  /** How far through the file, 0 to 1. */
  readonly fraction: number;
  /** How far through the audiobook, 0 to 100. */
  readonly bookPercent: number;
}

export interface BookClubNativeApi {
  setWidgetSnapshot(json: string, covers: Record<string, string>): Promise<void>;
  clearWidgets(): void;
  liveActivitiesAllowed(): boolean;
  showNowPlaying(record: NowPlayingRecord): Promise<void>;
  endNowPlaying(): Promise<void>;
  addListener(event: 'onTogglePlayback', listener: () => void): EventSubscription;
  /** CarPlay (D221): what the car shows (`src/carplay/model.ts`'s CarPlayModel, as JSON), drawn as is. */
  setCarPlayModel(json: string): void;
  /** The widgets' snapshot as the App Group keeps it (D188), or null: the books the car lists. */
  widgetSnapshot(): string | null;
  /** A row tapped in the car: its id (`parseCarCommand`). */
  addListener(event: 'onCarPlayCommand', listener: (event: { id: string }) => void): EventSubscription;
}

export const BookClubNative: BookClubNativeApi | null = requireOptionalNativeModule<BookClubNativeApi>('BookClubNative');
