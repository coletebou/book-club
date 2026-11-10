import { type Config } from '../config';
import { embeddingsProviderFor } from '../cal/embeddings';
import { sttProviderFor, ttsProviderFor } from '../cal/voice';
import { calEnabled } from './chat-agents';

/**
 * The privacy policy at /privacy (D225), as words: built from this server's configuration and the
 * host's own part of it (PRIVACY_POLICY), so it says only what this server does. Turning a
 * service on or off here changes what the policy says, and a sentence that names a behaviour
 * names the code behind it in a comment, so the two are changed together.
 *
 * Plain data, not HTML: routes/privacy.ts renders it, escaping every string.
 */

/** When the policy's own wording last changed. Bump it with any change to the text below. */
export const POLICY_TEXT_UPDATED = '2026-11-10';

/** Book Club's public source code, as the landing page links it (apps/web LandingPage.tsx). */
export const SOURCE_URL = 'https://github.com/coletebou/book-club';

export type Inline = string | { readonly strong: string } | { readonly link: string; readonly href: string };
export type Rich = readonly Inline[];

export type Block =
  | { readonly kind: 'p'; readonly text: Rich }
  | { readonly kind: 'list'; readonly items: readonly Rich[] }
  | { readonly kind: 'table'; readonly rows: readonly ProviderRow[] };

/** One row of "AI and other service providers": who, what they receive, and why. */
export interface ProviderRow {
  readonly name: string;
  readonly receives: string;
  readonly purpose: string;
}

export interface PolicySection {
  readonly id: string;
  readonly heading: string;
  readonly blocks: readonly Block[];
}

export interface PrivacyPolicy {
  /** `YYYY-MM-DD`: the text's own date, or the host's PRIVACY_POLICY.updated if later. */
  readonly updated: string;
  readonly operator: string | null;
  readonly intro: readonly Block[];
  readonly sections: readonly PolicySection[];
}

const p = (...text: Inline[]): Block => ({ kind: 'p', text });
const list = (...items: (Rich | false | null | undefined)[]): Block => ({ kind: 'list', items: items.filter((i): i is Rich => Boolean(i)) });

