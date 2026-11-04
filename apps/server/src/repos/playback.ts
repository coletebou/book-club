import { type AudioControls, type BookAudioControls, type BookPlayback, DEFAULT_RATE, type ListeningSettings } from '@bookclub/shared';
import { type Db } from '../db/db';

/**
 * Listening speed (D195): a person's default, and the last speed they used for each book. Both
 * are last-writer-wins on the client's clock (`at`), like reading progress: a choice made offline
 * and sent later never overwrites a newer one made on another device in the meantime.
 */

/** Your default speed; 1.0x (at 0, older than any real choice) until you choose one. */
export function listeningSettings(db: Db, userId: string): ListeningSettings {
  const row = db.get<{ default_rate: number; at: number }>('SELECT default_rate, at FROM listening_settings WHERE user_id = ?', [userId]);
  return row ? { defaultRate: row.default_rate, at: row.at } : { defaultRate: DEFAULT_RATE, at: 0 };
}

/** Keep `defaultRate` unless a newer choice is already saved; returns what is saved now. */
export function setDefaultRate(db: Db, userId: string, defaultRate: number, at: number, now = Date.now()): ListeningSettings {
  db.exec(
    `INSERT INTO listening_settings (user_id, default_rate, at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET default_rate = excluded.default_rate, at = excluded.at, updated_at = excluded.updated_at
     WHERE excluded.at >= listening_settings.at`,
    [userId, defaultRate, at, now],
  );
  return listeningSettings(db, userId);
}

/** The last speed you used for this book, or null if you never chose one for it. */
export function bookPlayback(db: Db, userId: string, bookId: string): BookPlayback | null {
  const row = db.get<{ rate: number; at: number }>('SELECT rate, at FROM book_playback WHERE user_id = ? AND book_id = ?', [userId, bookId]);
  return row ? { rate: row.rate, at: row.at } : null;
}

/** Keep `rate` for this book unless a newer choice is already saved; returns what is saved now. */
export function setBookPlayback(db: Db, userId: string, bookId: string, rate: number, at: number, now = Date.now()): BookPlayback {
  db.exec(
    `INSERT INTO book_playback (user_id, book_id, rate, at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id) DO UPDATE SET rate = excluded.rate, at = excluded.at, updated_at = excluded.updated_at
     WHERE excluded.at >= book_playback.at`,
    [userId, bookId, rate, at, now],
  );
  return bookPlayback(db, userId, bookId)!;
}

/**
 * The audiobook's controls in the book (D197): your default (shown, at 0, until you choose), and a
 * book's own choice over it. Last-writer-wins on the client's clock, as the speed above.
 */
export function audioControlsDefault(db: Db, userId: string): AudioControls {
  const row = db.get<{ hidden: number; at: number }>('SELECT hidden, at FROM audio_controls_default WHERE user_id = ?', [userId]);
  return row ? { hidden: row.hidden === 1, at: row.at } : { hidden: false, at: 0 };
}

/** Keep `hidden` as your default unless a newer choice is already saved; returns what is saved now. */
export function setAudioControlsDefault(db: Db, userId: string, hidden: boolean, at: number, now = Date.now()): AudioControls {
  db.exec(
    `INSERT INTO audio_controls_default (user_id, hidden, at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET hidden = excluded.hidden, at = excluded.at, updated_at = excluded.updated_at
     WHERE excluded.at >= audio_controls_default.at`,
    [userId, hidden ? 1 : 0, at, now],
  );
  return audioControlsDefault(db, userId);
}

/** This book's own choice, or null if you never made one for it. */
export function bookAudioControls(db: Db, userId: string, bookId: string): BookAudioControls | null {
  const row = db.get<{ hidden: number | null; at: number }>('SELECT hidden, at FROM book_audio_controls WHERE user_id = ? AND book_id = ?', [userId, bookId]);
  return row ? { hidden: row.hidden === null ? null : row.hidden === 1, at: row.at } : null;
}

/** Keep this book's choice (null: as your default) unless a newer one is already saved; returns what is saved now. */
export function setBookAudioControls(db: Db, userId: string, bookId: string, hidden: boolean | null, at: number, now = Date.now()): BookAudioControls {
  db.exec(
    `INSERT INTO book_audio_controls (user_id, book_id, hidden, at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id) DO UPDATE SET hidden = excluded.hidden, at = excluded.at, updated_at = excluded.updated_at
     WHERE excluded.at >= book_audio_controls.at`,
    [userId, bookId, hidden === null ? null : hidden ? 1 : 0, at, now],
  );
  return bookAudioControls(db, userId, bookId)!;
}
