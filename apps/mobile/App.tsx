import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus, Linking, StyleSheet, View } from 'react-native';
import { pathOfAppLink } from './src/widgets/appLink';
import { configureForegroundPresentation, installPushResponseHandler } from './src/push/deepLink';
import { registerPushToken } from './src/push/registerPush';
import { BookClubWebView, type BookClubWebViewHandle } from './src/webview/BookClubWebView';

/**
 * Book Club for iOS (D130): the native shell around the shared web reader. See
 * `apps/mobile/README.md` for the full picture; `src/webview/BookClubWebView.tsx` is the page
 * itself, `src/audio/NativeAudioEngine.ts` is what makes it a real audiobook player on a lock
 * screen, and `src/push` is what reaches a closed app.
 */
export default function App() {
  const webViewHandle = useRef<BookClubWebViewHandle | null>(null);
  const setHandle = useCallback((h: BookClubWebViewHandle) => {
    webViewHandle.current = h;
  }, []);

  useEffect(() => {
    configureForegroundPresentation();
    const removePushResponseHandler = installPushResponseHandler(() => webViewHandle.current);

    // Registering is cheap and idempotent (the server upserts by token); attempted on launch, on
    // every foreground (covers "just signed in, then backgrounded and returned"), and again a few
    // seconds after the page first loads (covers "just signed in just now").
    void registerPushToken();
    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') void registerPushToken();
    };
    const sub = AppState.addEventListener('change', onAppStateChange);

    // A widget's or the Live Activity's tap (D189): the book page, through the page's own router.
    const openLink = (url: string | null | undefined) => {
      const path = url ? pathOfAppLink(url) : null;
      if (path) setTimeout(() => webViewHandle.current?.open(path), webViewHandle.current ? 0 : 1500);
    };
    void Linking.getInitialURL().then(openLink);
    const links = Linking.addEventListener('url', ({ url }) => openLink(url));

    return () => {
      removePushResponseHandler();
      sub.remove();
      links.remove();
    };
  }, []);

  const onLoadEnd = useCallback(() => {
    void registerPushToken();
  }, []);

  return (
    // Full-bleed, not a SafeAreaView (D135): apps/web's own CSS already insets by
    // `env(safe-area-inset-*)` (`viewport-fit=cover`, `src/styles/base.css`), which only reports
    // the real notch/home-indicator insets when the WebView itself fills the screen. Insetting
    // natively too would just leave a second, redundant margin.
    <View style={styles.root}>
      <StatusBar style="auto" />
      <BookClubWebView handleRef={setHandle} onLoadEnd={onLoadEnd} />
    </View>
  );
}

const styles = StyleSheet.create({
  // The manuscript look's parchment (D137), shown for an instant at the edges before the
  // WebView's own background paints; matches splash so there is no flash of white.
  root: { flex: 1, backgroundColor: '#f4ead2' },
});
