import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/Icon';
import { NotificationBell, NotificationToasts } from './components/Notifications';
import { Splash } from './components/Splash';
import { ToastProvider } from './components/Toasts';
import { AudioProvider, useAudio } from './player/AudioProvider';
import { CalHost, CalLauncher } from './cal/CalLauncher';
import { MiniPlayer } from './player/MiniPlayer';
import { setPageUser, unauthorizedEvents } from './lib/api';
import { keys, makeQueryClient, useSession } from './lib/queries';
import { useNativeWidgets } from './lib/native-widgets';
import { wipeDevice } from './lib/offline';
import { initRealtime, useRealtimeConnected } from './lib/realtime';
import { useBrowserOnline } from './lib/online';
import { bindOutbox, startOutbox } from './lib/outbox';
import { onFirstControl } from './lib/sw-register';
import { BookPage } from './pages/BookPage';
import { ClubSettingsPage } from './pages/ClubSettingsPage';
import { HistoryPage } from './pages/HistoryPage';
import { HomePage } from './pages/HomePage';
import { JoinPage } from './pages/JoinPage';
import { LandingPage } from './pages/LandingPage';
import { LibraryPage } from './pages/LibraryPage';
import { MessageLinkPage } from './pages/MessageLinkPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ResetPage } from './pages/ResetPage';
import { SettingsPage } from './pages/SettingsPage';
import { SetupPage } from './pages/SetupPage';
import { SignInPage } from './pages/SignInPage';
import { StartPage } from './pages/StartPage';
import { runningInstalled } from './components/InstallHint';

const ReaderPage = lazy(() => import('./reader/ReaderPage'));
const ListenPage = lazy(() => import('./player/ListenPage'));
const ChatPage = lazy(() => import('./live/ChatPage'));
const NextBookPage = lazy(() => import('./pages/NextBookPage').then((m) => ({ default: m.NextBookPage })));

