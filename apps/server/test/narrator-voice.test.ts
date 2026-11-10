import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ElevenLabsTtsProvider, ElevenLabsVoiceDesign, type DesignedPreview } from '../src/cal/voice/elevenlabs';
import { fakeVoiceTag } from '../src/cal/voice/fake';
import {
  NARRATOR_DEFAULTS,
  matchedSpeed,
  narratorVoiceFor,
  narratorVoiceRow,
  paceOf,
  resolveNarratorVoice,
  saveNarratorVoice,
  settingsOf,
  type NarratorVoiceRow,
} from '../src/cal/voice/narrator';
import { medianPitch, semitonesApart } from '../src/cal/voice/pitch';
import { CachedTtsProvider } from '../src/cal/voice/tts-cache';
import { CAL_VOICE, type SpeakOptions, type TtsProvider, type TtsVoice } from '../src/cal/voice/types';
import { designNarratorVoice, narratorVoiceCommand, PREVIEW_TEXT } from '../src/cli/narrator-voice';
import { createBook } from '../src/repos/books';
import { type Client, type TestApp, closeApp, makeTestApp, setupOwner } from './helpers';

/**
 * Cal answers in the narrator's voice (D223): a book's (a) narration voice, (c) consented clone or
 * (b) designed voice, in that order; delivery matched to the narrator's pace; spoken replies cached;
 * a clone never without consent, and Voice Design never sent a recording.
 */

const VOICE_A = 'NarrationVoice000001';
const VOICE_B = 'DesignedVoice0000001';
const VOICE_C = 'ConsentedClone000001';

function row(over: Partial<NarratorVoiceRow> = {}): NarratorVoiceRow {
  return {
    book_id: 'b1',
    narrator: 'A. Reader',
    narration_voice_id: null,
    designed_voice_id: null,
    design_description: '',
    clone_voice_id: null,
    clone_consent: '',
    settings_json: '{}',
    narrator_wpm: null,
    narrator_f0_hz: null,
    updated_at: 0,
    ...over,
  };
}

/** A voiced sound at `hz`: a fundamental and two harmonics, as speech has, at 16 kHz. */
function voiced(hz: number, seconds: number, rate = 16_000): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    out[i] = Math.round(8000 * Math.sin(2 * Math.PI * hz * t) + 3000 * Math.sin(4 * Math.PI * hz * t) + 1500 * Math.sin(6 * Math.PI * hz * t));
  }
  return out;
}

/** A track of `words` words read at `wpm`, starting a little in, as a transcript keeps them. */
function track(words: number, wpm: number, startMs = 1500): { words: [number, number, string][] } {
  const each = 60_000 / wpm;
  return { words: Array.from({ length: words }, (_, i) => [Math.round(startMs + i * each), Math.round(startMs + i * each + each * 0.8), `w${i}`] as [number, number, string]) };
}

describe('which voice a book is answered in (D223)', () => {
  it('is Cal’s own without a row, and the narration’s own voice (a) before a consented clone (c) before a designed one (b)', () => {
    expect(resolveNarratorVoice(undefined)).toBeNull();
    expect(resolveNarratorVoice(row())).toBeNull();
    expect(resolveNarratorVoice(row({ designed_voice_id: VOICE_B }))).toMatchObject({ voiceId: VOICE_B, source: 'designed' });
    expect(resolveNarratorVoice(row({ designed_voice_id: VOICE_B, clone_voice_id: VOICE_C, clone_consent: 'Agreed by email, 2026-11-01' }))).toMatchObject({ voiceId: VOICE_C, source: 'clone' });
    expect(resolveNarratorVoice(row({ narration_voice_id: VOICE_A, designed_voice_id: VOICE_B, clone_voice_id: VOICE_C, clone_consent: 'yes' }))).toMatchObject({ voiceId: VOICE_A, source: 'narration' });
  });

  it('never speaks a clone without a record of consent, even if one reached the row', () => {
    expect(resolveNarratorVoice(row({ clone_voice_id: VOICE_C, clone_consent: '  ' }))).toBeNull();
    expect(resolveNarratorVoice(row({ clone_voice_id: VOICE_C, clone_consent: '', designed_voice_id: VOICE_B }))).toMatchObject({ source: 'designed' });
  });

  it('speaks with the book’s settings over the defaults, and the defaults when the stored ones are no longer valid', () => {
    expect(settingsOf(row({ settings_json: JSON.stringify({ speed: 0.9, stability: 0.6 }) }))).toEqual({ ...NARRATOR_DEFAULTS, speed: 0.9, stability: 0.6 });
    expect(settingsOf(row({ settings_json: '{"speed": 7}' }))).toEqual(NARRATOR_DEFAULTS);
    expect(settingsOf(row({ settings_json: 'not json' }))).toEqual(NARRATOR_DEFAULTS);
  });
});

