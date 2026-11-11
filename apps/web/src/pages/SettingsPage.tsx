import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { CalendarFeedCard } from '../components/CalendarFeed';
import { Field, FormError, PrivacyLink, fieldErrors } from '../components/Form';
import { useToast } from '../components/Toasts';
import { ApiError, api, isOfflineError } from '../lib/api';
import { wipeDevice } from '../lib/offline';
import { flushOutbox, pendingCount } from '../lib/outbox';
import { liveActivityWanted, setLiveActivityWanted } from '../lib/native-widgets';
import { isNativeApp } from '../player/native-bridge';
import { type AppTheme, useAppTheme } from '../lib/theme';
import { useAudio } from '../player/AudioProvider';
import { ListeningSettingsCard } from '../player/SpeedControl';
import { keys, useClubs, useSession } from '../lib/queries';
import { CreateClubModal } from './HomePage';

export function SettingsPage() {
  const session = useSession();
  const user = session.data?.user;
  const upstreamName = session.data?.upstream?.name ?? 'your main account';
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState(user?.displayName ?? '');
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  const audio = useAudio();
  /** Unsent reading kept a sign-out from going through: offer to sign out anyway. */
  const [unsent, setUnsent] = useState(false);

  const saveName = useMutation({
    mutationFn: () => api.updateMe({ displayName: name }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.session });
      toast.show('Name saved.');
    },
  });
  const changePassword = useMutation({
    mutationFn: () => api.changePassword(passwords),
    onSuccess: () => {
      setPasswords({ currentPassword: '', newPassword: '' });
      toast.show('Password changed. Other devices were signed out.');
    },
  });
  const signOut = useMutation({
    mutationFn: async ({ everywhere, anyway }: { everywhere: boolean; anyway?: boolean }) => {
      // Reading not yet sent goes first: signing out clears this device.
      await flushOutbox();
      if (!anyway && (await pendingCount()) > 0) {
        setUnsent(true);
        throw new Error('Some of your reading has not reached the server yet. Connect to the internet and try again, or sign out anyway.');
      }
      try {
        await (everywhere ? api.signOutEverywhere() : api.signOut());
      } catch (err) {
        // The session can only end on the server; without it the next person here would be you.
        if (isOfflineError(err)) throw new Error('Signing out needs a connection, so that this phone is really signed out. Try again when you are online.', { cause: err });
        if (!(err instanceof ApiError && err.status === 401)) throw err;
      }
      audio.stop();
      await wipeDevice();
    },
    onSuccess: () => {
      qc.clear();
      void navigate('/signin', { replace: true });
    },
  });

  if (!user) return null;
  return (
    <div className="stack-lg settings">
      <h1>Settings</h1>
      <Appearance />
      <ListeningSettingsCard />
      <LiveActivity />
      <YourClubs />
      <section className="card stack" aria-labelledby="history-title">
        <h2 id="history-title">Your reading history</h2>
        <p className="muted small">What you read and listened to, when and for how long, book by book. Only you see it.</p>
        <Link className="btn" to="/history" data-testid="open-all-history">
          Open your history
        </Link>
      </section>
      <CalendarFeedCard />
      <section className="card stack" aria-labelledby="profile-title">
        <h2 id="profile-title">Your name</h2>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            saveName.mutate();
          }}
        >
          <FormError error={saveName.error} />
          {/* Only the upstream grant's own name is kept in sync from elsewhere (D116): Apple and Google
              (D178) hand over a name once, on the very first sign-in, so there is nothing ongoing
              here to fight with, and the field stays editable like a local account's. */}
          <Field label="Name friends see" value={name} onChange={(e) => setName(e.target.value)} disabled={user.source === 'upstream'} hint={user.source === 'upstream' ? `Your name comes from ${upstreamName}.` : undefined} />
          {user.source !== 'upstream' ? (
            <button type="submit" className="btn" disabled={saveName.isPending || name.trim() === user.displayName}>
              Save name
            </button>
          ) : null}
        </form>
        <p className="small faint">Signed in as {user.email ?? user.displayName}.</p>
      </section>

      {user.source === 'local' ? (
        <section className="card stack" aria-labelledby="password-title">
          <h2 id="password-title">Password</h2>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              changePassword.mutate();
            }}
          >
            <FormError error={changePassword.error} />
            <Field
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={passwords.currentPassword}
              onChange={(e) => setPasswords((p) => ({ ...p, currentPassword: e.target.value }))}
              error={fieldErrors(changePassword.error).currentPassword}
            />
            <Field
              label="New password"
              type="password"
              autoComplete="new-password"
              hint="At least 10 characters."
              value={passwords.newPassword}
              onChange={(e) => setPasswords((p) => ({ ...p, newPassword: e.target.value }))}
              error={fieldErrors(changePassword.error).newPassword}
            />
            <button type="submit" className="btn" disabled={changePassword.isPending}>
              Change password
            </button>
          </form>
        </section>
      ) : null}

      <SignInElsewhere />

      <section className="card stack" aria-labelledby="device-title">
        <h2 id="device-title">This device</h2>
        <p className="muted small">Signing out removes books saved for offline reading and everything else Book Club keeps on this device.</p>
        {user.source === 'upstream' ? (
          <p className="muted small">You stay signed in to {upstreamName}; Book Club will not sign you in from it here again until you choose Continue with {upstreamName}.</p>
        ) : null}
        <FormError error={signOut.error} />
        <div className="row">
          <button type="button" className="btn" onClick={() => signOut.mutate({ everywhere: false })} disabled={signOut.isPending} data-testid="sign-out">
            Sign out
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => signOut.mutate({ everywhere: true })} disabled={signOut.isPending}>
            Sign out everywhere
          </button>
          {unsent ? (
            <button type="button" className="btn btn-ghost btn-danger" onClick={() => signOut.mutate({ everywhere: false, anyway: true })} disabled={signOut.isPending}>
              Sign out anyway
            </button>
          ) : null}
        </div>
      </section>

      <section className="card stack" aria-labelledby="privacy-title">
        <h2 id="privacy-title">Your data</h2>
        <p className="muted small">What Book Club keeps, who receives it, how long it is kept, and how to have your account deleted.</p>
        <div className="row">
          <PrivacyLink className="btn btn-ghost" />
        </div>
      </section>
    </div>
  );
}

