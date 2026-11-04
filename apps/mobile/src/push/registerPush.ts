import * as Notifications from 'expo-notifications';
import { SERVER_URL } from '../config';

/**
 * Registers this device's raw APNs token with the server (D134). Not Expo's push service:
 * this is `getDevicePushTokenAsync`, not Expo's push service: the token the server's own APNs
 * client (`apps/server/src/push/apns.ts`) sends to directly. A failure (not signed in yet, or
 * offline) is expected and silent — `App.tsx` retries on its own schedule, not treating this as
 * an error the person needs to see; the in-app bell works regardless of push.
 */
export async function registerPushToken(): Promise<boolean> {
  try {
    const settled = await Notifications.getPermissionsAsync();
    const status = settled.status === 'granted' ? settled.status : (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return false;

    const { data: token } = await Notifications.getDevicePushTokenAsync();
    if (typeof token !== 'string') return false;

    const res = await fetch(new URL('/api/push/register', SERVER_URL).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, platform: 'ios' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
