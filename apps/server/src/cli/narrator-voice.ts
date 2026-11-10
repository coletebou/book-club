import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseFile } from 'music-metadata';
import { type AppContext } from '../context';
import { bookById, editionFiles, editionsForBook } from '../repos/books';
import { ElevenLabsVoiceDesign, type DesignedPreview } from '../cal/voice/elevenlabs';
import {
  NarratorSettingsSchema,
  type NarratorSettings,
  type NarratorVoiceRow,
  deleteNarratorVoice,
  matchedSpeed,
  narratorVoiceRow,
  narratorVoiceRows,
  paceOf,
  resolveNarratorVoice,
  saveNarratorVoice,
  settingsOf,
  transcriptTracksFor,
} from '../cal/voice/narrator';
import { medianPitch, semitonesApart } from '../cal/voice/pitch';
import { ttsProviderFor } from '../cal/voice';
import { replyVoiceFor } from '../cal/voice/pipeline';

/*
 * bookclub narrator-voice: the voice Cal answers a book's listeners in (D223).
 *
 *   narrator-voice show [--book ID]
 *   narrator-voice design --book ID --description TEXT [--narrator NAME] [--pick N|auto] [--rounds N] [--out DIR] [settings]
 *       (b) make a voice with ElevenLabs Voice Design from a description of the narrator (never
 *       from their recording), pick the preview nearest the narration's pitch, keep it, and set
 *       its speed so it keeps the narrator's measured pace
 *   narrator-voice set --book ID [--narration-voice-id ID] [--clone-voice-id ID --consent TEXT] [--clear-clone] [--narrator NAME] [settings]
 *       (a) the voice the narration was generated with; (c) a consented clone; or settings alone
 *   narrator-voice say --book ID --text TEXT [--out FILE]   speak as Cal would, through the same provider and cache
 *   narrator-voice remove --book ID                          back to Cal's own voice
 *
 * settings: --stability 0-1 --similarity 0-1 --style 0-1 --speed 0.7-1.2 --model MODEL_ID --seed N
 */

/** What the previews read: Cal stepping out of a story to answer, the very thing the voice is for. */
export const PREVIEW_TEXT =
  "That's a good question, and a fair place to stop and ask it. Let me step out of the story for a moment. " +
  'What you have heard so far is all I will lean on, so nothing ahead is spoiled. The answer is simpler than it seems, ' +
  'and once you hear it, the next chapter will make a little more sense. Shall we go back to the reading?';

/** A preview this near the narration's pitch is near enough: no further round of design is asked for. */
export const CLOSE_SEMITONES = 2;
/** Rounds of design (three previews each) `--pick auto` may ask for before keeping the nearest so far. */
export const DESIGN_ROUNDS = 3;

/** The narration measured for its pitch: a minute, from the middle of the book (past the opening credits). */
const PITCH_SAMPLE_S = 60;
const PCM_RATE = 16_000;

type Out = (line: string) => void;

