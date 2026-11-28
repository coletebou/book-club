import { randomUUID } from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { type CarCalReply } from '@bookclub/shared';

const CLIP_NAME = /^bookclub-car-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:mp3|wav)$/i;
const active = new Set<string>();

/** Clear clips left behind if the process ended before its playback cleanup. */
export async function sweepSpokenFiles(): Promise<void> {
  const directory = FileSystem.cacheDirectory;
  if (!directory) return;
  const files = await FileSystem.readDirectoryAsync(directory).catch(() => []);
  await Promise.all(files.filter((name) => CLIP_NAME.test(name) && !active.has(name))
    .map((name) => FileSystem.deleteAsync(`${directory}${name}`, { idempotent: true }).catch(() => undefined)));
}

/** Keep one private, temporary clip only while the audiobook player speaks it. */
export async function playSpokenFile(
  audio: Pick<CarCalReply, 'mimeType' | 'audioBase64'>,
  play: (uri: string) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  if (!FileSystem.cacheDirectory) throw new Error('Audio storage is unavailable');
  const name = `bookclub-car-${randomUUID()}.${audio.mimeType === 'audio/wav' ? 'wav' : 'mp3'}`;
  const uri = `${FileSystem.cacheDirectory}${name}`;
  active.add(name);
  try {
    await FileSystem.writeAsStringAsync(uri, audio.audioBase64, { encoding: 'base64' });
    if (!signal.aborted) await play(uri);
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    active.delete(name);
  }
}
