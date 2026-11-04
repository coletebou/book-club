import * as Notifications from 'expo-notifications';
import { type BookClubWebViewHandle } from '../webview/BookClubWebView';

/**
 * A tapped push opens the right place (D134): the payload's `path`
 * (`/books/<id>#note-<id>`, `apps/server/src/services/push.ts`) goes to the WebView's own
 * client-side router (`BookClubWebView.open`, `window.__bookClubNavigate` in native-bridge.ts),
 * the same place a tap on the web app's bell would go. Apple delivers every top-level key of the
 * raw APNs payload — `path` among them — as `request.content.data` on iOS.
 */
export function installPushResponseHandler(getHandle: () => BookClubWebViewHandle | null): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const path = response.notification.request.content.data?.path;
    if (typeof path === 'string') getHandle()?.open(path);
  });
  return () => sub.remove();
}

/** Foreground notifications still show a banner: the bell already lives inside the WebView. */
export function configureForegroundPresentation(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}
