import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { type Block, type PrivacyPolicy, type Rich, POLICY_TEXT_UPDATED, buildPrivacyPolicy } from '../src/services/privacy-policy';
import { type TestApp, closeApp, makeTestApp, rawRequest } from './helpers';

/** A configuration as the server would load it, from nothing but these settings. */
const configOf = (env: Record<string, string> = {}) => loadConfig({ NODE_ENV: 'test', DATA_DIR: path.join(tmpdir(), 'bookclub-privacy-unused'), ...env });

const richText = (rich: Rich) => rich.map((i) => (typeof i === 'string' ? i : 'strong' in i ? i.strong : i.link)).join('');
const blockText = (b: Block): string =>
  b.kind === 'p' ? richText(b.text) : b.kind === 'list' ? b.items.map(richText).join('\n') : b.rows.map((r) => `${r.name} | ${r.receives} | ${r.purpose}`).join('\n');

/** Everything the policy says, as plain text. */
const textOf = (policy: PrivacyPolicy) => [...policy.intro, ...policy.sections.flatMap((s) => s.blocks)].map(blockText).join('\n');
const rowsOf = (policy: PrivacyPolicy) => policy.sections.flatMap((s) => s.blocks).flatMap((b) => (b.kind === 'table' ? b.rows : []));
const sectionText = (policy: PrivacyPolicy, id: string) => policy.sections.find((s) => s.id === id)!.blocks.map(blockText).join('\n');

/** The host's part, as books.badland.ai would set it: an operator, a contact and its own services. */
const HOST_PART = {
  operator: 'Example Reading LLC',
  contact: 'privacy@books.example',
  updated: '2030-01-02',
  where: 'Our server is in the United States.',
  endpoints: { cal: 'Example Cloud (models)', calFallback: 'Example Cloud (backup model)', transcription: 'A GPU server we run' },
  providers: [{ name: 'Example Hosting', receives: 'everything Book Club stores', purpose: 'the server Book Club runs on' }],
  retention: ['Backups are kept for 14 days.'],
};

