import Constants from 'expo-constants';

/** The server this build points at (app.config.ts `extra.serverUrl`, from `BOOKCLUB_SERVER_URL`). */
export const SERVER_URL: string = (Constants.expoConfig?.extra?.serverUrl as string | undefined) ?? 'https://books.badland.ai';

export const SERVER_HOST: string = new URL(SERVER_URL).hostname;

/** The app's own bundle id, for the push route's `apns-topic` on the server side to agree with. */
export const BUNDLE_ID: string = Constants.expoConfig?.ios?.bundleIdentifier ?? 'ai.badland.books';