describe('a narrator’s pace and pitch, measured', () => {
  it('counts words over the time from each track’s first word to its last, leaving out tracks that say too little', () => {
    expect(paceOf([track(400, 130), track(20, 300)])).toBeCloseTo(130, 0);
    expect(paceOf([track(300, 150), track(300, 110)])).toBeCloseTo(127, 0);
    expect(paceOf([track(10, 130)])).toBeNull();
    expect(paceOf([])).toBeNull();
  });

  it('sets the speed that keeps the narrator’s pace, within ElevenLabs’ range', () => {
    expect(matchedSpeed(130, 160)).toBe(0.81);
    expect(matchedSpeed(150, 150)).toBe(1);
    expect(matchedSpeed(300, 100)).toBe(1.2);
    expect(matchedSpeed(50, 200)).toBe(0.7);
    expect(matchedSpeed(130, 0)).toBe(1);
  });

  it('finds a low male and a female narrator’s pitch, and nothing in silence', () => {
    const low = medianPitch(voiced(107, 4), 16_000)!;
    const high = medianPitch(voiced(205, 4), 16_000)!;
    expect(Math.abs(low.medianHz - 107)).toBeLessThan(4);
    expect(Math.abs(high.medianHz - 205)).toBeLessThan(6);
    expect(medianPitch(new Int16Array(16_000 * 4), 16_000)).toBeNull();
    expect(semitonesApart(110, 220)).toBeCloseTo(12, 5);
    expect(semitonesApart(220, 110)).toBeCloseTo(12, 5);
  });
});

describe('ElevenLabs requests (D223)', () => {
  const designed: Extract<TtsVoice, { kind: 'narrator' }> = {
    kind: 'narrator',
    provider: 'elevenlabs',
    voiceId: VOICE_B,
    source: 'designed',
    narrator: 'A. Reader',
    settings: { ...NARRATOR_DEFAULTS, speed: 0.86, stability: 0.55, style: 0.1, modelId: 'eleven_multilingual_v2', seed: 42 },
  };

  it('speaks a narrator’s voice with its id, settings, model and seed, and Cal’s as before', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const tts = new ElevenLabsTtsProvider('key', 'CalsOwnVoice00000001', fetchImpl);
    for await (const _ of tts.speak('Hello there.', { signal: new AbortController().signal, voice: designed })) void _;
    for await (const _ of tts.speak('Hello there.', { signal: new AbortController().signal })) void _;
    expect(calls[0]!.url).toContain(`/v1/text-to-speech/${VOICE_B}/stream`);
    expect(calls[0]!.body).toEqual({
      text: 'Hello there.',
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.1, speed: 0.86, use_speaker_boost: true },
      seed: 42,
    });
    expect(calls[1]!.url).toContain('/v1/text-to-speech/CalsOwnVoice00000001/stream');
    expect(calls[1]!.body).toMatchObject({ model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.75 } });
  });

  it('designs from words only: a recording can never be sent to Voice Design', async () => {
    const sneaky = { description: 'A warm, low, unhurried English baritone in his forties.', text: PREVIEW_TEXT, reference_audio_base64: 'AAAA', referenceAudio: 'AAAA', prompt_strength: 0 } as never;
    const body = ElevenLabsVoiceDesign.designBody(sneaky);
    expect(Object.keys(body).sort()).toEqual(['auto_generate_text', 'model_id', 'text', 'voice_description']);
    expect(JSON.stringify(body)).not.toMatch(/reference|AAAA|prompt_strength/);

    const sent: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(String(init?.body));
      return Response.json({ text: PREVIEW_TEXT, previews: [{ generated_voice_id: 'gen1', audio_base_64: Buffer.from('mp3').toString('base64'), media_type: 'audio/mpeg', duration_secs: 12.5, language: 'en' }] });
    }) as unknown as typeof fetch;
    const result = await new ElevenLabsVoiceDesign('key', fetchImpl).design(sneaky);
    expect(result.previews[0]).toMatchObject({ generatedVoiceId: 'gen1', durationSecs: 12.5 });
    expect(Buffer.from(result.previews[0]!.audio).toString()).toBe('mp3');
    expect(sent[0]).not.toMatch(/reference|AAAA/);
  });

  it('refuses a description or a preview text outside ElevenLabs’ limits before calling it', () => {
    expect(() => ElevenLabsVoiceDesign.designBody({ description: 'too short' })).toThrow(/20 to 1000/);
    expect(() => ElevenLabsVoiceDesign.designBody({ description: 'A warm, low, unhurried baritone.', text: 'short' })).toThrow(/100 to 1000/);
  });

  it('times a voice from its first spoken character to its last', async () => {
    const text = 'one two three four five six seven eight nine ten';
    const chars = [...` ${text} `];
    // The first word begins at 0.5 s, the last ends at 4.5 s: ten words in four seconds is 150 a minute.
    const starts = chars.map((_, i) => 0.5 + (4 * Math.max(0, i - 1)) / (chars.length - 2));
    const ends = starts.map((s, i) => (i === chars.length - 2 ? 4.5 : s + 0.01));
    const fetchImpl = vi.fn(async () =>
      Response.json({ audio_base64: Buffer.from('mp3').toString('base64'), alignment: { characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends } }),
    ) as unknown as typeof fetch;
    const { wpm } = await new ElevenLabsVoiceDesign('key', fetchImpl).pace(VOICE_B, NARRATOR_DEFAULTS, text);
    expect(wpm).toBeCloseTo(150, 0);
  });
});

