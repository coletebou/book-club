import { z } from 'zod';
import { PARTY_DIAGNOSTIC_BATCH_MAX, PartyDiagnosticEventSchema } from './party-diagnostics';

export const PartyDiagnosticsBodySchema = z.strictObject({
  version: z.literal(1),
  partyId: z.uuid().optional(),
  /** Random per participation, not a persistent device identifier. */
  sessionId: z.uuid(),
  events: z.array(PartyDiagnosticEventSchema).min(1).max(PARTY_DIAGNOSTIC_BATCH_MAX),
});
export type PartyDiagnosticsBody = z.infer<typeof PartyDiagnosticsBodySchema>;
