import { RateLimiter } from '../../auth/ratelimit';
import { type AppContext } from '../../context';

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
