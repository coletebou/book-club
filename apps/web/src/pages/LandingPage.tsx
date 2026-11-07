import { useState } from 'react';
import { Link } from 'react-router';
import { Icon, type IconName } from '../components/Icon';
import { useSession } from '../lib/queries';
import { JoinByLinkModal } from './HomePage';

const REPO_URL = 'https://github.com/coletebou/book-club';

interface Feature {
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
}

const FEATURES: readonly Feature[] = [
  { icon: 'book', title: 'One timeline, every format', body: 'Read the EPUB, read the PDF, or listen to the audiobook: everyone in the club meets on the same page, whichever one is actually theirs.' },
  { icon: 'lock', title: 'Spoiler-free by construction', body: 'The server, not the screen, decides what you may see. A friend who reads faster can never spoil the book for you, on any page, in chat, or in search.' },
  { icon: 'along', title: 'Reading along', body: 'An audiobook lined up with its text, sentence by sentence: the page turns itself as the narrator reads.' },
  { icon: 'users', title: 'Presence and the club bar', body: 'See where your friends are, live, without seeing what they said about it until you get there yourself.' },
  { icon: 'comment', title: 'Club chat and listening together', body: 'A chat for the club, voice channels, and a shared "listening party" that keeps everyone’s audiobook in sync.' },
  { icon: 'sparkle', title: 'Cal, the club’s AI librarian', body: 'Optional, off until you add a key: ask about the books your club has, and never get spoiled past your place.' },
];

const STEPS: readonly { readonly n: number; readonly title: string; readonly body: string }[] = [
  { n: 1, title: 'Start a club', body: 'Your name, email and a password, and a name for the club. No one else needs to be ready yet.' },
  { n: 2, title: 'Share the invite link', body: 'One link brings a friend straight in — no account to make somewhere else first.' },
  { n: 3, title: 'Read at your own pace', body: 'Drop in a book, open it on your phone, and read or listen whenever you have a moment. Everyone else’s pace is their own.' },
];

/**
 * The marketing page for a signed-out visitor at `/` (D210). Never shown inside the installed PWA
 * or the iOS app shell (App.tsx's RequireAuth keeps those on `/signin` instead, same as always) —
 * this is for a stranger who found the address in a browser and has never heard of Book Club.
 * `openSignup` (GET /api/session, D211) decides whether "Start a club" is a real door or a
 * explanation that this instance keeps it invite-only.
 */
export function LandingPage() {
  const session = useSession();
  const [joining, setJoining] = useState(false);
  const openSignup = session.data?.openSignup === true;
  return (
    <div className="landing">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="landing-bar">
        <span className="brand landing-brand" aria-hidden="true">
          <img src="/favicon.svg" alt="" width={26} height={26} />
          <span>Book Club</span>
        </span>
        <Link className="btn btn-ghost btn-small" to="/signin">
          Sign in
        </Link>
      </header>
      <main id="main" tabIndex={-1}>
        <section className="landing-hero stack-lg" aria-labelledby="landing-title">
          <div className="stack">
            <h1 id="landing-title">Read together. Never spoiled.</h1>
            <p className="landing-lede">
              A small, private reading room for a handful of friends: one timeline for the EPUB, the PDF and the audiobook, where everyone
              can see how far along their friends are without ever seeing what happens next.
            </p>
          </div>
          <LandingCtas openSignup={openSignup} onJoin={() => setJoining(true)} primaryId="landing-start" />
          <LandingShot
            src="/landing/reader.png"
            alt="A page of a novel with a thin bar above it marking three friends' places, a note from one of them in the margin, and a small gold dot showing where a reaction waits further ahead"
          />
        </section>

        <section className="landing-features" aria-labelledby="features-title">
          <h2 id="features-title" className="section-title">
            What it is
          </h2>
          <ul className="landing-feature-grid">
            {FEATURES.map((f) => (
              <li key={f.title} className="card landing-feature">
                <Icon name={f.icon} size={26} />
                <h3>{f.title}</h3>
                <p className="muted small">{f.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing-steps" aria-labelledby="steps-title">
          <h2 id="steps-title" className="section-title">
            How it works
          </h2>
          <ol className="landing-step-list">
            {STEPS.map((s) => (
              <li key={s.n} className="landing-step">
                <span className="landing-step-n" aria-hidden="true">
                  {s.n}
                </span>
                <h3>{s.title}</h3>
                <p className="muted small">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <LandingShot
          src="/landing/club.png"
          alt="A club's page: four friends' avatars marked online, a book's cover with a gold progress line under it, and an unread chat badge"
          caption="Your clubs, who is online, and what is new — at a glance."
        />

        {/*
         * No pricing section: Book Club has no plans or prices to show yet (that is still
         * undecided). If one is added later, it belongs here, between how this works and the
         * open-source note below, as its own <section aria-labelledby="pricing-title">.
         */}

        <section className="landing-oss" aria-labelledby="oss-title">
          <h2 id="oss-title" className="section-title">
            Open source. Host your own.
          </h2>
          <p className="muted">
            Book Club is free software: read it, change it, run it for your own friends on your own small server. Licensed under the{' '}
            <a href="https://www.gnu.org/licenses/agpl-3.0.html">GNU AGPL v3</a>.
          </p>
          <a className="btn" href={REPO_URL}>
            View the source on GitHub
          </a>
        </section>

        <section className="landing-foot stack" aria-labelledby="landing-foot-title">
          <h2 id="landing-foot-title" className="section-title">
            Ready to read together?
          </h2>
          <LandingCtas openSignup={openSignup} onJoin={() => setJoining(true)} />
        </section>
      </main>
      {joining ? <JoinByLinkModal onClose={() => setJoining(false)} /> : null}
    </div>
  );
}

function LandingShot({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  return (
    <figure className="landing-shot">
      <img src={src} alt={alt} width={390} height={680} loading="lazy" decoding="async" />
      {caption ? <figcaption className="muted small">{caption}</figcaption> : null}
    </figure>
  );
}

/**
 * The three ways in, every time this page offers them: "Start a club" is a real door only when
 * this instance turned OPEN_SIGNUP on (D211); otherwise it explains that and offers the other two,
 * the same as `/start` does on its own when opened directly.
 */
function LandingCtas({ openSignup, onJoin, primaryId }: { openSignup: boolean; onJoin: () => void; primaryId?: string }) {
  return (
    <div className="stack">
      <div className="row landing-cta-row">
        {/* /start itself explains the same thing again when OPEN_SIGNUP is off, for anyone who
            opens that address directly rather than reading this page first. */}
        <Link id={primaryId} className="btn btn-primary" to="/start">
          Start a club
        </Link>
        <Link className="btn btn-ghost" to="/signin">
          Sign in
        </Link>
        <button type="button" className="btn btn-ghost" onClick={onJoin}>
          Join with a link
        </button>
      </div>
      {!openSignup ? <p className="muted small">This instance is invite-only right now — ask a friend for a link, or sign in if you already have an account.</p> : null}
    </div>
  );
}
