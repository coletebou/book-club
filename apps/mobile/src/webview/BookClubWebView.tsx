import { useCallback, useEffect, useRef } from 'react';
import { AppState, Linking, StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { type ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { NativeAudioEngine } from '../audio/NativeAudioEngine';
import { readKept, writeKept } from '../audio/keptFile';
import { BookClubNative } from '../../modules/book-club-native';
import { LiveActivityDriver, NativeExtras } from '../widgets/NativeExtras';
import { NativeAuthEngine } from '../auth/NativeAuthEngine';
import { SERVER_HOST, SERVER_URL } from '../config';
import { INJECTED_BOOTSTRAP } from './injected';

// `WebView<P = undefined>`'s declared props are `WebViewProps & P`: left at its default, `P`
// collapses the whole props bag to `never` (intersecting with `undefined`). `object` is a true
// no-op intersection (`WebViewProps & object` is just `WebViewProps`), so this is the type to use
// everywhere a `WebView` instance is referred to in this file, including the JSX tag itself.
type WebViewRef = WebView<object>;

export interface BookClubWebViewHandle {
  /** Navigate the page to a server-relative path (a push notification's target, D134). */
  open(path: string): void;
}

/**
 * The shared reader (D130): the web app, exactly as the browser sees it, with the extra wiring a
 * WebView needs to behave like a native app rather than a browser tab embedded in one.
 */
export function BookClubWebView({ handleRef, onLoadEnd }: { handleRef?: (h: BookClubWebViewHandle) => void; onLoadEnd?: () => void }) {
  const webViewRef = useRef<WebViewRef>(null);
  const engineRef = useRef<NativeAudioEngine | undefined>(undefined);
  if (!engineRef.current) {
    engineRef.current = new NativeAudioEngine(
      (json) => {
        // Double-encoded: `json` is itself a JSON string, embedded here as one JS string literal.
        webViewRef.current?.injectJavaScript(`window.__bookClubReceive && window.__bookClubReceive(${JSON.stringify(json)}); true;`);
      },
      {
        // The place saved while the page sleeps (D182): the same session cookie as the page (D133);
        // and kept on the device, for the page to save when it is opened again (D196).
        progress: { serverUrl: SERVER_URL, fetch: (url, init) => fetch(url, init), now: Date.now, inBackground: () => AppState.currentState !== 'active', keep: writeKept },
        readKept,
        // The Live Activity follows the player, page asleep or not (D189).
        onNowPlaying: (np) => activityRef.current?.update(np),
      },
    );
  }
  // The widgets' data and the Live Activity (D188, D189): a third sibling on the page's channel.
  const activityRef = useRef<LiveActivityDriver | undefined>(undefined);
  const extrasRef = useRef<NativeExtras | undefined>(undefined);
  if (!extrasRef.current) {
    activityRef.current = new LiveActivityDriver(BookClubNative);
    extrasRef.current = new NativeExtras(BookClubNative, activityRef.current);
  }
  useEffect(() => {
    // The Live Activity's Play/Pause, pressed on the Lock Screen or in the Dynamic Island.
    const sub = BookClubNative?.addListener('onTogglePlayback', () => engineRef.current?.toggle());
    return () => sub?.remove();
  }, []);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') engineRef.current?.backgrounded();
    });
    return () => sub.remove();
  }, []);
  // A sibling engine on the same message channel (D178): both share the one `postMessage` stream
  // from the page (`BookClubNative.postMessage`, `injected.ts`), and each ignores whatever is not
  // its own command, the same way `NativeAudioEngine.handle`'s `default` case already does.
  const authEngineRef = useRef<NativeAuthEngine | undefined>(undefined);
  if (!authEngineRef.current) {
    authEngineRef.current = new NativeAuthEngine((json) => {
      webViewRef.current?.injectJavaScript(`window.__bookClubAuthReceive && window.__bookClubAuthReceive(${JSON.stringify(json)}); true;`);
    });
  }

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    engineRef.current?.handle(event.nativeEvent.data);
    authEngineRef.current?.handle(event.nativeEvent.data);
    extrasRef.current?.handle(event.nativeEvent.data);
  }, []);

  const refCallback = useCallback(
    (view: WebViewRef | null) => {
      webViewRef.current = view;
      if (view && handleRef) {
        handleRef({
          open: (path: string) => {
            webViewRef.current?.injectJavaScript(`window.__bookClubNavigate && window.__bookClubNavigate(${JSON.stringify(path)}); true;`);
          },
        });
      }
    },
    [handleRef],
  );

  /**
   * External links open in Safari (D135): a WKAppBoundDomains navigation outside this app's
   * domains would otherwise simply fail ("App-bound domain failure"), and a plain link to, say,
   * Project Gutenberg should leave the app anyway.
   */
  /**
   * iOS ended the page's web process (memory, mostly while the app sat in the background, the
   * audiobook playing on natively): WKWebView then shows nothing until told to load again (D196).
   * Loaded again, the page asks native for the place it kept meanwhile and opens there.
   */
  const onContentProcessDidTerminate = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  const onShouldStartLoad = useCallback((request: ShouldStartLoadRequest): boolean => {
    let host: string;
    try {
      host = new URL(request.url).hostname;
    } catch {
      return true; // not an http(s) URL (data:, about:, blob:): let the WebView decide
    }
    if (host === SERVER_HOST || request.url.startsWith('about:') || request.url.startsWith('blob:') || request.url.startsWith('data:')) return true;
    void Linking.openURL(request.url);
    return false;
  }, []);

  return (
    <WebView<object>
      ref={refCallback}
      source={{ uri: SERVER_URL }}
      style={styles.webview}
      onMessage={onMessage}
      onLoadEnd={onLoadEnd}
      injectedJavaScriptBeforeContentLoaded={INJECTED_BOOTSTRAP}
      // Cookies set signing in inside the WebView land in the system's shared cookie storage
      // (D133): native playback (AVPlayer) and this app's own fetch calls both read it by
      // default, so a track's URL needs no cookie or token of its own.
      sharedCookiesEnabled
      // App-Bound Domains (D135, app.config.ts's withAppBoundDomains): required for the service
      // worker (offline reading) to work reliably in WKWebView.
      limitsNavigationsToAppBoundDomains
      onShouldStartLoadWithRequest={onShouldStartLoad}
      onContentProcessDidTerminate={onContentProcessDidTerminate}
      allowsInlineMediaPlayback
      allowsAirPlayForMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      // getUserMedia / MediaRecorder for voice notes, voice channels and talking to Cal (D136):
      // granted once allowed, for the same host the page is already on, instead of prompting on
      // every call (the camera and microphone usage strings are in app.config.ts's `ios.infoPlist`
      // and the expo-audio plugin's `microphonePermission`).
      mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
      applicationNameForUserAgent="BookClubApp/1.0"
      pullToRefreshEnabled={false}
      decelerationRate="normal"
      allowsBackForwardNavigationGestures={false}
    />
  );
}

const styles = StyleSheet.create({
  webview: { flex: 1 },
});
