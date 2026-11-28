import type { CalConsent } from '@bookclub/shared';
import type { AppContext } from '../context';
import { sha256Hex } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { calConsentProviders } from '../services/privacy-policy';
import { calEnabled } from '../services/chat-agents';
import { settingsFor } from './store';

/** D272: a grant is valid only for the current disclosure and provider configuration. */
export function calConsentFor(ctx: Pick<AppContext, 'config' | 'db'>, userId: string): CalConsent {
  const config = ctx.config;
  const recipients = calConsentProviders(config);
  const enabled = calEnabled(config) && recipients !== null;
  const providers = enabled ? recipients ?? [] : [];
  const grant = settingsFor(ctx.db, userId).ai_consent_version;
  const version = sha256Hex(JSON.stringify([
    1, providers, config.CAL_MODEL, config.ANTHROPIC_BASE_URL, config.CAL_SOL_BASE_URL,
    config.CAL_EMBEDDING_PROVIDER, config.CAL_STT_PROVIDER, config.CAL_TTS_PROVIDER, config.CAL_WEB_SEARCH,
  ]));
  return { enabled, allowed: enabled && grant === version, hasGrant: grant !== null, version, providers };
}

export function requireCalConsent(ctx: Pick<AppContext, 'config' | 'db'>, userId: string): void {
  if (!calConsentFor(ctx, userId).allowed) throw new HttpError(403, 'cal_consent_required', 'Allow AI access to use Cal.');
}