/** A provider that counts its syntheses and can be cut off. */
class CountingTts implements TtsProvider {
  readonly name = 'counting';
  readonly model = 'counting-1';
  readonly outputMimeType = 'audio/mpeg';
  calls = 0;
  accepts(): boolean {
    return true;
  }
  async *speak(text: string, options: SpeakOptions): AsyncIterable<Uint8Array> {
    this.calls++;
    const tag = options.voice?.kind === 'narrator' ? options.voice.voiceId : 'cal';
    for (let i = 0; i < 3; i++) yield new TextEncoder().encode(`${tag}:${text}:${i};`);
  }
}

async function collect(tts: TtsProvider, text: string, options: Partial<SpeakOptions> = {}, stopAfter = Infinity): Promise<{ bytes: string; hit: boolean }> {
  const controller = new AbortController();
  let hit = false;
  const parts: Uint8Array[] = [];
  for await (const chunk of tts.speak(text, { signal: controller.signal, onCacheHit: () => (hit = true), ...options })) {
    parts.push(chunk);
    if (parts.length >= stopAfter) {
      controller.abort();
      break;
    }
  }
  return { bytes: Buffer.concat(parts).toString(), hit };
}

describe('spoken replies, cached (D223)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tts-cache-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const narrator = (voiceId: string, speed = 1): TtsVoice => ({ kind: 'narrator', provider: 'elevenlabs', voiceId, source: 'designed', narrator: '', settings: { ...NARRATOR_DEFAULTS, speed } });

  it('speaks a reply once, then reads the same words in the same voice from disk, as the same bytes', async () => {
    const inner = new CountingTts();
    const tts = new CachedTtsProvider(inner, path.join(dir, 'a'), { maxBytes: 1e6, maxAgeMs: 1e9, calVoiceId: 'george' });
    const first = await collect(tts, 'The answer is a raven.', { voice: narrator(VOICE_B) });
    const again = await collect(tts, 'The answer is a raven.', { voice: narrator(VOICE_B) });
    expect(first.hit).toBe(false);
    expect(again).toEqual({ bytes: first.bytes, hit: true });
    expect(inner.calls).toBe(1);
  });

  it('keys on the voice and its delivery: another voice, speed or Cal’s own is spoken afresh', async () => {
    const inner = new CountingTts();
    const tts = new CachedTtsProvider(inner, path.join(dir, 'b'), { maxBytes: 1e6, maxAgeMs: 1e9, calVoiceId: 'george' });
    await collect(tts, 'Same words.', { voice: narrator(VOICE_B) });
    expect((await collect(tts, 'Same words.', { voice: narrator(VOICE_B, 0.9) })).hit).toBe(false);
    expect((await collect(tts, 'Same words.', { voice: narrator(VOICE_A) })).hit).toBe(false);
    expect((await collect(tts, 'Same words.', { voice: CAL_VOICE })).hit).toBe(false);
    expect((await collect(tts, 'Same words.')).hit).toBe(true);
    expect(inner.calls).toBe(4);
    const recolored = new CachedTtsProvider(inner, path.join(dir, 'b'), { maxBytes: 1e6, maxAgeMs: 1e9, calVoiceId: 'another-cal-voice' });
    expect((await collect(recolored, 'Same words.')).hit).toBe(false);
  });

  it('never keeps a reply that was cut off', async () => {
    const inner = new CountingTts();
    const tts = new CachedTtsProvider(inner, path.join(dir, 'c'), { maxBytes: 1e6, maxAgeMs: 1e9, calVoiceId: 'george' });
    await collect(tts, 'Interrupted halfway.', {}, 1);
    const whole = await collect(tts, 'Interrupted halfway.');
    expect(whole.hit).toBe(false);
    expect(whole.bytes).toBe('cal:Interrupted halfway.:0;cal:Interrupted halfway.:1;cal:Interrupted halfway.:2;');
    expect((await collect(tts, 'Interrupted halfway.')).hit).toBe(true);
  });

  it('keeps within its size, least recently used first, and nothing past its age', async () => {
    const inner = new CountingTts();
    const root = path.join(dir, 'd');
    const tts = new CachedTtsProvider(inner, root, { maxBytes: 200, maxAgeMs: 10_000, calVoiceId: 'george' });
    const files = () => readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
    for (const text of ['one', 'two', 'three']) await collect(tts, text);
    const all = files();
    expect(all).toHaveLength(3);
    // Each is about 60 bytes: all three fit in 200. Make "one" the oldest, then a fourth pushes past the limit.
    const old = Date.now() / 1000 - 5;
    for (const f of all) utimesSync(f, old + (f.includes(tts.keyFor('one', undefined)) ? 0 : 1), old + (f.includes(tts.keyFor('one', undefined)) ? 0 : 1));
    await collect(tts, 'four, a longer reply than the others');
    await tts.prune();
    expect(files().some((f) => f.includes(tts.keyFor('one', undefined)))).toBe(false);
    expect(files().reduce((n, f) => n + statSync(f).size, 0)).toBeLessThanOrEqual(200);
    await tts.prune(Date.now() + 60_000);
    expect(files()).toHaveLength(0);
  });
});