/** `7 days`, `1 day`, `36 hours`: how long, said the way a person would. */
function duration(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  if (hours === 24) return '1 day';
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/** Joins `a`, `a and b`, `a, b and c` (or `or`), leaving out what is not there. */
function joined(word: 'and' | 'or', items: readonly (string | null | false)[]): string {
  const present = items.filter((i): i is string => Boolean(i));
  if (present.length <= 1) return present[0] ?? '';
  return `${present.slice(0, -1).join(', ')} ${word} ${present[present.length - 1]}`;
}
const and = (items: readonly (string | null | false)[]) => joined('and', items);
const or = (items: readonly (string | null | false)[]) => joined('or', items);

function hostOf(url: string): string | null {
  return URL.canParse(url) ? new URL(url).host : null;
}

/** How to reach whoever runs this server, as a link, or words saying who to ask. */
function reach(contact: string | undefined): Inline[] {
  if (!contact) return ['ask the person who runs this server'];
  if (contact.includes('@') && !contact.startsWith('https:')) return ['write to ', { link: contact, href: `mailto:${contact}` }];
  return ['write to us at ', { link: contact, href: contact }];
}

/** What this configuration turns on, read with the same functions the server itself uses. */
function servicesOf(config: Config) {
  const cal = calEnabled(config);
  // A model only leaves this server when there is a key and the test-only fake is off (cal/anthropic.ts).
  const calModel = Boolean(config.ANTHROPIC_API_KEY) && !config.CAL_TEST_FAKE_MODEL;
  // Book text is indexed for Cal whenever an embeddings provider exists (cal/indexer.ts), Cal or not.
  const embeddings = config.CAL_EMBEDDING_PROVIDER !== 'fake' && embeddingsProviderFor(config) ? config.CAL_EMBEDDING_PROVIDER : null;
  const stt = cal && config.CAL_STT_PROVIDER !== 'fake' && sttProviderFor(config) ? config.CAL_STT_PROVIDER : null;
  const tts = cal && config.CAL_TTS_PROVIDER !== 'fake' && ttsProviderFor(config) ? config.CAL_TTS_PROVIDER : null;
  return {
    cal,
    calModel,
    calGateway: calModel && Boolean(config.ANTHROPIC_BASE_URL),
    calFallback: calModel && Boolean(config.CAL_SOL_BASE_URL),
    webSearch: calModel && config.CAL_WEB_SEARCH,
    embeddings,
    stt,
    tts,
    ttsCacheDays: tts && config.CAL_TTS_CACHE_MB > 0 ? config.CAL_TTS_CACHE_DAYS : null,
    // Voice notes and audiobooks share one recogniser (services/note-media.ts, services/readalong.ts).
    transcription: Boolean(config.TRANSCRIBE_COMMAND),
    remoteTranscription: Boolean(config.TRANSCRIBE_COMMAND && config.TRANSCRIBE_REMOTE_URL),
    // The iOS app is wired to this server when it pushes to it or signs people in with Apple.
    iphone: Boolean(config.apns || config.apple),
    // The browser dials LIVEKIT_URL itself (routes/static.ts liveKitConnectSrc); its host names the voice server.
    liveKitHost: config.livekit ? hostOf(config.livekit.url.replace(/^ws/, 'http')) : null,
  };
}

const PROVIDER_NAMES = { openai: 'OpenAI', gemini: 'Google (Gemini API)', elevenlabs: 'ElevenLabs' } as const;

/** The table of everyone who receives something, in the order a reader meets them. */
function providerRows(config: Config, s: ReturnType<typeof servicesOf>): ProviderRow[] {
  const endpoints = config.PRIVACY_POLICY?.endpoints ?? {};
  const rows: ProviderRow[] = [];
  const gatewayLabel = 'The AI model service this server’s operator has set up';

  if (s.calModel) {
    // What cal/anthropic.ts sends: the persona, a line about where the asker is, the conversation,
    // and tool results: search_library/get_passage (spoiler-gated, cal/tools.ts) and
    // whats_my_place (members' names and places, never their notes).
    const search = s.webSearch ? '; and, when Cal searches the web, the search terms (this provider runs the search)' : '';
    rows.push({
      name: s.calGateway ? (endpoints.cal ?? gatewayLabel) : 'Anthropic',
      receives:
        'your messages to Cal and your conversation so far; the place you have reached in the book; passages of your club’s books and Cal’s shelf that Cal looks up, never past the place you have reached; and, when you ask, your club members’ names and how far each has read' +
        search,
      purpose: 'Cal’s answers',
    });
  }
  if (s.calFallback) {
    rows.push({
      name: endpoints.calFallback ?? gatewayLabel,
      receives: 'the same as the row above, only when the main model cannot answer',
      purpose: 'a backup model for Cal',
    });
  }
  if (s.embeddings) {
    rows.push({
      name: PROVIDER_NAMES[s.embeddings],
      receives: 'the text of every book uploaded to a club and of what members add to Cal’s shelf, and the search terms Cal writes from your questions',
      purpose: 'finding the passages Cal needs',
    });
  }
  if (s.stt) {
    rows.push({
      name: PROVIDER_NAMES[s.stt],
      receives: 'the recording of what you say when you talk to Cal (Book Club does not keep it)',
      purpose: 'turning your speech into text for Cal',
    });
  }
  if (s.tts) {
    rows.push({ name: PROVIDER_NAMES[s.tts], receives: 'the text of Cal’s spoken answers', purpose: 'reading Cal’s answers aloud' });
  }
  if (s.remoteTranscription) {
    rows.push({
      name: endpoints.transcription ?? 'A speech recogniser on another computer, set up by this server’s operator',
      receives: 'audiobooks uploaded to a club, and voice notes',
      purpose: 'transcripts, so you can read along and read voice notes',
    });
  }
  if (config.upstream) {
    const name = config.UPSTREAM_NAME;
    // auth/upstream.ts: the exchange answers {id, name, email, emailVerified}; redeemPassword sends
    // the typed email and password, and the person's address for the upstream's own rate limits.
    const password = config.upstream.passwordUrl
      ? `; and, if you type your ${name} password into Book Club’s sign-in form, that email address and password and your IP address, so ${name} can check them (Book Club never stores the password)`
      : '';
    rows.push({
      name,
      receives: `a one-time sign-in code, in return for your ${name} account id, name and verified email address${password}`,
      purpose: `signing in with your ${name} account`,
    });
  }
  if (config.apple) {
    // auth/apple.ts: the server only fetches Apple's public keys to check the token the app got.
    rows.push({
      name: 'Apple',
      receives: 'nothing about you from us: Book Club only fetches Apple’s public keys, to check the sign-in token Apple gives the app',
      purpose: 'Sign in with Apple',
    });
  }
  if (config.google) {
    rows.push({
      name: 'Google',
      receives: 'a one-time sign-in code, in return for your Google account id, name and verified email address',
      purpose: 'Continue with Google',
    });
  }
  if (config.apns) {
    // services/push.ts pushPayloadFor: the club's or book's name as the title; the friend's name and,
    // once it has opened for you, their reply or message as the body.
    rows.push({
      name: 'Apple (Apple Push Notification service)',
      receives: 'your iPhone’s push token, and each notification: a club’s or book’s name, the name of the friend who replied to or mentioned you and, once you have read far enough to see it, the text they wrote',
      purpose: 'notifications on your iPhone',
    });
  }
  if (s.iphone) {
    // apps/mobile app.config.ts: updates.url is EAS Update, checked once at each cold start;
    // expo-updates sends expo-eas-client's random per-install id with each check.
    rows.push({
      name: 'Expo (EAS Update)',
      receives: 'a random id for this copy of the app, your iPhone’s IP address, and the app’s version, when the app checks for a new version of its own code as it starts',
      purpose: 'updating the iPhone app between App Store releases',
    });
  }
  for (const agent of config.CHAT_AGENTS) {
    // services/agent-webhooks.ts: the message naming it, up to 20 before it in the thread with
    // their authors' names, the club's name, the book's title, and links to its pictures for an hour.
    rows.push({
      name: agent.name,
      receives: `a chat message that mentions @${agent.handle}, up to 20 earlier messages in its thread with their authors’ names, the club’s name and book’s title, and links to pictures in them that work for an hour`,
      purpose: `letting ${agent.name} answer in your club’s chat`,
    });
  }
  if (config.CLUB_PRO_URL) {
    const host = hostOf(config.CLUB_PRO_URL) ?? config.CLUB_PRO_URL;
    rows.push({
      name: host,
      receives: 'your club’s id, when its owner goes there to take Club Pro; Book Club receives no payment details',
      purpose: 'paying for Club Pro',
    });
  }
  if (s.liveKitHost && /(^|\.)livekit\.cloud$/i.test(s.liveKitHost.replace(/:\d+$/, ''))) {
    rows.push({ name: 'LiveKit (LiveKit Cloud)', receives: 'your voice and name while you are in a voice channel', purpose: 'voice channels and listening together' });
  }
  for (const provider of config.PRIVACY_POLICY?.providers ?? []) rows.push(provider);
  return rows;
}

export function buildPrivacyPolicy(config: Config, origin: string | null): PrivacyPolicy {
  const host = config.PRIVACY_POLICY;
  const s = servicesOf(config);
  const operator = host?.operator ?? null;
  const we = operator ?? 'the operator';
  const place = origin ? (hostOf(origin) ?? origin) : null;
  const upstreamName = config.upstream ? config.UPSTREAM_NAME : null;
  const updated = host?.updated && host.updated > POLICY_TEXT_UPDATED ? host.updated : POLICY_TEXT_UPDATED;
  const rows = providerRows(config, s);

  const signIns = [
    'a password, which we store only as a one-way hash',
    upstreamName && `your ${upstreamName} account (${upstreamName} tells us its id, your name and your email address, if ${upstreamName} has verified it)`,
    config.apple && 'Sign in with Apple (Apple tells us an account id and, if Apple shares them, your name and email address, or a relay address if you hide yours)',
    config.google && 'Google (Google tells us your Google account id, name and verified email address)',
  ].filter((x): x is string => Boolean(x));

  const intro: Block[] = [
    p(
      operator
        ? `Book Club${place ? ` at ${place}` : ''} (“Book Club”, “we”, “us”) is run by ${operator}. `
        : `This Book Club server${place ? ` at ${place}` : ''} (“Book Club”) is run by the person or group who set it up: its operator (“we”, “us”). `,
      'Book Club is a private reading room for small groups of friends: a club reads or listens to a book together, and a note opens for each friend only when they reach the place it was written from. ',
      `It works in a web browser${s.iphone ? ' and in the Book Club app for iPhone, with its widgets, Messages app and Apple Watch app' : ''}. This policy covers ${s.iphone ? 'all of them' : 'it'}. It explains what we collect, why, who we share it with, how long we keep it, and the choices you have.`,
    ),
    p('Book Club is open-source software, so anyone can read the code that handles your data: ', { link: 'its source code', href: SOURCE_URL }, '.'),
  ];

  const collect: Block = list(
    [{ strong: 'Account information.' }, ` Your name and email address, and how you sign in: ${and(signIns)}. For each sign-in we keep when it started, when it was last used, when it ends, and your browser’s description of itself (its user agent).`],
    [
      { strong: 'Your clubs and what you write.' },
      ' The clubs you belong to and the invitations you make; the notes, highlights, replies and reactions you leave in a book, with the place they were written from; chat messages and the pictures in them; meet-ups (a time, a place you type and who is coming), questions for them, nominations, votes and your settings. A to-read list you import from Goodreads or StoryGraph is read on your device; only the books you choose to nominate are sent to us.',
    ],
    [
      { strong: 'Photos, videos and voice notes.' },
      // services/note-media.ts processPhoto and chat-images.ts re-encode without metadata; the note's
      // original upload is kept; processVideo's ffmpeg run keeps the container's metadata.
      ' Pictures you attach are resized, and the copies your club sees have their metadata, such as where a photo was taken, removed; for a note we also keep the file you uploaded. Videos are converted to a common format and keep the metadata your device recorded in them, which can include where a video was made.',
      s.transcription ? ' Voice notes are transcribed so your club can read them.' : '',
    ],
    [
      { strong: 'Books and files.' },
      ' The EPUB and PDF books, audiobooks and covers you upload to a club',
      s.cal ? ', and the documents or web addresses you give Cal for its shelf (we fetch a web page you give Cal)' : '',
      '.',
      s.transcription ? ' Audiobooks are transcribed so you can read along while you listen.' : '',
    ],
    [
      { strong: 'Reading and listening.' },
      ' Where you are in each book and which parts you have read or heard, so notes open at the right moment and your place follows you between devices; and a history of your reading and listening sittings: when, for how long, which pages or chapters, and a rough device name such as “iPhone”, taken from your browser’s description of itself. Your club sees how far you have read; your history is shown only to you.',
    ],
    s.cal && [
      { strong: 'Cal.' },
      ' Your conversations with Cal, Book Club’s reading companion, are kept so you can come back to them.',
      s.stt ? ' When you talk to Cal, your recording is turned into text by the provider listed below.' : '',
    ],
    config.livekit && [
      { strong: 'Voice channels.' },
      // services/livekit.ts only mints tokens; nothing in Book Club starts a recording (no egress).
      ` Voice channels and listening together connect your device to a voice server${s.liveKitHost ? ` (${s.liveKitHost})` : ''} while you are in them. Book Club does not record them.`,
    ],
    config.apns && [{ strong: 'Notifications.' }, ' If you allow notifications in the iPhone app, we keep your iPhone’s push token so we can send them.'],
    [
      { strong: 'Server logs.' },
      // app.ts requestForLog: method, url through redactUrl, host, request.ip, port.
      ' Our server logs each request it answers: the time, the address asked for (with invite codes and other secrets cut out) and your IP address.',
    ],
    [
      { strong: 'What we do not collect.' },
      ' Book Club has no advertising, analytics or tracking. The website loads nothing from other companies: no ads, analytics, tracking pixels, or outside scripts or fonts.',
      s.iphone ? ' The iPhone app contains no advertising, analytics or crash-reporting code, and does not use the advertising identifier.' : '',
      ` We do not ask for your location, contacts or photo library: you choose each picture you share. The microphone is used only when you ${or(['record a voice note', config.livekit ? 'join a voice channel' : null, s.stt ? 'talk to Cal' : null])}, and the camera only when you take a photo or video for a note. Book Club does not send email.`,
    ],
  );

  const sections: PolicySection[] = [
    { id: 'collect', heading: 'What we collect', blocks: [collect] },
    {
      id: 'use',
      heading: 'How we use it',
      blocks: [
        p(
          'To run Book Club for you and your clubs: to sign you in, show each club its books, notes and conversations at the right moment, keep your place across devices, ',
          config.apns ? 'send the notifications you allow, ' : '',
          s.cal ? 'answer your questions with Cal, ' : '',
          'and keep the service secure, for example by limiting sign-in attempts.',
        ),
        p('We do not sell your personal information, use it for advertising, or use it to track you across other companies’ apps or websites. Book Club does not use what you write or upload to train AI models.'),
      ],
    },
    {
      id: 'see',
      heading: 'Who can see it',
      blocks: [
        list(
          [
            { strong: 'Your club.' },
            ' Its members see its books, its members’ names and how far each has read, and the notes, replies, reactions and chat messages left in it. A note or reply never reaches a member before they have read up to the place it was written from: Book Club checks this on the server, not only on screen. The club’s owner can invite and remove members.',
          ],
          [{ strong: 'The people who run Book Club.' }, ` ${operator ?? 'The operator'} can reach what is stored on the server, to run and look after it.`],
          [{ strong: 'Service providers.' }, rows.length > 0 ? ' The companies and services in the next section, for the reasons given there.' : ' None: as this server is set up, it sends your information to no other company.'],
          [
            { strong: 'People you share with.' },
            ` When you share something outside Book Club, such as an invite link, your club’s meet-up calendar${s.iphone ? ' or a card in Messages' : ''}, whoever you share it with, and the app you share it through, gets what you share.`,
          ],
        ),
      ],
    },
    {
      id: 'providers',
      heading: 'AI and other service providers',
      blocks:
        rows.length > 0
          ? [
              p('These receive information from Book Club so that it can work:'),
              { kind: 'table', rows },
              p('Each of them handles what it receives under its own terms and privacy policy.'),
              ...(host?.where ? [p(host.where)] : []),
            ]
          : [p('As this server is set up, Book Club sends your information to no other company.'), ...(host?.where ? [p(host.where)] : [])],
    },
    {
      id: 'keep',
      heading: 'How long we keep it',
      blocks: [
        list(
          [`Your account, clubs, notes, messages, uploads and reading history${s.cal ? ', and your conversations with Cal,' : ''} stay until they are deleted. You can delete your own notes and chat messages at any time.`],
          [`A sign-in lasts ${config.SESSION_DAYS} days unless you sign out. Sign out ends it at once; Sign out everywhere ends all of them.`],
          // routes/imports.ts cleanUpUploads; services/note-media-cleanup.ts and chat-images.ts (an hour).
          [`An upload that never finishes is deleted after ${duration(config.UPLOAD_EXPIRY_HOURS)}, and a picture or recording you attach but never post after an hour.`],
          ['If you leave a club, or its owner removes you, what you wrote there stays in the club.'],
          // services/removal.ts: soft delete, `bookclub undelete`, `bookclub purge`.
          ['A book removed from a club, or a club its owner disbands, is hidden at once and kept until the operator erases it for good, so that a mistake can be undone.'],
          s.ttsCacheDays !== null && [`Cal’s spoken answers are kept for up to ${s.ttsCacheDays} days, so the same answer is not made twice.`],
          ...(host?.retention?.length
            ? host.retention.map((r): Rich => [r])
            : [['Server logs and backups are kept as long as the operator’s setup keeps them. Deleted data can stay in a backup until that backup is deleted.'] as Rich]),
        ),
      ],
    },
    {
      id: 'delete',
      heading: 'Deleting your account',
      blocks: [
        p('Book Club does not yet have a button to delete your account. To have it deleted, ', ...reach(host?.contact), ', and ', operator ? 'we' : 'the operator', ' will delete it. You can sign out everywhere, leave a club, and delete your own notes and chat messages yourself at any time.'),
      ],
    },
    {
      id: 'device',
      heading: 'On your device',
      blocks: [
        list(
          [
            { strong: 'In your browser.' },
            // apps/web lib/offline.ts wipeDevice; auth/plugin.ts bc_session; upstream.ts bc_upstream; google.ts bc_google.
            ` Book Club keeps your preferences, reading progress and drafts not sent yet, and any books you save for offline reading. It uses one cookie, to keep you signed in${upstreamName || config.google ? `, and a short-lived one while you sign in with ${or([upstreamName, config.google ? 'Google' : null])}` : ''}. Signing out removes all of it from that browser.`,
          ],
          s.iphone && [
            { strong: 'In the iPhone app.' },
            // apps/mobile SharedSession.swift (Keychain, App Group), NowPlayingController.swift (widget snapshot, covers), NativeAudioEngine.ts (bookclub-audio/).
            ' The app keeps you signed in with the same cookie, and keeps a copy of it in the iOS Keychain so its Messages app can show your clubs. For its widgets, the lock screen and the Apple Watch app it keeps a short summary of your books (titles, covers, progress), and it downloads audiobook files to play them offline. Signing out removes the summary and the Keychain copy.',
          ],
        ),
      ],
    },
    {
      id: 'choices',
      heading: 'Your choices and rights',
      blocks: [
        list(
          [`You can change your name${upstreamName ? ` (unless it comes from your ${upstreamName} account)` : ''} and your password in Settings, sign out everywhere, leave a club, and delete your own notes and messages.`],
          [`Device permissions (microphone, camera${config.apns ? ', notifications' : ''}) can be changed at any time in your browser’s${s.iphone ? ' or iPhone’s' : ''} settings.`],
          [
            { strong: 'Access, correction, export or deletion:' },
            ' ',
            ...reach(host?.contact),
            '. Depending on where you live, you may have more rights under local law (for example in the EEA, the UK or California), and we will honor them. We do not sell or share personal information for cross-context behavioral advertising.',
          ],
        ),
      ],
    },
    {
      id: 'children',
      heading: 'Children',
      blocks: [p('Book Club is not directed at children under 13, and we do not knowingly collect information from them. If you believe a child under 13 has given us information, ', ...reach(host?.contact), ' and we will delete it.')],
    },
    {
      id: 'security',
      heading: 'Security',
      blocks: [
        p(
          origin?.startsWith('https:') ? 'Connections to Book Club are encrypted (HTTPS). ' : '',
          // lib/crypto.ts scrypt; repos/sessions.ts id_hash; routes/media.ts membership checks, `private` cache headers.
          'Passwords are stored only as one-way hashes, and sign-ins only as hashes of their tokens. Books, files and pictures are sent only to members of their club, and never to shared caches. No system is perfectly secure; we will tell you if a breach affects your information, as the law requires.',
        ),
      ],
    },
    { id: 'changes', heading: 'Changes', blocks: [p('We will post any change here and update the date above.')] },
    {
      id: 'contact',
      heading: 'Contact',
      blocks: [
        host?.contact
          ? p(`${we.charAt(0).toUpperCase()}${we.slice(1)} · `, reach(host.contact)[1]!)
          : p(operator ? `${operator}. ` : '', 'Ask the person who invited you, or whoever runs this server.'),
      ],
    },
  ];

  return { updated, operator, intro, sections };
}
