import { z } from 'zod';

export const CalConsentBodySchema = z.discriminatedUnion('allow', [
  z.object({ allow: z.literal(true), version: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ allow: z.literal(false) }).strict(),
]);
export type CalConsentBody = z.infer<typeof CalConsentBodySchema>;

export interface CalConsent {
  readonly enabled: boolean;
  readonly allowed: boolean;
  readonly hasGrant: boolean;
  readonly version: string;
  readonly providers: readonly string[];
}