describe('a voice turn about a book with a narrator voice (D223, over /ws/cal/voice)', () => {
  let t: TestApp;
  let owner: Client;
  let clubId: string;
  let bookId: string;
  let plainBookId: string;

  beforeAll(async () => {
    t = await makeTestApp({ ANTHROPIC_API_KEY: 'test-key', CAL_TEST_FAKE_MODEL: 'true', CAL_EMBEDDING_PROVIDER: 'fake', CAL_STT_PROVIDER: 'fake', CAL_TTS_PROVIDER: 'fake', CAL_RATE_LIMIT_PER_MINUTE: '1000' });
    ({ owner, club: { id: clubId } } = await setupOwner(t));
    const ownerId = t.ctx.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
    bookId = createBook(t.ctx.db, { clubId, title: 'Red Sky', author: 'P. Writer', createdBy: ownerId }).id;
    plainBookId = createBook(t.ctx.db, { clubId, title: 'Plain', author: 'Q. Writer', createdBy: ownerId }).id;
  });
  afterAll(async () => {
    await closeApp(t);
  });

  const thread = async (forBook: string | null) => (await owner.json<{ id: string }>(owner.post(`/api/clubs/${clubId}/cal/conversations`, { bookId: forBook }), 201)).id;

  /** One push-to-talk turn: what the server sent back, its control messages and its audio. */
  async function turn(conversationId: string): Promise<{ control: { type: string; voice?: unknown }[]; audio: string[] }> {
    const ws = new WebSocket(`${t.baseUrl.replace(/^http/, 'ws')}/ws/cal/voice?clubId=${clubId}&conversationId=${conversationId}`, { headers: { cookie: owner.cookieHeader, origin: t.baseUrl } });
    const control: { type: string; voice?: unknown }[] = [];
    const audio: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'start', mimeType: 'audio/webm' }));
        ws.send(Buffer.from('pretend speech'));
        ws.send(JSON.stringify({ type: 'end' }));
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return void audio.push(Buffer.from(data as Buffer).toString());
        const msg = JSON.parse(String(data)) as { type: string; voice?: unknown; message?: string };
        control.push(msg);
        if (msg.type === 'error') reject(new Error(msg.message));
        if (msg.type === 'speakingEnd') resolve();
      });
      ws.once('error', reject);
      ws.once('close', (code, reason) => reject(new Error(`closed ${code} ${String(reason)}`)));
    });
    ws.removeAllListeners('close');
    ws.close();
    return { control, audio };
  }

  const ttsCosts = () => t.ctx.db.all<{ cost_usd: number; model: string }>("SELECT cost_usd, model FROM cal_cost_log WHERE kind = 'voice_tts' ORDER BY created_at, rowid");

  it('answers in Cal’s own voice until the book has a narrator voice, then in the narrator’s, saying whose', async () => {
    const id = await thread(bookId);
    const before = await turn(id);
    expect(before.control.find((m) => m.type === 'speakingStart')).toEqual({ type: 'speakingStart', voice: { kind: 'cal' } });
    expect(before.audio.join('').startsWith(fakeVoiceTag(undefined))).toBe(true);

    saveNarratorVoice(t.ctx.db, bookId, { narrator: 'Tim Example', designedVoiceId: VOICE_B, designDescription: 'A low, gravelly English baritone.', settings: { speed: 0.88 } });
    const after = await turn(id);
    expect(after.control.find((m) => m.type === 'speakingStart')).toEqual({ type: 'speakingStart', voice: { kind: 'narrator', narrator: 'Tim Example', source: 'designed' } });
    expect(after.audio.join('').startsWith(`voice:${VOICE_B}:0.88`)).toBe(true);
    // The client is never told the voice id or its settings.
    expect(JSON.stringify(after.control)).not.toContain(VOICE_B);
  });

  it('keeps Cal’s voice for a thread about another book, or about no book', async () => {
    for (const forBook of [plainBookId, null]) {
      const { control, audio } = await turn(await thread(forBook));
      expect(control.find((m) => m.type === 'speakingStart')).toEqual({ type: 'speakingStart', voice: { kind: 'cal' } });
      // Spoken afresh or read back from the cache (the same reply in Cal's voice was spoken above), it is Cal's voice.
      expect(audio.join('').startsWith('voice:cal')).toBe(true);
    }
  });

  it('speaks the same reply in the same voice from the cache the second time, for nothing', async () => {
    const id = await thread(bookId);
    const costs = ttsCosts().length;
    const first = await turn(id);
    const second = await turn(id);
    expect(second.audio.join('')).toBe(first.audio.join(''));
    const logged = ttsCosts().slice(costs);
    expect(logged).toHaveLength(2);
    expect(logged[1]!.cost_usd).toBe(0);
    expect(logged[0]!.model).toBe(NARRATOR_DEFAULTS.modelId);
  });

  it('a clone needs consent, at the table itself and in the command', async () => {
    const ownerDb = t.ctx.db;
    expect(() => saveNarratorVoice(ownerDb, bookId, { clone: { voiceId: VOICE_C, consent: ' ' } })).toThrow(/consent/);
    expect(() => ownerDb.exec("UPDATE narrator_voices SET clone_voice_id = ?, clone_consent = '' WHERE book_id = ?", [VOICE_C, bookId])).toThrow(/CHECK/);
    await expect(narratorVoiceCommand(t.ctx, ['set', '--book', bookId, '--clone-voice-id', VOICE_C], () => undefined)).rejects.toThrow(/--consent/);
    const lines: string[] = [];
    await narratorVoiceCommand(t.ctx, ['set', '--book', bookId, '--clone-voice-id', VOICE_C, '--consent', 'Tim Example agreed in writing, 2026-11-09'], (l) => lines.push(l));
    expect(narratorVoiceFor(t.ctx.db, bookId)).toMatchObject({ source: 'clone', voiceId: VOICE_C });
    expect(lines.join('\n')).toContain('speaking: clone');
    await narratorVoiceCommand(t.ctx, ['set', '--book', bookId, '--clear-clone'], () => undefined);
    expect(narratorVoiceFor(t.ctx.db, bookId)).toMatchObject({ source: 'designed', voiceId: VOICE_B });
  });

  it('gives another book of the series the voice already designed for its narrator', async () => {
    await narratorVoiceCommand(t.ctx, ['set', '--book', plainBookId, '--designed-voice-id', VOICE_B, '--narrator', 'Tim Example', '--description', 'The same narrator.', '--speed', '0.88'], () => undefined);
    expect(narratorVoiceFor(t.ctx.db, plainBookId)).toMatchObject({ source: 'designed', voiceId: VOICE_B, narrator: 'Tim Example', settings: { speed: 0.88 } });
    expect(narratorVoiceRow(t.ctx.db, plainBookId)!.design_description).toBe('The same narrator.');
    await expect(narratorVoiceCommand(t.ctx, ['set', '--book', plainBookId, '--designed-voice-id', '../etc'], () => undefined)).rejects.toThrow(/voice id/);
    await narratorVoiceCommand(t.ctx, ['remove', '--book', plainBookId], () => undefined);
    expect(narratorVoiceFor(t.ctx.db, plainBookId)).toBeNull();
  });

  it('answers in Cal’s own voice everywhere when the server turns narrator voices off', async () => {
    const off = await makeTestApp({ ANTHROPIC_API_KEY: 'test-key', CAL_TEST_FAKE_MODEL: 'true', CAL_EMBEDDING_PROVIDER: 'fake', CAL_STT_PROVIDER: 'fake', CAL_TTS_PROVIDER: 'fake', CAL_NARRATOR_VOICES: 'false' });
    try {
      const { replyVoiceFor } = await import('../src/cal/voice/pipeline');
      const ownerId = (await setupOwner(off)).club.id;
      const userId = off.ctx.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
      const id = createBook(off.ctx.db, { clubId: ownerId, title: 'Off', author: '', createdBy: userId }).id;
      saveNarratorVoice(off.ctx.db, id, { designedVoiceId: VOICE_B });
      expect(replyVoiceFor(off.ctx, new CountingTts(), id)).toEqual(CAL_VOICE);
      expect(replyVoiceFor(t.ctx, new CountingTts(), bookId)).toMatchObject({ kind: 'narrator' });
    } finally {
      await closeApp(off);
    }
  });
});

