import { RateLimiter } from '../../auth/ratelimit';
import { type AppContext } from '../../context';
import { logCost } from '../store';
import { type SttOptions, type SttProvider } from './types';

const rateLimits = new WeakMap<AppContext, RateLimiter>();

/** Dictation and Cal's spoken turns both spend the voice allowance. */
export function voiceRateLimiterFor(ctx: AppContext): RateLimiter {
  let limiter = rateLimits.get(ctx);
  if (!limiter) {
    limiter = new RateLimiter(ctx.config.CAL_RATE_LIMIT_PER_MINUTE, 60_000);
    rateLimits.set(ctx, limiter);
  }
  return limiter;
}

export async function transcribeAndLog(
  ctx: AppContext,
  who: { clubId: string; userId: string },
  stt: SttProvider,
  audio: Uint8Array,
  mimeType: string,
  options?: SttOptions,
): Promise<string> {
  const recordCost = (costUsd: number) => logCost(ctx.db, { ...who, kind: 'voice_stt', provider: stt.name, model: stt.model, inputUnits: audio.byteLength, outputUnits: 0, costUsd });
  const result = await stt.transcribe(audio, mimeType, options).catch((error: unknown) => {
    // The provider can charge for a submitted clip even when a reply never reaches us.
    if (options?.durationSeconds !== undefined && stt.estimatedCostUsdPerMinute !== undefined) {
      recordCost(options.durationSeconds / 60 * stt.estimatedCostUsdPerMinute);
    }
    throw error;
  });
  recordCost(result.costUsd);
  return result.text;
}