const THEME_OPTIONS: { value: AppTheme; label: string }[] = [
  { value: 'system', label: 'Match device' },
  { value: 'vellum', label: 'Vellum (light)' },
  { value: 'lucerna', label: 'Lucerna (dark)' },
];

/** Light "vellum" or dark "lucerna" (D118), or follow the device; saved on this device only. */
/**
 * The iOS app's Live Activity (D188): the audiobook playing, on the Lock Screen and in the Dynamic
 * Island, with its chapter, how far through and Play/Pause. Off until turned on (the Lock Screen's
 * Now Playing already has the controls); only in the app, where there is one to show.
 */
function LiveActivity() {
  const [on, setOn] = useState(liveActivityWanted);
  if (!isNativeApp()) return null;
  return (
    <section className="card stack" aria-labelledby="live-activity-title">
      <h2 id="live-activity-title">Live Activity</h2>
      <p className="muted small">While the audiobook plays: the book, its chapter and how far through, with Play and Pause, on the Lock Screen and in the Dynamic Island. The Home Screen widgets show your book and your club’s next stop either way.</p>
      <label className="row">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            setLiveActivityWanted(e.target.checked);
          }}
          data-testid="live-activity"
        />
        <span>Show the audiobook as a Live Activity</span>
      </label>
    </section>
  );
}

function Appearance() {
  const [theme, setTheme] = useAppTheme();
  return (
    <section className="card stack" aria-labelledby="appearance-title">
      <h2 id="appearance-title">Appearance</h2>
      <div className="row" role="radiogroup" aria-labelledby="appearance-title">
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={theme === opt.value}
            className={`btn btn-small${theme === opt.value ? ' btn-primary' : ' btn-ghost'}`}
            onClick={() => setTheme(opt.value)}
            data-testid={`theme-${opt.value}`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * A one-time code to sign in where you are not (D87): in the app on your Home Screen, whose
 * cookies are not the browser's, or on another device.
 */
export function SignInElsewhere() {
  const make = useMutation({ mutationFn: () => api.signInCode() });
  const made = make.data;
  return (
    <section className="card stack" aria-labelledby="elsewhere-title">
      <h2 id="elsewhere-title">Sign in on another device</h2>
      <p className="muted small">For the app on your Home Screen, or another phone or computer: get a code here and type it there, under “Sign in with a code”. It works once, for 10 minutes.</p>
      <FormError error={make.error} />
      {made ? (
        <p className="sign-in-code" role="status">
          <span className="visually-hidden">Your code: </span>
          <span className="sign-in-code-digits" data-testid="sign-in-code">
            {made.code.slice(0, 4)} {made.code.slice(4)}
          </span>
          <span className="faint small">Works until {new Date(made.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</span>
        </p>
      ) : null}
      <div>
        <button type="button" className="btn" onClick={() => make.mutate()} disabled={make.isPending} data-testid="get-sign-in-code">
          {made ? 'Get a new code' : 'Get a code'}
        </button>
      </div>
    </section>
  );
}

/** Every club you are in, and a way to start another (the home page skips this list when there is one). */
function YourClubs() {
  const clubs = useClubs();
  const [creating, setCreating] = useState(false);
  return (
    <section className="card stack" aria-labelledby="clubs-title">
      <h2 id="clubs-title">Your clubs</h2>
      {clubs.data && clubs.data.length > 0 ? (
        <ul className="plain-list">
          {clubs.data.map((c) => (
            <li key={c.id}>
              <Link to={`/clubs/${c.id}`}>{c.name}</Link>
              <span className="muted small">
                {' '}
                · {c.memberCount} {c.memberCount === 1 ? 'reader' : 'readers'}
                {c.role === 'owner' ? ' · you run it' : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <button type="button" className="btn" onClick={() => setCreating(true)} data-testid="new-club">
          Start a new club
        </button>
      </div>
      {creating ? <CreateClubModal onClose={() => setCreating(false)} /> : null}
    </section>
  );
}
