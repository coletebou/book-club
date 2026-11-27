import { z } from 'zod';
import { AudioLocatorSchema } from '../timeline/locator-schemas';
import { IdSchema } from './schemas';

export const CarCalQuestionSchema = z.enum(['recap', 'scene', 'club']);
export type CarCalQuestion = z.infer<typeof CarCalQuestionSchema>;

export const CarCalBodySchema = z.object({
  question: CarCalQuestionSchema,
  editionId: IdSchema,
  locator: AudioLocatorSchema,
});
export type CarCalBody = z.infer<typeof CarCalBodySchema>;

/** The maximum size of the spoken answer before base64 encoding. */
export const CAR_CAL_AUDIO_MAX_BYTES = 1024 * 1024;

export const CarCalReplySchema = z.object({
  answer: z.string().min(1).max(2400),
  mimeType: z.enum(['audio/mpeg', 'audio/wav']),
  audioBase64: z.string().min(4).max(4 * Math.ceil(CAR_CAL_AUDIO_MAX_BYTES / 3)).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type CarCalReply = z.infer<typeof CarCalReplySchema>;
