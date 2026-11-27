import { execFile } from 'node:child_process';
import { HttpError, badRequest } from '../../lib/errors';

const formats = new Map([
  ['audio/mp4', 'mov'],
  ['audio/webm', 'matroska'],
  ['audio/ogg', 'ogg'],
  ['audio/wav', 'wav'],
]);
const MAX_SECONDS = 30;
const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;

/**
 * D233: give the provider only the decoded first audio stream, with a verified duration. A
 * byte limit alone would still allow a long, highly compressed clip. Feed the decoder through
 * pipes with an explicit demuxer and stop at 31 s so it never needs to decode the whole file.
 */
export async function decodeDictationAudio(audio: Buffer, mimeType: string, signal: AbortSignal): Promise<{ audio: Uint8Array; durationSeconds: number }> {
  const format = formats.get(mimeType);
  if (!format) throw new HttpError(415, 'unsupported_audio', 'Use an MP4, WebM, Ogg or WAV recording.');
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    signal.throwIfAborted();
    const child = execFile(
      'ffmpeg',
      ['-v', 'error', '-protocol_whitelist', 'pipe', '-threads', '1', '-f', format, '-i', 'pipe:0', '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-t', String(MAX_SECONDS + 1), '-f', 's16le', 'pipe:1'],
      { encoding: 'buffer', signal, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: (MAX_SECONDS + 2) * BYTES_PER_SECOND, env: { PATH: process.env.PATH } },
      (error, stdout) => {
        if (signal.aborted) reject(signal.reason);
        else if (error?.code === 'ENOENT') reject(new HttpError(503, 'unavailable', 'Dictation is unavailable on this server.'));
        else if (error || stdout.length === 0) reject(badRequest('That recording could not be read. Try recording again.'));
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', () => {}); // The decoder can exit before it reads the whole clip.
    child.stdin?.end(audio);
  });
  const durationSeconds = pcm.length / BYTES_PER_SECOND;
  if (durationSeconds > MAX_SECONDS) throw badRequest(`Recordings can be up to ${MAX_SECONDS} seconds long.`);

  // A pipe cannot seek back to fill in a WAV header. Write the known PCM length ourselves.
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(BYTES_PER_SECOND, 28);
  wav.writeUInt16LE(2, 32); // bytes per sample frame
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return { audio: wav, durationSeconds };
}
