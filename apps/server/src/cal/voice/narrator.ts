import { z } from 'zod';
import { type TranscriptWord } from '@bookclub/shared';
import { type Db } from '../../db/db';
import { type TtsVoice, type TtsVoiceSettings } from './types';

/**
 * A book's narrator's voice (D223), for Cal's spoken replies about that book, so stepping out of
 * the narration to ask a question does not hand the listener to a different speaker. Three
 * ElevenLabs voices may be kept for a book (migration 026), used in this order:
 *
 *   (a) narration: the voice the audiobook itself was generated with: the exact voice.
 *   (c) clone:     a clone of a human narrator, only with their recorded consent.
 *   (b) designed:  ElevenLabs Voice Design from a description of the narrator, never from their
 *                  recording (elevenlabs.ts, DESIGN_FIELDS).
 *
 * A book with none of them is answered in Cal's own voice, as before.
 */
export interface NarratorVoiceRow {
  book_id: string;
  narrator: string;
  narration_voice_id: string | null;
  designed_voice_id: string | null;
  design_description: string;
  clone_voice_id: string | null;
  clone_consent: string;
  settings_json: string;
  narrator_wpm: number | null;
  narrator_f0_hz: number | null;
  updated_at: number;
}

/** ElevenLabs' accepted speed range. */
export const SPEED_MIN = 0.7;
export const SPEED_MAX = 1.2;

/**
 * How a narrator's voice is spoken unless the book says otherwise: Multilingual v2, not Cal's
 * Flash v2.5. Measured on a designed voice (D223): Flash and Turbo speak it at about 280 words a
 * minute at speed 1 and still about 195 at ElevenLabs' slowest (0.7), where an audiobook narrator
 * reads at 125-155; Multilingual v2 speaks it at 177, and 156 at 0.7, in its long-form delivery,
 * for about 0.7 s more synthesis.
 */
export const NARRATOR_DEFAULTS: TtsVoiceSettings = { stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1, useSpeakerBoost: true, modelId: 'eleven_multilingual_v2', seed: 1 };

const unit = z.number().min(0).max(1);
export const NarratorSettingsSchema = z
  .object({
    stability: unit,
    similarityBoost: unit,
    style: unit,
    speed: z.number().min(SPEED_MIN).max(SPEED_MAX),
    useSpeakerBoost: z.boolean(),
    modelId: z.string().regex(/^[a-z0-9_]{1,64}$/),
    seed: z.number().int().min(0).max(4_294_967_295),
  })
  .partial()
  .strict();
export type NarratorSettings = z.infer<typeof NarratorSettingsSchema>;

/** An ElevenLabs voice id: letters and digits (20 of them today), never a path. */
export const VoiceIdSchema = z.string().regex(/^[A-Za-z0-9]{8,64}$/, 'not an ElevenLabs voice id');

export function narratorVoiceRow(db: Db, bookId: string): NarratorVoiceRow | undefined {
  return db.get<NarratorVoiceRow>('SELECT * FROM narrator_voices WHERE book_id = ?', [bookId]);
}

export function narratorVoiceRows(db: Db): NarratorVoiceRow[] {
  return db.all<NarratorVoiceRow>('SELECT * FROM narrator_voices ORDER BY updated_at DESC');
}

