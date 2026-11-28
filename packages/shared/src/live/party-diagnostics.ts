import { z } from 'zod/mini';
import { NATIVE_ERROR_DOMAINS } from '../audio/offline-file';

/** Small, closed vocabulary (D302): never accept URLs, paths, error text, names or user content. */
export const PartyDiagnosticEventSchema = z.strictObject({
  event: z.enum(['joined', 'sync', 'control-request', 'control-result', 'media', 'source', 'native-source', 'native-download', 'native-seek', 'native-error']),
  elapsedMs: z.number().check(z.minimum(0), z.maximum(604_800_000)),
  track: z.optional(z.int().check(z.minimum(0), z.maximum(100_000))),
  position: z.optional(z.number().check(z.minimum(0), z.maximum(604_800))),
  expected: z.optional(z.number().check(z.minimum(0), z.maximum(604_800))),
  drift: z.optional(z.number().check(z.minimum(-604_800), z.maximum(604_800))),
  rate: z.optional(z.number().check(z.minimum(0), z.maximum(4))),
  partyRate: z.optional(z.number().check(z.minimum(0.5), z.maximum(3))),
  playing: z.optional(z.boolean()),
  partyPlaying: z.optional(z.boolean()),
  buffering: z.optional(z.boolean()),
  seeking: z.optional(z.boolean()),
  readyState: z.optional(z.int().check(z.minimum(0), z.maximum(4))),
  stateAgeMs: z.optional(z.number().check(z.minimum(0), z.maximum(604_800_000))),
  statusAgeMs: z.optional(z.number().check(z.minimum(0), z.maximum(604_800_000))),
  durationMs: z.optional(z.number().check(z.minimum(0), z.maximum(604_800_000))),
  decision: z.optional(z.enum(['steady', 'track', 'seek', 'nudge', 'rate', 'hold', 'suspended'])),
  forced: z.optional(z.enum(['play', 'pause', 'none'])),
  action: z.optional(z.enum(['play', 'pause', 'seek', 'rate', 'resume', 'settings'])),
  outcome: z.optional(z.enum(['ok', 'failed', 'blocked', 'superseded', 'started'])),
  mediaEvent: z.optional(z.enum(['loadstart', 'loadedmetadata', 'waiting', 'stalled', 'playing', 'play', 'pause', 'seeking', 'seeked', 'ended', 'error', 'emptied'])),
  source: z.optional(z.enum(['native-local', 'native-network', 'native-unknown', 'browser-cache-available', 'browser-network', 'browser-unknown'])),
  platform: z.optional(z.enum(['native', 'web'])),
  visibility: z.optional(z.enum(['visible', 'hidden'])),
  /** A native playback error's domain, from a closed list (D219): never the error's own text. */
  errorDomain: z.optional(z.enum(NATIVE_ERROR_DOMAINS)),
  /** Its code (an NSError code, an int32). */
  errorCode: z.optional(z.int().check(z.minimum(-2147483648), z.maximum(2147483647))),
  /** Whether native went on from the network after a kept copy failed (D219). */
  recovered: z.optional(z.boolean()),
});
export type PartyDiagnosticEvent = z.infer<typeof PartyDiagnosticEventSchema>;
export type PartyDiagnosticInput = Omit<PartyDiagnosticEvent, 'elapsedMs'>;

export const PARTY_DIAGNOSTIC_BATCH_MAX = 20;
/** Native sends this small subset to the web shell; the shell supplies timing and party context. */
export const NativeAudioDiagnosticSchema = z.extend(z.pick(PartyDiagnosticEventSchema, { event: true, source: true, outcome: true, durationMs: true, errorDomain: true, errorCode: true, recovered: true }), {
  event: z.enum(['native-source', 'native-download', 'native-seek', 'native-error']),
});
export type NativeAudioDiagnostic = z.infer<typeof NativeAudioDiagnosticSchema>;

/** The events a listener outside a party may send (D219): native playback's own, nothing else. */
export const SOLO_DIAGNOSTIC_EVENTS: readonly PartyDiagnosticEvent['event'][] = ['native-source', 'native-download', 'native-seek', 'native-error'];
