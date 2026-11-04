import { type ConfigPlugin, withInfoPlist } from 'expo/config-plugins';

export interface AppBoundDomainsProps {
  /** Up to 10 hostnames (no scheme, no path); Apple's limit, enforced here so prebuild fails loudly. */
  readonly domains: readonly string[];
}

/**
 * `WKAppBoundDomains` (D135): without it, WKWebView serves `apps/web`'s service worker (offline
 * reading) unreliably — the whole reason the feature exists (webkit.org/blog/10882/app-bound-domains).
 * The WebView itself opts in via `limitsNavigationsToAppBoundDomains` (a prop, not an Info.plist
 * key; `src/webview/BookClubWebView.tsx`).
 */
const withAppBoundDomains: ConfigPlugin<AppBoundDomainsProps> = (config, { domains }) => {
  if (domains.length === 0) throw new Error('withAppBoundDomains: at least one domain is required');
  if (domains.length > 10) throw new Error(`withAppBoundDomains: Apple allows at most 10 app-bound domains, got ${domains.length}`);
  return withInfoPlist(config, (config) => {
    config.modResults.WKAppBoundDomains = [...domains];
    return config;
  });
};

export default withAppBoundDomains;
