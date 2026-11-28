import type { CalConsent } from '@bookclub/shared';
import { requireMember } from '../auth/access';
import type { AppContext } from '../context';
import { sha256Hex } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { calConsentProviders } from '../services/privacy-policy';
import { calEnabled } from '../services/chat-agents';
import { settingsFor } from './store';
import { sttProviderFor } from './voice';

const DISCLOSURE_VERSION = 2;

function disclosure(config: AppContext['config']) {
  const recipients = calConsentProviders(config);
  const enabled = (calEnabled(config) || sttProviderFor(config) !== null) && recipients !== null;
  const providers = enabled ? recipients ?? [] : [];
  const version = sha256Hex(JSON.stringify([
    DISCLOSURE_VERSION, providers, config.CAL_MODEL, config.ANTHROPIC_BASE_URL, config.CAL_SOL_BASE_URL,
    config.CAL_EMBEDDING_PROVIDER, config.CAL_STT_PROVIDER, config.CAL_TTS_PROVIDER, config.CAL_WEB_SEARCH,
  ]));
  return { enabled, version, providers };
}

/** D272: a grant is valid only for the current disclosure and provider configuration. */
export function calConsentFor(ctx: Pick<AppContext, 'config' | 'db'>, userId: string): CalConsent {
  const current = disclosure(ctx.config);
  const grant = settingsFor(ctx.db, userId).ai_consent_version;
  return { ...current, allowed: current.enabled && grant === current.version, hasGrant: grant !== null };
}

export function clubHasCalConsent(ctx: Pick<AppContext, 'config' | 'db'>, clubId: string): boolean {
  const current = disclosure(ctx.config);
  return calEnabled(ctx.config) && current.enabled && !!ctx.db.get(
    `SELECT 1 FROM memberships m JOIN cal_settings s ON s.user_id = m.user_id
     JOIN clubs c ON c.id = m.club_id WHERE m.club_id = ? AND c.deleted_at IS NULL AND s.ai_consent_version = ? LIMIT 1`,
    [clubId, current.version],
  );
}

export function requireCalConsent(ctx: Pick<AppContext, 'config' | 'db'>, userId: string): void {
  if (!calConsentFor(ctx, userId).allowed) throw new HttpError(403, 'cal_consent_required', 'Allow AI access to use Cal.');
}

export function requireClubCalConsent(ctx: Pick<AppContext, 'config' | 'db'>, clubId: string, userId: string): void {
  requireMember(ctx.db, clubId, userId);
  requireCalConsent(ctx, userId);
}
