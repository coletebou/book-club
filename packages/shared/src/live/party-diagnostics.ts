import { z } from 'zod';
import { NATIVE_ERROR_DOMAINS } from '../audio/offline-file';

/** Small, closed vocabulary: never accept URLs, paths, error text, names or user content. */
export const PartyDiagnosticEventSchema = z.strictObject({
  event: z.enum(['joined', 'sync', 'control-request', 'control-result', 'media', 'source', 'native-source', 'native-download', 'native-seek', 'native-error']),
  elapsedMs: z.number().min(0).max(604_800_000),
  track: z.int().min(0).max(100_000).optional(),
  position: z.number().min(0).max(604_800).optional(),
  expected: z.number().min(0).max(604_800).optional(),
  drift: z.number().min(-604_800).max(604_800).optional(),
  rate: z.number().min(0).max(4).optional(),
  partyRate: z.number().min(0.5).max(3).optional(),
  playing: z.boolean().optional(),
  partyPlaying: z.boolean().optional(),
  buffering: z.boolean().optional(),
  seeking: z.boolean().optional(),
  readyState: z.int().min(0).max(4).optional(),
  stateAgeMs: z.number().min(0).max(604_800_000).optional(),
  statusAgeMs: z.number().min(0).max(604_800_000).optional(),
  durationMs: z.number().min(0).max(604_800_000).optional(),
  decision: z.enum(['steady', 'track', 'seek', 'nudge', 'rate', 'hold', 'suspended']).optional(),
  forced: z.enum(['play', 'pause', 'none']).optional(),
  action: z.enum(['play', 'pause', 'seek', 'rate', 'resume', 'settings']).optional(),
  outcome: z.enum(['ok', 'failed', 'blocked', 'superseded', 'started']).optional(),
  mediaEvent: z.enum(['loadstart', 'loadedmetadata', 'waiting', 'stalled', 'playing', 'play', 'pause', 'seeking', 'seeked', 'ended', 'error', 'emptied']).optional(),
  source: z.enum(['native-local', 'native-network', 'native-unknown', 'browser-cache-available', 'browser-network', 'browser-unknown']).optional(),
  platform: z.enum(['native', 'web']).optional(),
  visibility: z.enum(['visible', 'hidden']).optional(),
  /** A native playback error's domain, from a closed list (D207): never the error's own text. */
  errorDomain: z.enum(NATIVE_ERROR_DOMAINS).optional(),
  /** Its code (an NSError code, an int32). */
  errorCode: z.int().min(-2147483648).max(2147483647).optional(),
  /** Whether native went on from the network after a kept copy failed (D207). */
  recovered: z.boolean().optional(),
});
export type PartyDiagnosticEvent = z.infer<typeof PartyDiagnosticEventSchema>;
export type PartyDiagnosticInput = Omit<PartyDiagnosticEvent, 'elapsedMs'>;

export const PARTY_DIAGNOSTIC_BATCH_MAX = 20;
export const PartyDiagnosticsBodySchema = z.strictObject({
  version: z.literal(1),
  partyId: z.uuid().optional(),
  /** Random per participation, not a persistent device identifier. */
  sessionId: z.uuid(),
  events: z.array(PartyDiagnosticEventSchema).min(1).max(PARTY_DIAGNOSTIC_BATCH_MAX),
});
export type PartyDiagnosticsBody = z.infer<typeof PartyDiagnosticsBodySchema>;

/** Native sends this small subset to the web shell; the shell supplies timing and party context. */
export const NativeAudioDiagnosticSchema = PartyDiagnosticEventSchema.pick({ event: true, source: true, outcome: true, durationMs: true, errorDomain: true, errorCode: true, recovered: true }).extend({
  event: z.enum(['native-source', 'native-download', 'native-seek', 'native-error']),
});
export type NativeAudioDiagnostic = z.infer<typeof NativeAudioDiagnosticSchema>;

/** The events a listener outside a party may send (D207): native playback's own, nothing else. */
export const SOLO_DIAGNOSTIC_EVENTS: readonly PartyDiagnosticEvent['event'][] = ['native-source', 'native-download', 'native-seek', 'native-error'];