/** The settings a row is spoken with: its own over the defaults. A row whose JSON is no longer valid is spoken with the defaults. */
export function settingsOf(row: Pick<NarratorVoiceRow, 'settings_json'>): TtsVoiceSettings {
  let stored: unknown;
  try {
    stored = JSON.parse(row.settings_json);
  } catch {
    stored = {};
  }
  const parsed = NarratorSettingsSchema.safeParse(stored);
  return { ...NARRATOR_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}

/** The voice a book's replies are spoken in, or null for Cal's own: (a) narration, then (c) a consented clone, then (b) designed. */
export function resolveNarratorVoice(row: NarratorVoiceRow | undefined): Extract<TtsVoice, { kind: 'narrator' }> | null {
  if (!row) return null;
  const settings = settingsOf(row);
  const base = { kind: 'narrator', provider: 'elevenlabs', narrator: row.narrator, settings } as const;
  if (row.narration_voice_id) return { ...base, voiceId: row.narration_voice_id, source: 'narration' };
  // The table refuses a clone without consent (026's CHECK); asked again here so the rule is in the code that uses it.
  if (row.clone_voice_id && row.clone_consent.trim()) return { ...base, voiceId: row.clone_voice_id, source: 'clone' };
  if (row.designed_voice_id) return { ...base, voiceId: row.designed_voice_id, source: 'designed' };
  return null;
}

export function narratorVoiceFor(db: Db, bookId: string | null): Extract<TtsVoice, { kind: 'narrator' }> | null {
  return bookId ? resolveNarratorVoice(narratorVoiceRow(db, bookId)) : null;
}

export interface NarratorVoicePatch {
  readonly narrator?: string;
  readonly narrationVoiceId?: string | null;
  readonly designedVoiceId?: string | null;
  readonly designDescription?: string;
  readonly clone?: { readonly voiceId: string; readonly consent: string } | null;
  readonly settings?: NarratorSettings;
  readonly narratorWpm?: number | null;
  readonly narratorF0Hz?: number | null;
}

/** Create or change a book's narrator voice; settings are merged into the ones it has. */
export function saveNarratorVoice(db: Db, bookId: string, patch: NarratorVoicePatch, now = Date.now()): NarratorVoiceRow {
  if (patch.clone && !patch.clone.consent.trim()) throw new Error('a cloned voice needs a record of the narrator’s consent');
  if (patch.narrationVoiceId) VoiceIdSchema.parse(patch.narrationVoiceId);
  if (patch.designedVoiceId) VoiceIdSchema.parse(patch.designedVoiceId);
  if (patch.clone) VoiceIdSchema.parse(patch.clone.voiceId);
  const settings = patch.settings ? NarratorSettingsSchema.parse(patch.settings) : {};
  db.tx(() => {
    const row = narratorVoiceRow(db, bookId);
    const merged = { ...(row ? NarratorSettingsSchema.safeParse(JSON.parse(row.settings_json)).data : {}), ...settings };
    const next = {
      narrator: patch.narrator ?? row?.narrator ?? '',
      narration_voice_id: patch.narrationVoiceId !== undefined ? patch.narrationVoiceId : (row?.narration_voice_id ?? null),
      designed_voice_id: patch.designedVoiceId !== undefined ? patch.designedVoiceId : (row?.designed_voice_id ?? null),
      design_description: patch.designDescription ?? row?.design_description ?? '',
      clone_voice_id: patch.clone !== undefined ? (patch.clone?.voiceId ?? null) : (row?.clone_voice_id ?? null),
      clone_consent: patch.clone !== undefined ? (patch.clone?.consent.trim() ?? '') : (row?.clone_consent ?? ''),
      settings_json: JSON.stringify(merged),
      narrator_wpm: patch.narratorWpm !== undefined ? patch.narratorWpm : (row?.narrator_wpm ?? null),
      narrator_f0_hz: patch.narratorF0Hz !== undefined ? patch.narratorF0Hz : (row?.narrator_f0_hz ?? null),
    };
    db.exec(
      `INSERT INTO narrator_voices (book_id, narrator, narration_voice_id, designed_voice_id, design_description, clone_voice_id, clone_consent, settings_json, narrator_wpm, narrator_f0_hz, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (book_id) DO UPDATE SET narrator = excluded.narrator, narration_voice_id = excluded.narration_voice_id,
         designed_voice_id = excluded.designed_voice_id, design_description = excluded.design_description,
         clone_voice_id = excluded.clone_voice_id, clone_consent = excluded.clone_consent, settings_json = excluded.settings_json,
         narrator_wpm = excluded.narrator_wpm, narrator_f0_hz = excluded.narrator_f0_hz, updated_at = excluded.updated_at`,
      [bookId, next.narrator, next.narration_voice_id, next.designed_voice_id, next.design_description, next.clone_voice_id, next.clone_consent, next.settings_json, next.narrator_wpm, next.narrator_f0_hz, now],
    );
  });
  return narratorVoiceRow(db, bookId)!;
}

export function deleteNarratorVoice(db: Db, bookId: string): boolean {
  const had = !!narratorVoiceRow(db, bookId);
  db.exec('DELETE FROM narrator_voices WHERE book_id = ?', [bookId]);
  return had;
}

/** Fewer words than this in a track say too little of the narrator's pace (opening credits, a silent track). */
const PACE_MIN_TRACK_WORDS = 50;

/**
 * The narrator's pace, in words a minute, from the transcript's word timings: each track's words
 * over the time from its first word to its last, so pauses between sentences count (as they do in
 * a voice's own pace, ElevenLabsVoiceDesign.pace) and the silence before and after does not.
 * Null when the transcript holds too little speech to say.
 */
export function paceOf(tracks: readonly { readonly words: readonly TranscriptWord[] }[]): number | null {
  let words = 0;
  let ms = 0;
  for (const { words: w } of tracks) {
    if (w.length < PACE_MIN_TRACK_WORDS) continue;
    const span = w[w.length - 1]![1] - w[0]![0];
    if (!(span > 0)) continue;
    words += w.length;
    ms += span;
  }
  return words > 0 ? words / (ms / 60_000) : null;
}

/** The audiobook's transcripts for a book (every ready audio edition's), as their tracks. */
export function transcriptTracksFor(db: Db, bookId: string): { words: TranscriptWord[] }[] {
  const rows = db.all<{ tracks_json: string }>(
    `SELECT t.tracks_json FROM transcripts t JOIN editions e ON e.id = t.edition_id WHERE e.book_id = ? AND e.kind = 'audio' AND e.status = 'ready'`,
    [bookId],
  );
  return rows.flatMap((r) => JSON.parse(r.tracks_json) as { words: TranscriptWord[] }[]);
}

/** The speed that makes a voice that speaks at `voiceWpm` keep the narrator's `narratorWpm`, within ElevenLabs' range. */
export function matchedSpeed(narratorWpm: number, voiceWpm: number): number {
  const speed = narratorWpm / voiceWpm;
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed)) * 100) / 100;
}