export async function narratorVoiceCommand(ctx: AppContext, argv: readonly string[], out: Out = console.log): Promise<number> {
  const [sub, ...rest] = argv;
  const { values } = parseArgs({
    args: [...rest],
    options: {
      book: { type: 'string' },
      description: { type: 'string' },
      narrator: { type: 'string' },
      pick: { type: 'string' },
      rounds: { type: 'string' },
      out: { type: 'string' },
      text: { type: 'string' },
      'narration-voice-id': { type: 'string' },
      'clone-voice-id': { type: 'string' },
      consent: { type: 'string' },
      'clear-clone': { type: 'boolean' },
      stability: { type: 'string' },
      similarity: { type: 'string' },
      style: { type: 'string' },
      speed: { type: 'string' },
      model: { type: 'string' },
      seed: { type: 'string' },
    },
  });
  const settings = settingsFromFlags(values);
  switch (sub) {
    case 'show': {
      const rows = values.book ? [narratorVoiceRow(ctx.db, values.book)].filter((r): r is NarratorVoiceRow => !!r) : narratorVoiceRows(ctx.db);
      if (!rows.length) out(values.book ? `book ${values.book}: Cal's own voice (no narrator voice)` : 'no narrator voices');
      for (const row of rows) out(describeRow(ctx, row));
      return 0;
    }
    case 'design': {
      const bookId = requireBook(ctx, values.book);
      if (!values.description) throw new Error('design needs --description (what the narrator sounds like: gender, age, accent, pace, timbre)');
      const apiKey = ctx.config.ELEVENLABS_API_KEY;
      if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
      const report = await designNarratorVoice(ctx, {
        bookId,
        description: values.description,
        narrator: values.narrator,
        pick: values.pick === undefined || values.pick === 'auto' ? 'auto' : Number(values.pick),
        rounds: values.rounds !== undefined ? Number(values.rounds) : undefined,
        outDir: values.out,
        settings,
        design: new ElevenLabsVoiceDesign(apiKey),
      });
      for (const line of report) out(line);
      return 0;
    }
    case 'set': {
      const bookId = requireBook(ctx, values.book);
      if (values['clone-voice-id'] && !values.consent) throw new Error('--clone-voice-id needs --consent: who agreed to their voice being cloned, when and how');
      if (values['clone-voice-id'] && values['clear-clone']) throw new Error('--clone-voice-id and --clear-clone together say two things');
      const row = saveNarratorVoice(ctx.db, bookId, {
        narrator: values.narrator,
        narrationVoiceId: values['narration-voice-id'],
        clone: values['clone-voice-id'] ? { voiceId: values['clone-voice-id'], consent: values.consent! } : values['clear-clone'] ? null : undefined,
        settings,
      });
      out(describeRow(ctx, row));
      return 0;
    }
    case 'say': {
      const bookId = requireBook(ctx, values.book);
      if (!values.text) throw new Error('say needs --text');
      const tts = ttsProviderFor(ctx.config);
      if (!tts) throw new Error('text-to-speech is not configured on this server');
      const voice = replyVoiceFor(ctx, tts, bookId);
      let cached = false;
      const parts: Uint8Array[] = [];
      for await (const chunk of tts.speak(values.text, { signal: new AbortController().signal, voice, onCacheHit: () => (cached = true) })) parts.push(chunk);
      const file = values.out ?? `narrator-${bookId}.mp3`;
      await writeFile(file, Buffer.concat(parts));
      out(`${file}: ${voice.kind === 'narrator' ? `${voice.narrator || 'the narrator'}'s voice (${voice.source}, ${voice.voiceId}, speed ${voice.settings.speed})` : "Cal's own voice"}${cached ? ', from the cache' : ''}`);
      return 0;
    }
    case 'remove': {
      const bookId = requireBook(ctx, values.book);
      out(deleteNarratorVoice(ctx.db, bookId) ? `book ${bookId}: back to Cal's own voice (any voice in the ElevenLabs account is kept)` : `book ${bookId} had no narrator voice`);
      return 0;
    }
    default:
      console.error('usage: bookclub narrator-voice <show|design|set|say|remove> [--book ID] [options]');
      return 2;
  }
}

function requireBook(ctx: AppContext, bookId: string | undefined): string {
  if (!bookId) throw new Error('needs --book ID');
  if (!bookById(ctx.db, bookId)) throw new Error(`no book ${bookId}`);
  return bookId;
}

function settingsFromFlags(values: Record<string, string | boolean | undefined>): NarratorSettings | undefined {
  const num = (k: string) => (typeof values[k] === 'string' ? Number(values[k]) : undefined);
  const raw = { stability: num('stability'), similarityBoost: num('similarity'), style: num('style'), speed: num('speed'), modelId: values.model as string | undefined, seed: num('seed') };
  const given = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  if (Object.keys(given).length === 0) return undefined;
  const parsed = NarratorSettingsSchema.safeParse(given);
  if (!parsed.success) throw new Error(`settings: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return parsed.data;
}

function describeRow(ctx: AppContext, row: NarratorVoiceRow): string {
  const book = bookById(ctx.db, row.book_id);
  const voice = resolveNarratorVoice(row);
  const s = settingsOf(row);
  const measured = [row.narrator_wpm ? `${Math.round(row.narrator_wpm)} wpm` : null, row.narrator_f0_hz ? `${Math.round(row.narrator_f0_hz)} Hz` : null].filter(Boolean).join(', ');
  return [
    `${row.book_id}\t${book?.title ?? '?'}\tnarrator: ${row.narrator || '?'}${measured ? ` (${measured})` : ''}`,
    `  speaking: ${voice ? `${voice.source} ${voice.voiceId}` : "Cal's own voice"}`,
    `  (a) narration: ${row.narration_voice_id ?? '-'}   (c) clone: ${row.clone_voice_id ? `${row.clone_voice_id} (consent: ${row.clone_consent})` : '-'}   (b) designed: ${row.designed_voice_id ?? '-'}`,
    `  settings: stability ${s.stability}, similarity ${s.similarityBoost}, style ${s.style}, speed ${s.speed}, model ${s.modelId}, seed ${s.seed}`,
    row.design_description ? `  description: ${row.design_description}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The narrator named in the audiobook's own tags: the composer field, where audiobook publishers put the reader. */
export async function narratorFromTags(ctx: AppContext, bookId: string): Promise<string | null> {
  for (const edition of editionsForBook(ctx.db, bookId).filter((e) => e.kind === 'audio' && e.status === 'ready')) {
    const first = editionFiles(ctx.db, edition.id)[0];
    if (!first) continue;
    const meta = await parseFile(ctx.storage.blobPath(first.blob_id), { duration: false, skipCovers: true }).catch(() => null);
    const composer = meta?.common.composer?.find((c) => c.trim());
    if (composer) return composer.trim().slice(0, 200);
  }
  return null;
}

/** Mono 16 kHz PCM of `seconds` of audio from `startS`, by ffmpeg, from a file or bytes (piped in). Nothing leaves this machine. */
export function decodePcm(input: { file: string } | { bytes: Uint8Array }, startS: number, seconds: number): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-ss', String(startS), '-t', String(seconds), '-i', 'file' in input ? input.file : 'pipe:0', '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', 'pipe:1'];
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(-2000)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg could not decode the audio: ${stderr.trim().split('\n').pop() ?? code}`));
      const buf = Buffer.concat(chunks);
      resolve(new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1));
    });
    child.stdin.on('error', () => undefined);
    if ('bytes' in input) child.stdin.end(Buffer.from(input.bytes));
    else child.stdin.end();
  });
}

/** The narration's median pitch: a minute from the middle track, decoded here. */
async function narrationPitch(ctx: AppContext, bookId: string): Promise<number | null> {
  for (const edition of editionsForBook(ctx.db, bookId).filter((e) => e.kind === 'audio' && e.status === 'ready')) {
    const files = editionFiles(ctx.db, edition.id);
    const middle = files[Math.floor(files.length / 2)];
    if (!middle) continue;
    const startS = middle.duration_ms && middle.duration_ms > (PITCH_SAMPLE_S + 30) * 1000 ? 30 : 0;
    const pcm = await decodePcm({ file: ctx.storage.blobPath(middle.blob_id) }, startS, PITCH_SAMPLE_S).catch(() => null);
    const pitch = pcm ? medianPitch(pcm, PCM_RATE) : null;
    if (pitch) return pitch.medianHz;
  }
  return null;
}

export interface DesignOptions {
  readonly bookId: string;
  readonly description: string;
  readonly narrator?: string;
  /** A preview by its number (1-based), or `auto`: the one nearest the narration's pitch. */
  readonly pick: number | 'auto';
  /** With `auto` and a known narration pitch: up to this many rounds of design, until a preview is within CLOSE_SEMITONES (DESIGN_ROUNDS). */
  readonly rounds?: number;
  readonly outDir?: string;
  readonly settings?: NarratorSettings;
  readonly design: Pick<ElevenLabsVoiceDesign, 'design' | 'save' | 'pace'>;
  /** For tests: how audio becomes PCM (ffmpeg by default). */
  readonly decode?: typeof decodePcm;
  /** For tests: the narration's pitch, instead of decoding it. */
  readonly narrationPitchHz?: number | null;
}

/** Case (b) of D223, end to end: measure the narration, design, pick, keep, match the pace. The lines report what was done. */
export async function designNarratorVoice(ctx: AppContext, o: DesignOptions): Promise<string[]> {
  const book = bookById(ctx.db, o.bookId)!;
  const report: string[] = [];
  const decode = o.decode ?? decodePcm;
  const narrator = o.narrator ?? (await narratorFromTags(ctx, o.bookId)) ?? '';
  const narratorWpm = paceOf(transcriptTracksFor(ctx.db, o.bookId));
  const narratorF0 = o.narrationPitchHz !== undefined ? o.narrationPitchHz : await narrationPitch(ctx, o.bookId);
  report.push(`narration: ${narrator || 'narrator unnamed'}; pace ${narratorWpm ? `${Math.round(narratorWpm)} wpm` : 'unknown (no transcript)'}; pitch ${narratorF0 ? `${narratorF0} Hz` : 'unknown'}`);

  // Voice Design gives different voices for one description each time: with a pitch to aim for,
  // another round is asked for while every preview so far is further than CLOSE_SEMITONES from it.
  const rounds = o.pick === 'auto' && narratorF0 ? (o.rounds ?? DESIGN_ROUNDS) : 1;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('--rounds is 1 to 10');
  const measured: { preview: DesignedPreview; f0: number | null }[] = [];
  const distance = (f0: number | null) => (f0 && narratorF0 ? semitonesApart(f0, narratorF0) : Number.POSITIVE_INFINITY);
  for (let round = 0; round < rounds; round++) {
    const { previews } = await o.design.design({ description: o.description, text: PREVIEW_TEXT, seed: o.settings?.seed !== undefined ? o.settings.seed + round : undefined });
    if (!previews.length) throw new Error('Voice Design returned no previews');
    for (const preview of previews) {
      const pcm = await decode({ bytes: preview.audio }, 0, 60).catch(() => null);
      measured.push({ preview, f0: pcm ? (medianPitch(pcm, PCM_RATE)?.medianHz ?? null) : null });
    }
    if (measured.some((m) => distance(m.f0) <= CLOSE_SEMITONES)) break;
  }
  if (o.outDir) {
    await mkdir(o.outDir, { recursive: true });
    for (const [i, m] of measured.entries()) await writeFile(path.join(o.outDir, `preview-${i + 1}.mp3`), m.preview.audio);
  }
  measured.forEach((m, i) =>
    report.push(`preview ${i + 1}: pitch ${m.f0 ?? '?'} Hz${m.f0 && narratorF0 ? ` (${semitonesApart(m.f0, narratorF0).toFixed(1)} semitones from the narration)` : ''}, ${m.preview.durationSecs.toFixed(1)} s`),
  );
  let chosen: number;
  if (o.pick === 'auto') {
    const scored = measured.map((m, i) => ({ i, d: distance(m.f0) }));
    chosen = scored.reduce((best, s) => (s.d < best.d ? s : best), scored[0]!).i;
  } else {
    if (!Number.isInteger(o.pick) || o.pick < 1 || o.pick > measured.length) throw new Error(`--pick is 1 to ${measured.length}, or auto`);
    chosen = o.pick - 1;
  }
  report.push(`picked preview ${chosen + 1}${o.pick === 'auto' ? (narratorF0 ? ' (nearest the narration’s pitch)' : ' (the first: the narration’s pitch is unknown)') : ''}`);
  if (o.pick === 'auto' && distance(measured[chosen]!.f0) > CLOSE_SEMITONES && narratorF0) {
    report.push(`note: still ${distance(measured[chosen]!.f0).toFixed(1)} semitones from the narration after ${Math.ceil(measured.length / 3)} round(s): a description nearer the narrator's register may do better`);
  }

  const voiceId = await o.design.save({
    generatedVoiceId: measured[chosen]!.preview.generatedVoiceId,
    name: `Book Club: ${book.title}`.slice(0, 100),
    description: o.description,
    labels: { app: 'book-club', book: o.bookId, source: 'voice-design' },
  });
  report.push(`kept as voice ${voiceId}`);

  // Its own pace at speed 1 with the book's other settings, then the speed that keeps the narrator's.
  const first = saveNarratorVoice(ctx.db, o.bookId, { narrator, designedVoiceId: voiceId, designDescription: o.description, settings: o.settings, narratorWpm, narratorF0Hz: narratorF0 });
  let speed = o.settings?.speed;
  if (speed === undefined && narratorWpm) {
    const { wpm } = await o.design.pace(voiceId, { ...settingsOf(first), speed: 1 }, PREVIEW_TEXT);
    speed = matchedSpeed(narratorWpm, wpm);
    report.push(`its pace at speed 1: ${Math.round(wpm)} wpm; speed ${speed} keeps the narrator's ${Math.round(narratorWpm)}`);
  }
  const row = speed !== undefined ? saveNarratorVoice(ctx.db, o.bookId, { settings: { speed } }) : first;
  if (row.narration_voice_id || row.clone_voice_id) report.push(`note: this book also has a ${row.narration_voice_id ? 'narration' : 'consented clone'} voice, which is spoken before a designed one`);
  report.push(describeRow(ctx, row));
  return report;
}