describe('the privacy policy says what this server does (D225)', () => {
  it('with nothing configured: no operator, no outside service, and nobody to write to but the operator', () => {
    const policy = buildPrivacyPolicy(configOf(), 'https://books.example');
    const text = textOf(policy);
    expect(policy.operator).toBeNull();
    expect(policy.updated).toBe(POLICY_TEXT_UPDATED);
    expect(text).toContain('This Book Club server at books.example (“Book Club”) is run by the person or group who set it up');
    expect(rowsOf(policy)).toEqual([]);
    expect(sectionText(policy, 'providers')).toContain('sends your information to no other company');
    for (const name of ['Anthropic', 'OpenAI', 'ElevenLabs', 'Expo', 'Apple', 'Google', 'iPhone', 'Cal']) expect(text).not.toContain(name);
    expect(sectionText(policy, 'delete')).toContain('ask the person who runs this server');
    expect(sectionText(policy, 'contact')).toContain('Ask the person who invited you');
    // Nothing transcribes voice notes or audiobooks without a recogniser.
    expect(text).not.toContain('transcribed');
  });

  it('names the operator, links its contact and lists the host’s own services, retention and place', () => {
    const policy = buildPrivacyPolicy(configOf({ PRIVACY_POLICY: JSON.stringify(HOST_PART) }), 'https://books.example');
    const text = textOf(policy);
    expect(policy.operator).toBe('Example Reading LLC');
    expect(policy.updated).toBe('2030-01-02');
    expect(text).toContain('Book Club at books.example (“Book Club”, “we”, “us”) is run by Example Reading LLC.');
    expect(rowsOf(policy)).toContainEqual(HOST_PART.providers[0]);
    expect(sectionText(policy, 'keep')).toContain('Backups are kept for 14 days.');
    expect(sectionText(policy, 'keep')).not.toContain('as long as the operator’s setup keeps them');
    expect(sectionText(policy, 'providers')).toContain('Our server is in the United States.');
    const contact = policy.sections.find((s) => s.id === 'contact')!.blocks[0]!;
    expect(contact).toEqual({ kind: 'p', text: ['Example Reading LLC · ', { link: 'privacy@books.example', href: 'mailto:privacy@books.example' }] });
  });

  it('keeps the text’s own date when the host’s is older', () => {
    const policy = buildPrivacyPolicy(configOf({ PRIVACY_POLICY: JSON.stringify({ updated: '2020-01-01' }) }), null);
    expect(policy.updated).toBe(POLICY_TEXT_UPDATED);
  });

  it('says a book’s text goes to the embeddings provider whenever one has a key, even with Cal off', () => {
    // cal/indexer.ts embeds every ready edition once embeddingsProviderFor() answers, Cal or not.
    const policy = buildPrivacyPolicy(configOf({ OPENAI_API_KEY: 'sk-test' }), null);
    expect(rowsOf(policy).map((r) => r.name)).toEqual(['OpenAI']);
    expect(rowsOf(policy)[0]!.receives).toContain('the text of every book uploaded to a club');
    expect(textOf(policy)).not.toContain('Anthropic');
    expect(textOf(policy)).not.toContain('Your conversations with Cal');

    const gemini = buildPrivacyPolicy(configOf({ CAL_EMBEDDING_PROVIDER: 'gemini', GOOGLE_API_KEY: 'g-test' }), null);
    expect(rowsOf(gemini).map((r) => r.name)).toEqual(['Google (Gemini API)']);
    // A provider chosen without its key sends nothing (indexing stays queued).
    expect(rowsOf(buildPrivacyPolicy(configOf({ CAL_EMBEDDING_PROVIDER: 'gemini', OPENAI_API_KEY: 'sk-test' }), null))).toEqual([]);
  });

  it('describes Cal and each provider it uses, from the same choices the server makes', () => {
    const policy = buildPrivacyPolicy(configOf({ ANTHROPIC_API_KEY: 'a-test', OPENAI_API_KEY: 'sk-test', ELEVENLABS_API_KEY: 'el-test' }), null);
    const rows = rowsOf(policy);
    expect(rows.map((r) => r.name)).toEqual(['Anthropic', 'OpenAI', 'ElevenLabs', 'ElevenLabs']);
    expect(rows[0]!.receives).toContain('never past the place you have reached');
    // CAL_WEB_SEARCH defaults on: the search terms reach the model's provider, which runs the search.
    expect(rows[0]!.receives).toContain('the search terms');
    expect(rows[2]!.receives).toContain('the recording of what you say when you talk to Cal');
    expect(rows[3]!.purpose).toBe('reading Cal’s answers aloud');
    const text = textOf(policy);
    expect(text).toContain('Your conversations with Cal');
    expect(text).toContain('Cal’s spoken answers are kept for up to 30 days');
    expect(text).toContain('talk to Cal');

    const quiet = rowsOf(buildPrivacyPolicy(configOf({ ANTHROPIC_API_KEY: 'a-test', CAL_WEB_SEARCH: 'false', CAL_STT_PROVIDER: 'openai', CAL_TTS_PROVIDER: 'openai', CAL_TTS_CACHE_MB: '0' }), null));
    expect(quiet[0]!.receives).not.toContain('search terms');
    // Voice through OpenAI needs OpenAI's key: without it there is no voice, and nothing is said about one.
    expect(quiet.map((r) => r.name)).toEqual(['Anthropic']);
  });

  it('names whoever the host says answers at a custom model gateway, its backup model and a remote recogniser', () => {
    const gateway = {
      ANTHROPIC_API_KEY: 'a-test',
      ANTHROPIC_BASE_URL: 'http://gateway.example.internal/anthropic',
      ANTHROPIC_AUTH_MODE: 'bearer',
      ANTHROPIC_TENANT_ID: 'bookclub',
      CAL_SOL_BASE_URL: 'http://gateway.example.internal/openai',
      CAL_SOL_INPUT_USD_PER_MILLION: '6',
      CAL_SOL_OUTPUT_USD_PER_MILLION: '20',
      CAL_WEB_SEARCH: 'false',
      TRANSCRIBE_COMMAND: 'python transcribe_remote.py python transcribe.py',
      TRANSCRIBE_REMOTE_URL: 'http://host.docker.internal:8790',
    };
    const named = rowsOf(buildPrivacyPolicy(configOf({ ...gateway, PRIVACY_POLICY: JSON.stringify(HOST_PART) }), null));
    expect(named.map((r) => r.name)).toEqual(['Example Cloud (models)', 'Example Cloud (backup model)', 'A GPU server we run', 'Example Hosting']);
    expect(named[2]!.receives).toBe('audiobooks uploaded to a club, and voice notes');

    // Unnamed, the policy still says that something receives it, never that nothing does.
    const unnamed = rowsOf(buildPrivacyPolicy(configOf(gateway), null));
    expect(unnamed.map((r) => r.name)).toEqual([
      'The AI model service this server’s operator has set up',
      'The AI model service this server’s operator has set up',
      'A speech recogniser on another computer, set up by this server’s operator',
    ]);
    // A recogniser on this host itself (no remote) sends audio nowhere.
    const local = buildPrivacyPolicy(configOf({ TRANSCRIBE_COMMAND: 'python transcribe.py' }), null);
    expect(rowsOf(local)).toEqual([]);
    expect(textOf(local)).toContain('Voice notes are transcribed so your club can read them.');
  });

  it('describes each way to sign in that is on, and what it sends', () => {
    const policy = buildPrivacyPolicy(
      configOf({
        UPSTREAM_START_URL: 'https://accounts.example/start',
        UPSTREAM_EXCHANGE_URL: 'https://accounts.example/exchange',
        UPSTREAM_PASSWORD_URL: 'https://accounts.example/password',
        UPSTREAM_PASSWORD_SECRET: 'a-secret-of-sixteen-plus',
        UPSTREAM_NAME: 'Example',
        APPLE_AUDIENCES: 'com.example.bookclub',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_REDIRECT_URI: 'https://books.example/api/auth/google/callback',
      }),
      null,
    );
    const rows = rowsOf(policy);
    expect(rows.map((r) => r.name)).toEqual(['Example', 'Apple', 'Google', 'Expo (EAS Update)']);
    // auth/upstream.ts redeemPassword: the typed email and password, and the person's IP address.
    expect(rows[0]!.receives).toContain('that email address and password and your IP address');
    expect(rows[0]!.receives).toContain('Book Club never stores the password');
    const text = textOf(policy);
    expect(text).toContain('your Example account');
    expect(text).toContain('Sign in with Apple');
    expect(text).toContain('a short-lived one while you sign in with Example or Google');
    expect(text).toContain('unless it comes from your Example account');
    // Apple sign-in means the iPhone app talks to this server: its own section and its update service appear.
    expect(text).toContain('In the iPhone app.');

    const noPassword = rowsOf(buildPrivacyPolicy(configOf({ UPSTREAM_START_URL: 'https://a.example/s', UPSTREAM_EXCHANGE_URL: 'https://a.example/e', UPSTREAM_NAME: 'Example' }), null));
    expect(noPassword[0]!.receives).not.toContain('password');
  });

  it('says what a push carries, and that the iPhone app checks Expo for updates', () => {
    const policy = buildPrivacyPolicy(
      configOf({ APNS_KEY_ID: 'KEY', APNS_TEAM_ID: 'TEAM', APNS_BUNDLE_ID: 'com.example.bookclub', APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----' }),
      null,
    );
    const rows = rowsOf(policy);
    expect(rows.map((r) => r.name)).toEqual(['Apple (Apple Push Notification service)', 'Expo (EAS Update)']);
    // services/push.ts pushPayloadFor: a reply's text, once it has opened for the person it is pushed to.
    expect(rows[0]!.receives).toContain('once you have read far enough to see it, the text they wrote');
    expect(rows[1]!.receives).toContain('a random id for this copy of the app');
    expect(textOf(policy)).toContain('send the notifications you allow');
  });

  it('lists each chat agent, a Club Pro payment page, and LiveKit Cloud but not a self-hosted voice server', () => {
    const agent = { handle: 'scout', name: 'Scout', webhookUrl: 'https://agents.example/hook', webhookSecret: 's'.repeat(32), token: 't'.repeat(32), clubs: '*' };
    const policy = buildPrivacyPolicy(
      configOf({
        CHAT_AGENTS: JSON.stringify([agent]),
        CLUB_PRO_URL: 'https://pay.example/checkout',
        LIVEKIT_URL: 'wss://rtc.books.example',
        LIVEKIT_API_KEY: 'key',
        LIVEKIT_API_SECRET: 'secret',
      }),
      null,
    );
    const rows = rowsOf(policy);
    expect(rows.map((r) => r.name)).toEqual(['Scout', 'pay.example']);
    expect(rows[0]!.receives).toContain('a chat message that mentions @scout');
    expect(rows[1]!.receives).toContain('Book Club receives no payment details');
    expect(textOf(policy)).toContain('connect your device to a voice server (rtc.books.example) while you are in them. Book Club does not record them.');
    expect(textOf(policy)).toContain('join a voice channel');

    const cloud = rowsOf(buildPrivacyPolicy(configOf({ LIVEKIT_URL: 'wss://club-abc.livekit.cloud', LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'secret' }), null));
    expect(cloud.map((r) => r.name)).toEqual(['LiveKit (LiveKit Cloud)']);
  });

  it('says how long a sign-in and an unfinished upload last, from their settings', () => {
    const text = textOf(buildPrivacyPolicy(configOf({ SESSION_DAYS: '30', UPLOAD_EXPIRY_HOURS: '36' }), null));
    expect(text).toContain('A sign-in lasts 30 days');
    expect(text).toContain('An upload that never finishes is deleted after 36 hours');
    expect(textOf(buildPrivacyPolicy(configOf(), null))).toContain('deleted after 7 days');
  });

  it('refuses a PRIVACY_POLICY it cannot vouch for, before the server starts', () => {
    expect(() => configOf({ PRIVACY_POLICY: '{"operator":' })).toThrow();
    expect(() => configOf({ PRIVACY_POLICY: JSON.stringify({ contact: 'javascript:alert(1)' }) })).toThrow(/contact is an email address/);
    expect(() => configOf({ PRIVACY_POLICY: JSON.stringify({ contact: 'http://books.example/contact' }) })).toThrow(/contact is an email address/);
    expect(() => configOf({ PRIVACY_POLICY: JSON.stringify({ updated: '2026-02-30' }) })).toThrow(/YYYY-MM-DD/);
    expect(() => configOf({ PRIVACY_POLICY: JSON.stringify({ operater: 'typo' }) })).toThrow();
    expect(() => configOf({ PRIVACY_POLICY: JSON.stringify({ endpoints: { model: 'x' } }) })).toThrow();
    expect(configOf({ PRIVACY_POLICY: JSON.stringify({ contact: 'https://books.example/help' }) }).PRIVACY_POLICY?.contact).toBe('https://books.example/help');
    expect(configOf({ PRIVACY_POLICY: '' }).PRIVACY_POLICY).toBeUndefined();
  });
});

describe('GET /privacy (D225)', () => {
  let t: TestApp;
  let withWeb: TestApp;
  let web: string;

  beforeAll(async () => {
    t = await makeTestApp({
      PUBLIC_ORIGIN: 'https://books.example',
      SESSION_DAYS: '90',
      PRIVACY_POLICY: JSON.stringify({ ...HOST_PART, operator: 'Example <script>alert(1)</script> & Co' }),
    });
    // With the web app served too: its catch-all must not answer /privacy with the app's shell.
    web = mkdtempSync(path.join(tmpdir(), 'bookclub-privacy-web-'));
    mkdirSync(path.join(web, 'assets'));
    writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>the app shell</title>');
    writeFileSync(path.join(web, 'privacy.css'), 'body { color: black; }');
    withWeb = await makeTestApp({ WEB_DIST: web });
  });

  afterAll(async () => {
    await closeApp(t);
    await closeApp(withWeb);
    rmSync(web, { recursive: true, force: true });
  });

  it('is a whole HTML document anyone can read: no sign-in, no script needed, never cached stale', async () => {
    const res = await t.client().get('/privacy');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toMatch(/^<!doctype html>/);
    expect(res.body).toContain('<h1>Privacy Policy</h1>');
    expect(res.body).toContain('Last updated: <time datetime="2030-01-02">January 2, 2030</time>');
    // The policy itself is in the HTML, not drawn by a script.
    expect(res.body).toContain('<h2 id="collect-title">What we collect</h2>');
    expect(res.body).toContain('A sign-in lasts 90 days');
    expect(res.body).toContain('<a href="mailto:privacy@books.example">privacy@books.example</a>');
    expect(res.body).toContain('<th scope="row" data-label="Recipient">Example Hosting</th>');
    expect(res.body).toContain('<link rel="canonical" href="https://books.example/privacy">');
    expect(res.body).toContain('<link rel="stylesheet" href="/privacy.css">');
    expect(res.body).toContain('Connections to Book Club are encrypted (HTTPS).');
  });

  it('escapes the host’s wording, and sends a CSP that allows only its own script, style and fonts', async () => {
    const res = await t.client().get('/privacy');
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('Example &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
    // The one script tag is the external theme script.
    expect(res.body.match(/<script/g)).toEqual(['<script']);
    expect(res.body).toContain('<script src="/theme-init.js"></script>');
    const csp = res.headers['content-security-policy']!.split('; ');
    expect(csp).toEqual(expect.arrayContaining(["default-src 'none'", "script-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "form-action 'none'"]));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never templates a Host header that is not exactly an origin', async () => {
    const res = await rawRequest(withWeb.baseUrl, 'GET', '/privacy', { Host: 'evil.example"><script>alert(1)</script>' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('evil.example');
    expect(res.body).not.toContain('rel="canonical"');
    expect(res.body).toContain('This Book Club server (“Book Club”) is run by the person or group who set it up');
    expect(res.headers['vary']).toBe('Accept-Encoding, Host');
  });

  it('is the policy, not the web app’s shell, where the web app is served too', async () => {
    const res = await withWeb.client().get('/privacy');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<h1>Privacy Policy</h1>');
    expect(res.body).not.toContain('the app shell');
    // Its stylesheet is the web build's public file, served as any other.
    const css = await withWeb.client().get('/privacy.css');
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('is compressed for a client that asks', async () => {
    const res = await rawRequest(t.baseUrl, 'GET', '/privacy', { 'Accept-Encoding': 'gzip' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });
});
