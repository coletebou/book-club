import { randomUUID } from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { type CarCalReply } from '@bookclub/shared';

/** Keep one private, temporary clip only while the audiobook player speaks it. */
export async function playSpokenFile(
  audio: Pick<CarCalReply, 'mimeType' | 'audioBase64'>,
  play: (uri: string) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  if (!FileSystem.cacheDirectory) throw new Error('Audio storage is unavailable');
  const uri = `${FileSystem.cacheDirectory}bookclub-car-${randomUUID()}.${audio.mimeType === 'audio/wav' ? 'wav' : 'mp3'}`;
  try {
    await FileSystem.writeAsStringAsync(uri, audio.audioBase64, { encoding: 'base64' });
    if (!signal.aborted) await play(uri);
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  }
}
