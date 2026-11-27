import * as FileSystem from 'expo-file-system/legacy';

/**
 * Where native keeps the place it heard on the device (D196, `BackgroundProgress`'s `keep`): one
 * small JSON file in the app's documents, written every few seconds while a book plays, at a pause,
 * at a track's end and as the app goes to the background, and read once as the app starts. iOS runs
 * no code when it ends an app in the background or the person swipes it away; this file is what is
 * left, and the page, opened again, asks for it (`tellKept`) and saves it as its own.
 */
const FILE = `${FileSystem.documentDirectory ?? ''}bookclub-kept-place.json`;
let pending: Promise<void> = Promise.resolve();

export function writeKept(json: string): Promise<void> {
  pending = pending.catch(() => undefined).then(() => FileSystem.writeAsStringAsync(FILE, json));
  return pending;
}

export function clearKept(): Promise<void> {
  pending = pending.catch(() => undefined).then(() => FileSystem.deleteAsync(FILE, { idempotent: true }));
  return pending;
}

export function readKept(): Promise<string | null> {
  return FileSystem.getInfoAsync(FILE).then((info) => (info.exists ? FileSystem.readAsStringAsync(FILE) : null));
}