const queryClient = makeQueryClient();
// Once the service worker controls the page, fetch everything again through it, the queries no
// page shows right now included (the club list behind a one-club redirect), so it is all kept for
// opening the app offline.
onFirstControl(() => void queryClient.refetchQueries({ type: 'all' }));

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <AudioProvider>
            <RouteBoundary>
              <Routes>
                <Route path="/signin" element={<SignInPage />} />
                <Route path="/setup" element={<SetupPage />} />
                <Route path="/start" element={<StartPage />} />
                <Route path="/join/:code" element={<JoinPage />} />
                {/* A message from iMessage, for someone without the app (D220). */}
                <Route path="/m" element={<MessageLinkPage />} />
                <Route path="/reset/:token" element={<ResetPage />} />
                <Route element={<RequireAuth />}>
                  <Route element={<Shell />}>
                    <Route index element={<HomePage />} />
                    <Route path="/clubs/:clubId" element={<LibraryPage />} />
                    <Route path="/clubs/:clubId/settings" element={<ClubSettingsPage />} />
                    <Route
                      path="/clubs/:clubId/next-book"
                      element={
                        <Suspense fallback={<Splash label="Opening the picker" />}>
                          <NextBookPage />
                        </Suspense>
                      }
                    />
                    <Route
                      path="/clubs/:clubId/chat"
                      element={
                        <Suspense fallback={<Splash label="Opening chat" />}>
                          <ChatPage />
                        </Suspense>
                      }
                    />
                    <Route path="/books/:bookId" element={<BookPage />} />
                    <Route path="/books/:bookId/history" element={<HistoryPage />} />
                    <Route path="/history" element={<HistoryPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                  </Route>
                  <Route
                    path="/books/:bookId/read"
                    element={
                      <Suspense fallback={<Splash label="Opening the book" />}>
                        <ReaderPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/books/:bookId/listen"
                    element={
                      <Suspense fallback={<Splash label="Opening the audiobook" />}>
                        <ListenPage />
                      </Suspense>
                    }
                  />
                </Route>
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </RouteBoundary>
          </AudioProvider>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

/** An error on one screen stays on that screen: going elsewhere clears it. */
function RouteBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}

const LAST_USER_KEY = 'bookclub:last-user';
/** Whose this tab is: the person it last showed (another tab can change the device's session). */
let tabUser: string | null = null;

function lastUser(): string | null {
  try {
    return localStorage.getItem(LAST_USER_KEY);
  } catch {
    return null;
  }
}

/**
 * Signed-in area: starts realtime and the progress outbox, sends the signed-out to sign in. On a
 * shared phone, whatever the last person left (their player, cached books and answers, unsent
 * reading) is forgotten before anyone else's session starts, and as soon as a session ends
 * elsewhere (expired, signed out on another device, reset) or another tab signs someone else in.
 */
function RequireAuth() {
  const session = useSession();
  const location = useLocation();
  const qc = useQueryClient();
  const audio = useAudio();
  // Inside the iOS app: its widgets kept up with your reading on every signed-in page (D188), and
  // what native kept of you forgotten once the session says nobody is signed in (D220, D221).
  useNativeWidgets(session.isSuccess ? !!session.data?.user : undefined);

  useEffect(() => {
    const onUnauthorized = () => {
      void qc.invalidateQueries({ queryKey: keys.session });
    };
    unauthorizedEvents.addEventListener('unauthorized', onUnauthorized);
    return () => unauthorizedEvents.removeEventListener('unauthorized', onUnauthorized);
  }, [qc]);

  // Another tab signing someone else in, or out, shows here as a new last person on the device.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LAST_USER_KEY && e.newValue !== tabUser) void qc.invalidateQueries({ queryKey: keys.session });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [qc]);

  const known = !session.isPending && !(session.isError && !session.data);
  const userId = session.data?.user?.id ?? null;
  const [forgotten, setForgotten] = useState<string | null>(null);
  // The person this tab showed last, or for a fresh tab the one this device showed last.
  const previous = known ? (tabUser ?? lastUser()) : null;
  const mustForget = known && previous !== null && previous !== userId && forgotten !== previous;
  // From this render on, nothing this page sends or keeps is anyone's until the change is done.
  if (mustForget) setPageUser(null);
  useEffect(() => {
    if (!known) return;
    if (!mustForget) {
      tabUser = userId;
      setPageUser(userId);
      try {
        if (userId) localStorage.setItem(LAST_USER_KEY, userId);
        else localStorage.removeItem(LAST_USER_KEY);
      } catch {
        // ignore
      }
      return;
    }
    const gone = previous;
    // When another tab made the change (it signed the new person in), it has already forgotten
    // the device: only what this tab holds in memory goes.
    const deviceMoved = userId !== null && lastUser() === userId;
    void (async () => {
      try {
        audio.stop();
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
        if (!deviceMoved) await wipeDevice();
      } finally {
        setForgotten(gone);
      }
    })();
  }, [known, mustForget, previous, userId, audio, qc]);

  const signedIn = !!session.data?.user && !mustForget;
  // Created during render, not in an effect: children subscribe in their own effects, which run
  // before this component's effects.
  if (signedIn) {
    initRealtime(qc);
    bindOutbox(qc);
  }
  useEffect(() => {
    if (!signedIn) return;
    const rt = initRealtime(qc);
    rt.start();
    const stopOutbox = startOutbox(qc);
    return () => {
      rt.stop();
      stopOutbox();
    };
  }, [signedIn, qc]);

  if (mustForget) return <Splash label="Opening Book Club" />;
  if (session.isPending) return <Splash label="Opening Book Club" />;
  if (session.data?.setupRequired) return <Navigate to="/setup" replace />;
  if (!session.data?.user) {
    if (session.isError && !session.data) {
      return (
        <div className="center-page">
          <p>Book Club could not be reached.</p>
          <button type="button" className="btn" onClick={() => void session.refetch()}>
            Try again
          </button>
        </div>
      );
    }
    // A stranger at `/` in an ordinary browser sees the landing page (D210), not a sign-in wall —
    // but not inside the installed PWA or the iOS app shell, which are never where someone finds
    // Book Club for the first time: there, straight to sign-in, same as every other page.
    if (location.pathname === '/' && !runningInstalled()) return <LandingPage />;
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/signin${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`} replace />;
  }
  // Signed in, on every page (the reader and the player included): new notifications are said.
  return (
    <>
      <NotificationToasts />
      <Outlet />
      <CalLauncher />
      <CalHost />
    </>
  );
}

function ConnectionDot() {
  const connected = useRealtimeConnected();
  const online = useBrowserOnline();
  if (!online) {
    return (
      <span className="chip" data-testid="offline-chip">
        <Icon name="offline" size={14} /> Offline
      </span>
    );
  }
  return <span className={`live-dot${connected ? ' is-on' : ''}`} role="img" aria-label={connected ? 'Live' : 'Connecting'} data-testid="live-dot" />;
}

function Shell() {
  const session = useSession();
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-bar">
        <NavLink to="/" className="brand" aria-label="Book Club home">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>Book Club</span>
        </NavLink>
        <nav className="app-nav" aria-label="Main">
          <ConnectionDot />
          <NotificationBell />
          <NavLink to="/settings" className="icon-btn" aria-label={`Settings for ${session.data?.user?.displayName ?? 'you'}`}>
            <Icon name="settings" />
          </NavLink>
        </nav>
      </header>
      <main id="main" className="page" tabIndex={-1}>
        <Outlet />
      </main>
      <MiniPlayer />
    </div>
  );
}
