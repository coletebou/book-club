import { type EventSubscription, requireOptionalNativeModule } from 'expo';

/**
 * Book Club's local Expo module (D189, ios/BookClubNativeModule.swift): the widgets' data and the
 * audiobook's Live Activity. Optional: a build made before it (or Expo Go) has none, and every
 * caller then does nothing.
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
  /** Share the session with the Messages extension, or delete it when signed out (D220). Absent before it. */
  shareSession?(origin: string): boolean;
  liveActivitiesAllowed(): boolean;
  showNowPlaying(record: NowPlayingRecord): Promise<void>;
  endNowPlaying(): Promise<void>;
  addListener(event: 'onTogglePlayback', listener: () => void): EventSubscription;
}

export const BookClubNative: BookClubNativeApi | null = requireOptionalNativeModule<BookClubNativeApi>('BookClubNative');
