import { isIP } from 'node:net';
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false', 'yes', 'no', ''])])
  .transform((v) => v === true || v === '1' || v === 'true' || v === 'yes');

/** An optional setting, where an empty value (`NAME=` in a compose file) means unset. */
const unsetIfEmpty = (v: unknown) => (v === '' ? undefined : v);

/** An optional http(s) address. */
const httpAddress = z.preprocess(
  unsetIfEmpty,
  z
    .string()
    .refine((v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol), 'an http(s) address')
    .optional(),
);

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isAddressOrRange(token: string): boolean {
  if (PROXY_KEYWORDS.has(token)) return true;
  const [address, prefix, ...rest] = token.split('/');
  const family = isIP(address ?? '');
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return /^\d+$/.test(prefix) && bits <= (family === 4 ? 32 : 128);
}

/**
 * Which proxies may tell us the client's address (X-Forwarded-For) and scheme: none by default,
 * or the proxies' own addresses, ranges and keywords ("loopback", "172.16.0.0/12", "uniquelocal").
 * Trusting every hop ("true") would let a client choose its own address and walk past the
 * sign-in limits, and Fastify ignores bare hop counts, so neither is accepted.
 */
const trustProxy = z.string().transform((raw, ctx): false | string => {
  const value = raw.trim().toLowerCase();
  if (['', '0', 'false', 'no', 'off'].includes(value)) return false;
  const tokens = value.split(',').map((t) => t.trim()).filter(Boolean);
  const bad = tokens.filter((t) => !isAddressOrRange(t));
  if (tokens.length === 0 || bad.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `TRUST_PROXY lists the proxies' addresses (e.g. "loopback" or "172.16.0.0/12"), not ${JSON.stringify(bad.join(', ') || raw)}`,
    });
    return z.NEVER;
  }
  return tokens.join(', ');
});

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(47100),
  DATA_DIR: z.string().default('.data'),
  /** The public origin, e.g. https://books.example. Used for invite links. Derived from Host if unset. */
  PUBLIC_ORIGIN: z.string().optional(),
  /** Extra origins allowed to make state-changing requests (comma-separated). */
  ALLOWED_ORIGINS: z.string().default(''),
  TRUST_PROXY: trustProxy.default(false),
  /**
   * A secret the trusted proxy sends in `X-Bookclub-Proxy-Key`. When set, a request's
   * X-Forwarded-* headers count only if it carries the key: on a host with other users, they
   * reach the app from the same address as the proxy (auth/proxy-key.ts, docs/DEPLOY.md).
   */
  TRUST_PROXY_KEY: z.preprocess(unsetIfEmpty, z.string().min(32, 'TRUST_PROXY_KEY must be at least 32 characters').optional()),
  /** `auto`: Secure cookies when the request arrived over HTTPS. */
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  SESSION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  /** Directory of the built web app to serve; empty disables static serving. */
  WEB_DIST: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(4 * 1024 ** 3),
  /** Partial uploads older than this are deleted. */
  UPLOAD_EXPIRY_HOURS: z.coerce.number().positive().default(24 * 7),
  /**
   * Upstream identity through the upstream's sign-in grant (D116): the browser is sent to
   * the start address, and this server redeems the one-time code it comes back with at the
   * exchange address. Two addresses, as the browser and this server may reach the upstream by
   * different names (the demo stack: a published port, and the compose network). Both or neither.
   */
  UPSTREAM_START_URL: httpAddress,
  UPSTREAM_EXCHANGE_URL: httpAddress,
  /**
   * A password typed into this app's own sign-in form, checked at the upstream instead of its
   * page (D173: the iOS app's WebView cannot come back from a bounce to a whole other site).
   * Reached only server to server, like the exchange address, and optional on its own: without
   * it, `/api/auth/signin` still offers only a local password or, with the two addresses above,
   * "Continue with" the upstream's own page.
   */
  UPSTREAM_PASSWORD_URL: httpAddress,
  /**
   * The bearer the upstream's password check requires (`Authorization: Bearer ...`): that
   * endpoint is a credential check, so the upstream refuses it to anyone but this server. Set
   * together with UPSTREAM_PASSWORD_URL, or neither. Never logged.
   */
  UPSTREAM_PASSWORD_SECRET: z.preprocess(unsetIfEmpty, z.string().min(16, 'UPSTREAM_PASSWORD_SECRET must be at least 16 characters').optional()),
  /** What people call the upstream account ("Continue with <name>"). */
  UPSTREAM_NAME: z.preprocess(unsetIfEmpty, z.string().trim().min(1).max(40).default('your main account')),
  /**
   * Whether the first owner may be created from the browser on an empty instance. A public
   * deployment turns it off and uses `bookclub create-owner`, so nobody else can claim the
   * instance in the minutes between starting it and creating the owner (REVIEW SA43).
   */
  WEB_SETUP: bool.default(true),
  /** Seed the demo club on an empty database (see cli/seed.ts). */
  SEED_DEMO: bool.default(false),
  DEMO_ASSETS: z.string().default(''),
  /** Rate limit for sign-in attempts per IP and email (per 15 minutes). */
  SIGNIN_ATTEMPTS: z.coerce.number().int().positive().default(10),
  /**
   * Speech recognition for read-along (D46), run on each new audiobook in the background: a
   * command given `--out FILE` and the track files, writing a bookclub-transcript/1 document
   * (tools/align/transcribe.py). Off when unset.
   */
  TRANSCRIBE_COMMAND: z.string().optional(),
  /**
   * Longest audiobook, in hours, the recogniser reads by itself (War and Peace is 61 h): a run may
   * take twice the audio's length, so a longer upload would hold every other audiobook's for days.
   * Its owner can still give it a transcript.
   */
  TRANSCRIBE_MAX_HOURS: z.coerce.number().positive().default(100),
  /** log2 of the scrypt cost for new password hashes (17 per OWASP; tests use less). */
  SCRYPT_LOG_N: z.coerce.number().int().min(10).max(20).default(17),

  /*
   * Cal (Callimachus), D160-D169 (docs/DECISIONS.md). Every key below is optional: without
   * ANTHROPIC_API_KEY, Cal is hidden entirely (no routes 404, the web app never shows him).
   */
  ANTHROPIC_API_KEY: z.preprocess(unsetIfEmpty, z.string().optional()),
  /** Explicit server-side Anthropic-compatible endpoint; never set by a browser request. */
  ANTHROPIC_BASE_URL: httpAddress,
  ANTHROPIC_AUTH_MODE: z.enum(['api-key', 'bearer']).default('api-key'),
  /** A private model gateway's accounting identity, only allowed with an explicit custom endpoint. */
  ANTHROPIC_TENANT_ID: z.preprocess(unsetIfEmpty, z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional()),
  /**
   * The request header that carries ANTHROPIC_TENANT_ID to that gateway (sent only with one): each
   * gateway names its own. Never one a provider reads for authentication (`x-api-key`).
   */
  ANTHROPIC_TENANT_HEADER: z.preprocess(
    unsetIfEmpty,
    z.string().regex(/^x-[a-z0-9][a-z0-9-]{0,62}$/).refine((name) => name !== 'x-api-key', 'ANTHROPIC_TENANT_HEADER must not be x-api-key').default('x-gateway-tenant'),
  ),
  /** Explicit private Mantle Responses fallback, disabled when unset. */
  CAL_SOL_BASE_URL: httpAddress,
  CAL_SOL_MODEL: z.literal('openai.gpt-6.1-sol').default('openai.gpt-6.1-sol'),
  CAL_SOL_INPUT_USD_PER_MILLION: z.preprocess(unsetIfEmpty, z.coerce.number().positive().optional()),
  CAL_SOL_OUTPUT_USD_PER_MILLION: z.preprocess(unsetIfEmpty, z.coerce.number().positive().optional()),
  CAL_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  /** Claude model for Cal's chat and voice brain. docs/claude-api skill: a strong default. */
  CAL_MODEL: z.string().default('claude-opus-5-5'),
  /** Where embeddings come from. `fake` is deterministic and used by tests; needs no key. */
  CAL_EMBEDDING_PROVIDER: z.enum(['openai', 'gemini', 'fake']).default('openai'),
  OPENAI_API_KEY: z.preprocess(unsetIfEmpty, z.string().optional()),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  GOOGLE_API_KEY: z.preprocess(unsetIfEmpty, z.string().optional()),
  GOOGLE_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  /** Voice: speech-to-text and text-to-speech providers (D160, architecture (b): STT -> Claude -> TTS). */
  CAL_STT_PROVIDER: z.enum(['elevenlabs', 'openai', 'fake']).default('elevenlabs'),
  CAL_TTS_PROVIDER: z.enum(['elevenlabs', 'openai', 'fake']).default('elevenlabs'),
  ELEVENLABS_API_KEY: z.preprocess(unsetIfEmpty, z.string().optional()),
  /** "George" — warm, captivating storyteller: a fit for Cal's librarian persona (D167, measured). */
  ELEVENLABS_VOICE_ID: z.string().default('JBFqnCBsd6RMkjVDRZzb'),
  /** How many chat or voice turns a member may start with Cal per minute. */
  CAL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** A club's Cal spend (embeddings, chat, voice) resets to $0 at the start of each calendar month. */
  CAL_MONTHLY_SPEND_CAP_USD: z.coerce.number().positive().default(20),
  /**
   * Every club's Cal spend together, per calendar month (D176): with starting a club open to
   * every account, the per-club cap alone no longer bounds what the instance can spend.
   */
  CAL_INSTANCE_MONTHLY_SPEND_CAP_USD: z.coerce.number().positive().default(100),
  /** How many clubs one account may own at once (D176). */
  CLUBS_OWNED_MAX: z.coerce.number().int().positive().default(5),
  /**
   * What each plan allows a club (D208), unlimited when unset: how much it may store (its books'
   * files, in GB, fractions allowed) and how many may be in it. A host that lets anyone start a
   * club sets the free ones, so one club cannot fill the disk; Club Pro's are its own.
   */
  CLUB_FREE_STORAGE_GB: z.preprocess(unsetIfEmpty, z.coerce.number().positive().optional()),
  CLUB_PRO_STORAGE_GB: z.preprocess(unsetIfEmpty, z.coerce.number().positive().optional()),
  CLUB_FREE_MEMBERS_MAX: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(2).optional()),
  CLUB_PRO_MEMBERS_MAX: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(2).optional()),
  /**
   * Where a club's owner goes to take Club Pro (D208), e.g. a payment link; the club's id is added
   * as `client_reference_id`, so the payment says which club it is for. Unset: no offer is shown.
   */
  CLUB_PRO_URL: httpAddress,
  /** Anthropic's server-side web search tool, for "any question about anything" (off saves the cost). */
  CAL_WEB_SEARCH: bool.default(true),
  /**
   * Test-only (never set in production): Cal answers through a deterministic fake model
   * (cal/fake-model.ts) instead of calling Anthropic. Lets the E2E suite exercise the real route,
   * the real spoiler gate and real search without an API key.
   */
  CAL_TEST_FAKE_MODEL: bool.default(false),

  /**
   * Voice channels and listening-together (D153): LiveKit, self-hosted. The address a *browser*
   * dials (its own wss, e.g. wss://rtc.books.example.org in production or ws://127.0.0.1:7880 in
   * dev; docs/DEPLOY.md). This server never connects to it itself — it only mints tokens
   * (services/livekit.ts) and, optionally, verifies the webhooks LiveKit posts back
   * (routes/livekit-webhook.ts). All three (URL, key, secret) or none; voice is simply absent
   * from the UI when unset (GET /api/livekit/config says so) rather than failing.
   */
  LIVEKIT_URL: z.preprocess(unsetIfEmpty, z.string().trim().min(1).optional()),
  LIVEKIT_API_KEY: z.preprocess(unsetIfEmpty, z.string().trim().min(1).optional()),
  LIVEKIT_API_SECRET: z.preprocess(unsetIfEmpty, z.string().trim().min(1).optional()),

  /**
   * Push to the iOS app's lock screen and notification centre (D134): a provider JWT (ES256)
   * signed with Apple's .p8 key, sent once per device over APNs' HTTP/2 API. Off when unset (no
   * key id, team id or key means nobody gets a push; the in-app bell still works). The four go
   * together or not at all.
   */
  APNS_KEY_ID: z.preprocess(unsetIfEmpty, z.string().min(1).max(20).optional()),
  APNS_TEAM_ID: z.preprocess(unsetIfEmpty, z.string().min(1).max(20).optional()),
  /** The app's bundle id (e.g. `com.example.bookclub`): APNs refuses a push whose `apns-topic` disagrees. */
  APNS_BUNDLE_ID: z.preprocess(unsetIfEmpty, z.string().min(1).max(200).optional()),
  /** The .p8 key's contents (PEM, `-----BEGIN PRIVATE KEY-----…`), not a path: nothing to mount. */
  APNS_PRIVATE_KEY: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
  /** Apple's sandbox APNs server serves apps not yet in TestFlight or the App Store. */
  APNS_PRODUCTION: bool.default(false),
  /** Tests only: a plaintext stand-in for Apple's APNs host. */
  APNS_AUTHORITY: z.preprocess(unsetIfEmpty, z.string().optional()),

  /**
   * Native "Sign in with Apple" (D178): the app asks for an identity token itself, in process (no
   * round trip through this server to start it, unlike D116's grant — Apple's own native API is
   * the whole "start"). All this needs is who Apple minted the token for: a comma-separated
   * allow-list of `aud` values this server accepts, checked against the token's own `aud` claim.
   * The native app's bundle id (e.g. `com.example.bookclub`) belongs here; a Services ID for a browser-based
   * flow would too, but none is configured in this change (no Apple console changes were made),
   * so the web sign-in page never offers Apple yet (see docs/DECISIONS.md D178). Unset keeps the
   * whole provider off and its button hidden.
   */
  APPLE_AUDIENCES: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),

  /**
   * "Continue with Google" (D178): a server-side OAuth authorization-code flow with PKCE, used by
   * both the browser's sign-in page and, through a WebView-and-browser-session handoff, the iOS
   * app. `GOOGLE_REDIRECT_URI` must be registered with Google exactly — unlike the upstream
   * grant's loopback-name swap (`startAddress` in auth/upstream.ts), nothing here lets a request's
   * own Host header pick where Google is told to send the code: an attacker who could influence
   * that would redirect the authorization code to a host of their choosing. All three together,
   * or none (the provider stays off and its button hidden).
   */
  GOOGLE_CLIENT_ID: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
  GOOGLE_CLIENT_SECRET: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
  GOOGLE_REDIRECT_URI: httpAddress,
  /**
   * Google's own endpoints, real by default; overridable so the demo stack and its E2E suite can
   * point this whole flow at a local stand-in (`tools/fake-google`) instead, over plain HTTP,
   * exactly as the upstream grant's own addresses are always configured rather than hard-coded.
   * `GOOGLE_ISSUERS` is comma-separated (Google's real id_token names its issuer two ways).
   */
  GOOGLE_AUTH_URL: httpAddress,
  GOOGLE_TOKEN_URL: httpAddress,
  GOOGLE_JWKS_URL: httpAddress,
  GOOGLE_ISSUERS: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
}).superRefine((c, issue) => {
  if (c.CAL_SOL_BASE_URL) {
    const url = new URL(c.CAL_SOL_BASE_URL);
    if (url.username || url.password || c.CAL_SOL_BASE_URL.includes('?') || c.CAL_SOL_BASE_URL.includes('#') || url.hostname.replace(/\.$/, '') === 'api.openai.com') {
      issue.addIssue({ code: 'custom', message: 'CAL_SOL_BASE_URL must be a private compatible endpoint without credentials, query or fragment' });
    }
    if (!c.ANTHROPIC_API_KEY || !c.ANTHROPIC_TENANT_ID || !c.ANTHROPIC_BASE_URL || new URL(c.ANTHROPIC_BASE_URL).origin !== url.origin || c.ANTHROPIC_AUTH_MODE !== 'bearer') {
      issue.addIssue({ code: 'custom', message: 'Sol fallback requires the same explicit scoped Mantle origin, bearer credential and tenant as the primary' });
    }
    if (!c.CAL_SOL_INPUT_USD_PER_MILLION || !c.CAL_SOL_OUTPUT_USD_PER_MILLION) issue.addIssue({ code: 'custom', message: 'Sol fallback needs explicit input/output cost estimates for spend accounting' });
    if (c.CAL_WEB_SEARCH) issue.addIssue({ code: 'custom', message: 'Managed web search must be disabled when Sol fallback is enabled' });
  }
  if (c.ANTHROPIC_BASE_URL) {
    const url = new URL(c.ANTHROPIC_BASE_URL);
    if (url.username || url.password || url.search || url.hash) {
      issue.addIssue({ code: 'custom', message: 'ANTHROPIC_BASE_URL must not contain credentials, a query or a fragment' });
    }
  }
  if (c.ANTHROPIC_TENANT_ID && (!c.ANTHROPIC_BASE_URL || new URL(c.ANTHROPIC_BASE_URL).hostname.replace(/\.$/, '') === 'api.anthropic.com')) {
    issue.addIssue({ code: 'custom', message: 'ANTHROPIC_TENANT_ID needs a custom ANTHROPIC_BASE_URL' });
  }
  const livekit = [c.LIVEKIT_URL, c.LIVEKIT_API_KEY, c.LIVEKIT_API_SECRET];
  if (livekit.some(Boolean) && !livekit.every(Boolean)) {
    issue.addIssue({ code: 'custom', message: 'LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are set together, or none of them' });
  }
  // A key vouches for the trusted proxies' forwarded headers; without trusted proxies it would do nothing.
  if (c.TRUST_PROXY_KEY && c.TRUST_PROXY === false) {
    issue.addIssue({ code: 'custom', message: 'TRUST_PROXY_KEY needs TRUST_PROXY: the proxies whose forwarded headers it vouches for' });
  }
  // One without the other would offer a sign-in that cannot finish.
  if (!c.UPSTREAM_START_URL !== !c.UPSTREAM_EXCHANGE_URL) {
    issue.addIssue({ code: 'custom', message: 'UPSTREAM_START_URL and UPSTREAM_EXCHANGE_URL are set together, or neither' });
  }
  // A password check with no upstream configured to redeem its code at would do nothing.
  if (c.UPSTREAM_PASSWORD_URL && !(c.UPSTREAM_START_URL && c.UPSTREAM_EXCHANGE_URL)) {
    issue.addIssue({ code: 'custom', message: 'UPSTREAM_PASSWORD_URL needs UPSTREAM_START_URL and UPSTREAM_EXCHANGE_URL set too' });
  }
  // The upstream's password check is bearer-gated: an address with no secret would only ever get 401s.
  if (!c.UPSTREAM_PASSWORD_URL !== !c.UPSTREAM_PASSWORD_SECRET) {
    issue.addIssue({ code: 'custom', message: 'UPSTREAM_PASSWORD_URL and UPSTREAM_PASSWORD_SECRET are set together, or neither' });
  }
  const apns = [c.APNS_KEY_ID, c.APNS_TEAM_ID, c.APNS_BUNDLE_ID, c.APNS_PRIVATE_KEY];
  if (apns.some(Boolean) && !apns.every(Boolean)) {
    issue.addIssue({ code: 'custom', message: 'APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID and APNS_PRIVATE_KEY are set together, or none set (push stays off)' });
  }
  if (c.APPLE_AUDIENCES !== undefined && c.APPLE_AUDIENCES.split(',').map((s) => s.trim()).filter(Boolean).length === 0) {
    issue.addIssue({ code: 'custom', message: 'APPLE_AUDIENCES must list at least one aud value (comma-separated), or be unset' });
  }
  const google = [c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET, c.GOOGLE_REDIRECT_URI];
  if (google.some(Boolean) && !google.every(Boolean)) {
    issue.addIssue({ code: 'custom', message: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI are set together, or none of them (Google stays off)' });
  }
});

/**
 * The cookie adapter's settings (D52). The upstream stopped sharing its cookie with other hosts, so
 * nothing reads them since D116: one still set would leave "Continue with <name>" switched off
 * without a word, where its owner expects it on.
 */
const RETIRED_UPSTREAM = ['UPSTREAM_JWT_SECRET', 'UPSTREAM_JWT_ISSUER', 'UPSTREAM_JWT_AUDIENCE', 'UPSTREAM_COOKIE', 'UPSTREAM_LOGIN_URL'] as const;

export type Config = z.infer<typeof ConfigSchema> & {
  readonly dataDir: string;
  readonly allowedOrigins: readonly string[];
  readonly upstream: null | {
    readonly startUrl: string;
    readonly exchangeUrl: string;
    /** Set only when UPSTREAM_PASSWORD_URL is: offers a password typed straight into this app's own form. */
    readonly passwordUrl: string | null;
    /** Set together with passwordUrl (superRefine above enforces that): the bearer it requires. */
    readonly passwordSecret: string | null;
    readonly name: string;
  };
  /** Set only when all three LIVEKIT_* variables are (superRefine above enforces that). */
  readonly livekit: null | {
    readonly url: string;
    readonly apiKey: string;
    readonly apiSecret: string;
  };
  readonly apns: null | {
    readonly keyId: string;
    readonly teamId: string;
    readonly bundleId: string;
    readonly privateKey: string;
    readonly production: boolean;
    readonly authority?: string;
  };
  /** Set only when APPLE_AUDIENCES is (superRefine above enforces it is non-empty). D178. */
  readonly apple: null | {
    readonly audiences: readonly string[];
  };
  /** Set only when all three GOOGLE_* variables are (superRefine above enforces that). D178. */
  readonly google: null | {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly authUrl: string;
    readonly tokenUrl: string;
    readonly jwksUrl: string;
    readonly issuers: readonly string[];
  };
};

/** Google's real endpoints, used unless GOOGLE_AUTH_URL/GOOGLE_TOKEN_URL/GOOGLE_JWKS_URL/GOOGLE_ISSUERS override them. */
const GOOGLE_DEFAULTS = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'] as readonly string[],
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const retired = RETIRED_UPSTREAM.filter((name) => env[name]);
  if (retired.length > 0) {
    const names = retired.join(', ');
    throw new Error(
      `${names} ${retired.length === 1 ? 'is' : 'are'} no longer read. The upstream stopped sharing its sign-in cookie with other hosts, and ` +
        `Book Club uses its sign-in grant instead: remove ${names}, and set UPSTREAM_START_URL and UPSTREAM_EXCHANGE_URL (docs/DEPLOY.md, "One identity").`,
    );
  }
  const parsed = ConfigSchema.parse(env);
  return {
    ...parsed,
    dataDir: path.resolve(parsed.DATA_DIR),
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    upstream:
      parsed.UPSTREAM_START_URL && parsed.UPSTREAM_EXCHANGE_URL
        ? {
            startUrl: parsed.UPSTREAM_START_URL,
            exchangeUrl: parsed.UPSTREAM_EXCHANGE_URL,
            passwordUrl: parsed.UPSTREAM_PASSWORD_URL ?? null,
            passwordSecret: parsed.UPSTREAM_PASSWORD_SECRET ?? null,
            name: parsed.UPSTREAM_NAME,
          }
        : null,
    livekit:
      parsed.LIVEKIT_URL && parsed.LIVEKIT_API_KEY && parsed.LIVEKIT_API_SECRET
        ? { url: parsed.LIVEKIT_URL, apiKey: parsed.LIVEKIT_API_KEY, apiSecret: parsed.LIVEKIT_API_SECRET }
        : null,
    apns:
      parsed.APNS_KEY_ID && parsed.APNS_TEAM_ID && parsed.APNS_BUNDLE_ID && parsed.APNS_PRIVATE_KEY
        ? {
            keyId: parsed.APNS_KEY_ID,
            teamId: parsed.APNS_TEAM_ID,
            bundleId: parsed.APNS_BUNDLE_ID,
            // .env files and compose carry a literal "\n", not a real newline: PEM parsing needs the latter.
            privateKey: parsed.APNS_PRIVATE_KEY.replace(/\\n/g, '\n'),
            production: parsed.APNS_PRODUCTION,
            authority: parsed.APNS_AUTHORITY,
          }
        : null,
    apple: parsed.APPLE_AUDIENCES
      ? { audiences: parsed.APPLE_AUDIENCES.split(',').map((s) => s.trim()).filter(Boolean) }
      : null,
    google:
      parsed.GOOGLE_CLIENT_ID && parsed.GOOGLE_CLIENT_SECRET && parsed.GOOGLE_REDIRECT_URI
        ? {
            clientId: parsed.GOOGLE_CLIENT_ID,
            clientSecret: parsed.GOOGLE_CLIENT_SECRET,
            redirectUri: parsed.GOOGLE_REDIRECT_URI,
            authUrl: parsed.GOOGLE_AUTH_URL ?? GOOGLE_DEFAULTS.authUrl,
            tokenUrl: parsed.GOOGLE_TOKEN_URL ?? GOOGLE_DEFAULTS.tokenUrl,
            jwksUrl: parsed.GOOGLE_JWKS_URL ?? GOOGLE_DEFAULTS.jwksUrl,
            issuers: parsed.GOOGLE_ISSUERS ? parsed.GOOGLE_ISSUERS.split(',').map((s) => s.trim()).filter(Boolean) : GOOGLE_DEFAULTS.issuers,
          }
        : null,
  };
}