describe('bookclub narrator-voice design (D223, case (b))', () => {
  let t: TestApp;
  let bookId: string;

  beforeAll(async () => {
    t = await makeTestApp();
    const { club } = await setupOwner(t);
    const ownerId = t.ctx.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
    bookId = createBook(t.ctx.db, { clubId: club.id, title: 'Red Sky', author: 'P. Writer', createdBy: ownerId }).id;
    // An audiobook with a transcript read at 130 words a minute.
    t.ctx.db.exec("INSERT INTO editions (id, book_id, kind, status, created_by, created_at) VALUES ('aud1', ?, 'audio', 'ready', ?, 0)", [bookId, ownerId]);
    t.ctx.db.exec("INSERT INTO transcripts (edition_id, engine, tracks_json, created_at) VALUES ('aud1', 'test', ?, 0)", [JSON.stringify([track(600, 130), track(600, 130)])]);
  });
  afterAll(async () => {
    await closeApp(t);
  });

  it('measures the narration, designs, picks the preview nearest its pitch, keeps it and matches the pace', async () => {
    const pitches = [120, 210, 300];
    const previews: DesignedPreview[] = pitches.map((hz, i) => ({ generatedVoiceId: `gen${i + 1}`, audio: new Uint8Array([hz >> 8, hz & 255]), mediaType: 'audio/mpeg', durationSecs: 14 }));
    const design = {
      design: vi.fn(async () => ({ text: PREVIEW_TEXT, previews })),
      save: vi.fn(async () => 'KeptVoice00000000001'),
      pace: vi.fn(async () => ({ wpm: 160, audio: new Uint8Array() })),
    };
    // The previews' bytes stand for their pitch; the decoder turns each into that voiced sound.
    const decode = vi.fn(async (input: { file: string } | { bytes: Uint8Array }) => voiced('bytes' in input ? (input.bytes[0]! << 8) | input.bytes[1]! : 0, 4));
    const description = 'A woman in her thirties, General American, warm and clear, medium-high, unhurried storytelling.';
    const report = await designNarratorVoice(t.ctx, { bookId, description, narrator: 'Kris Reader', pick: 'auto', design, decode, narrationPitchHz: 205 });

    expect(design.design).toHaveBeenCalledWith({ description, text: PREVIEW_TEXT, seed: expect.any(Number) });
    expect(design.save).toHaveBeenCalledWith(expect.objectContaining({ generatedVoiceId: 'gen2', description, labels: { app: 'book-club', book: bookId, source: 'voice-design' } }));
    expect(design.pace).toHaveBeenCalledWith('KeptVoice00000000001', expect.objectContaining({ speed: 1 }), PREVIEW_TEXT);
    const row = narratorVoiceRow(t.ctx.db, bookId)!;
    expect(row).toMatchObject({ narrator: 'Kris Reader', designed_voice_id: 'KeptVoice00000000001', design_description: description, narrator_f0_hz: 205 });
    expect(row.narrator_wpm).toBeCloseTo(130, 0);
    expect(settingsOf(row).speed).toBe(0.81);
    expect(narratorVoiceFor(t.ctx.db, bookId)).toMatchObject({ source: 'designed', voiceId: 'KeptVoice00000000001', settings: { speed: 0.81 } });
    expect(report.join('\n')).toMatch(/picked preview 2 \(nearest the narration’s pitch\)/);
  });

  it('designs again while every preview is far from the narration’s pitch, then keeps the nearest of all', async () => {
    const round = (hzs: number[], tag: string): DesignedPreview[] => hzs.map((hz, i) => ({ generatedVoiceId: `${tag}${i + 1}`, audio: new Uint8Array([hz >> 8, hz & 255]), mediaType: 'audio/mpeg', durationSecs: 14 }));
    const rounds = [round([65, 66, 72], 'r1-'), round([80, 101, 140], 'r2-'), round([107, 107, 107], 'r3-')];
    const design = { design: vi.fn(async () => ({ text: PREVIEW_TEXT, previews: rounds.shift()! })), save: vi.fn(async () => 'RoundVoice0000000001'), pace: vi.fn(async () => ({ wpm: 130, audio: new Uint8Array() })) };
    const decode = async (input: { file: string } | { bytes: Uint8Array }) => voiced('bytes' in input ? (input.bytes[0]! << 8) | input.bytes[1]! : 0, 4);
    const report = await designNarratorVoice(t.ctx, { bookId, description: 'A man in his forties with a British accent, a baritone, intense and measured.', pick: 'auto', design, decode, narrationPitchHz: 107, designSeed: 500 });
    // Round one is six semitones and more below; round two has 101 Hz, within two: no third round.
    // Each round asks with a seed of its own: the same seed would bring back the same voices.
    expect(design.design.mock.calls.map((c) => (c as unknown as [{ seed: number }])[0].seed)).toEqual([500, 501]);
    expect(design.save).toHaveBeenCalledWith(expect.objectContaining({ generatedVoiceId: 'r2-2' }));
    expect(report.join('\n')).toMatch(/picked preview 5/);
    expect(report.join('\n')).not.toMatch(/still .* semitones/);
  });

  it('takes a preview by number, and a speed given outright over the measured one', async () => {
    const previews: DesignedPreview[] = [1, 2].map((i) => ({ generatedVoiceId: `pick${i}`, audio: new Uint8Array([0, 100]), mediaType: 'audio/mpeg', durationSecs: 14 }));
    const design = { design: vi.fn(async () => ({ text: PREVIEW_TEXT, previews })), save: vi.fn(async () => 'PickedVoice000000001'), pace: vi.fn(async () => ({ wpm: 100, audio: new Uint8Array() })) };
    await designNarratorVoice(t.ctx, { bookId, description: 'A low, gravelly English baritone, intense and measured.', pick: 2, settings: { speed: 0.95 }, design, decode: async () => voiced(100, 4), narrationPitchHz: null });
    expect(design.save).toHaveBeenCalledWith(expect.objectContaining({ generatedVoiceId: 'pick2' }));
    expect(design.pace).not.toHaveBeenCalled();
    expect(settingsOf(narratorVoiceRow(t.ctx.db, bookId)!).speed).toBe(0.95);
    await expect(designNarratorVoice(t.ctx, { bookId, description: 'A low, gravelly English baritone, intense and measured.', pick: 3, design, decode: async () => voiced(100, 4), narrationPitchHz: null })).rejects.toThrow(/--pick is 1 to 2/);
  });
});
