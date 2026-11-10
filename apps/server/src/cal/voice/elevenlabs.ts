import { type SpeakOptions, type SttProvider, type SttResult, type TtsProvider, type TtsVoice, type TtsVoiceSettings } from './types';

/** $ per minute of audio transcribed (Scribe), checked 2026-10-28. Logged for the spend cap, never billed from this. */
const STT_PRICE_PER_MINUTE = 0.04;
/** $ per 1K characters synthesised (Flash v2.5-class pricing), checked 2026-10-28. */
const TTS_PRICE_PER_1K_CHARS = 0.05;

const API = 'https://api.elevenlabs.io';

type Fetch = typeof fetch;

export class ElevenLabsSttProvider implements SttProvider {
  readonly name = 'elevenlabs';
  readonly model = 'scribe_v1';

  constructor(private readonly apiKey: string) {}

  async transcribe(audio: Uint8Array, mimeType: string): Promise<SttResult> {
    const form = new FormData();
    form.append('model_id', this.model);
    form.append('file', new Blob([audio], { type: mimeType }), 'audio');
    const res = await fetch(`${API}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': this.apiKey }, body: form });
    if (!res.ok) throw new Error(`ElevenLabs STT failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { text: string };
    // ElevenLabs does not return duration on this endpoint; estimated from a typical 16kbps-ish voice clip.
    const estimatedMinutes = audio.byteLength / (16_000 * 60);
    return { text: body.text, costUsd: estimatedMinutes * STT_PRICE_PER_MINUTE };
  }
}

/** Cal's own delivery (D167's measured setup), and the seed his replies are spoken with (D223: a cached copy is the same speech). */
export const CAL_VOICE_SETTINGS = { stability: 0.5, similarityBoost: 0.75, seed: 1 } as const;

/** ElevenLabs' `voice_settings`, from ours. */
function voiceSettingsBody(s: TtsVoiceSettings): Record<string, number | boolean> {
  return { stability: s.stability, similarity_boost: s.similarityBoost, style: s.style, speed: s.speed, use_speaker_boost: s.useSpeakerBoost };
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = 'elevenlabs';
  readonly model = 'eleven_flash_v2_5';
  readonly outputMimeType = 'audio/mpeg';

  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  accepts(voice: TtsVoice): boolean {
    return voice.kind === 'cal' || voice.provider === 'elevenlabs';
  }

  /** The request a voice makes: the narrator's voice id, settings, model and seed, else Cal's own (D223). */
  requestFor(text: string, voice: TtsVoice | undefined): { voiceId: string; body: Record<string, unknown> } {
    if (voice?.kind === 'narrator' && this.accepts(voice)) {
      return { voiceId: voice.voiceId, body: { text, model_id: voice.settings.modelId, voice_settings: voiceSettingsBody(voice.settings), seed: voice.settings.seed } };
    }
    return {
      voiceId: this.voiceId,
      body: { text, model_id: this.model, voice_settings: { stability: CAL_VOICE_SETTINGS.stability, similarity_boost: CAL_VOICE_SETTINGS.similarityBoost }, seed: CAL_VOICE_SETTINGS.seed },
    };
  }

  async *speak(text: string, options: SpeakOptions): AsyncIterable<Uint8Array> {
    const { voiceId, body } = this.requestFor(text, options.voice);
    const res = await this.fetchImpl(`${API}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`, {
      method: 'POST',
      signal: options.signal,
      headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.ok ? '' : await res.text()}`);
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) yield chunk;
  }
}

export function elevenLabsCostPerChar(): number {
  return TTS_PRICE_PER_1K_CHARS / 1000;
}

/* ------------------------------------------------------------------------------------------ */
/* Voice Design (D223, case (b)): a voice from a written description, never from a recording      */
/* ------------------------------------------------------------------------------------------ */

export interface DesignedPreview {
  readonly generatedVoiceId: string;
  readonly audio: Uint8Array;
  readonly mediaType: string;
  readonly durationSecs: number;
}

export interface DesignInput {
  /** What the narrator sounds like, in words (20-1000 characters, ElevenLabs' limits). */
  readonly description: string;
  /** What the previews read (100-1000 characters); ElevenLabs writes one when absent. */
  readonly text?: string;
  readonly seed?: number;
  readonly guidanceScale?: number;
  /** -1 quietest to 1 loudest, 0 about -24 LUFS. */
  readonly loudness?: number;
}

/**
 * The only fields a design request may carry. ElevenLabs' design endpoint also takes
 * `reference_audio_base64` (a sample to match), which with a narrator's recording would be a
 * clone without their consent: it is not in this list, so no caller can send it (D223).
 */
const DESIGN_FIELDS = ['voice_description', 'model_id', 'text', 'auto_generate_text', 'seed', 'guidance_scale', 'loudness'] as const;
export const DESIGN_MODEL = 'eleven_multilingual_ttv_v2';

export class ElevenLabsVoiceDesign {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /** The design request's body, built from DESIGN_FIELDS only. */
  static designBody(input: DesignInput): Record<string, unknown> {
    const description = input.description.trim();
    if (description.length < 20 || description.length > 1000) throw new Error('a voice description is 20 to 1000 characters');
    if (input.text !== undefined && (input.text.length < 100 || input.text.length > 1000)) throw new Error('preview text is 100 to 1000 characters');
    const candidate: Record<string, unknown> = {
      voice_description: description,
      model_id: DESIGN_MODEL,
      text: input.text,
      auto_generate_text: input.text === undefined,
      seed: input.seed,
      guidance_scale: input.guidanceScale,
      loudness: input.loudness,
    };
    return Object.fromEntries(DESIGN_FIELDS.filter((k) => candidate[k] !== undefined).map((k) => [k, candidate[k]]));
  }

  /** Three or so previews of voices matching the description, each with the id that saves it. */
  async design(input: DesignInput): Promise<{ text: string; previews: DesignedPreview[] }> {
    const res = await this.fetchImpl(`${API}/v1/text-to-voice/design?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(ElevenLabsVoiceDesign.designBody(input)),
    });
    if (!res.ok) throw new Error(`ElevenLabs voice design failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { text: string; previews: { generated_voice_id: string; audio_base_64: string; media_type: string; duration_secs: number }[] };
    return {
      text: body.text,
      previews: body.previews.map((p) => ({ generatedVoiceId: p.generated_voice_id, audio: new Uint8Array(Buffer.from(p.audio_base_64, 'base64')), mediaType: p.media_type, durationSecs: p.duration_secs })),
    };
  }

  /** Keep a preview as a voice of the account: its voice id. */
  async save(input: { generatedVoiceId: string; name: string; description: string; labels: Record<string, string> }): Promise<string> {
    const res = await this.fetchImpl(`${API}/v1/text-to-voice`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ voice_name: input.name, voice_description: input.description.trim(), generated_voice_id: input.generatedVoiceId, labels: input.labels }),
    });
    if (!res.ok) throw new Error(`ElevenLabs could not save the voice: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { voice_id: string }).voice_id;
  }

  /**
   * How fast a voice speaks `text` with `settings`, in words a minute, from ElevenLabs' own
   * per-character timings (first character spoken to last), the way a narrator's pace is measured
   * from the transcript's first word to its last. The audio is returned too, for listening.
   */
  async pace(voiceId: string, settings: TtsVoiceSettings, text: string): Promise<{ wpm: number; audio: Uint8Array }> {
    const res = await this.fetchImpl(`${API}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: settings.modelId, voice_settings: voiceSettingsBody(settings), seed: settings.seed }),
    });
    if (!res.ok) throw new Error(`ElevenLabs could not time the voice: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { audio_base64: string; alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null };
    const a = body.alignment;
    if (!a || a.characters.length === 0) throw new Error('ElevenLabs returned no timings for the voice');
    const spoken = a.characters.map((c, i) => ({ c, i })).filter(({ c }) => c.trim() !== '');
    const seconds = a.character_end_times_seconds[spoken.at(-1)!.i]! - a.character_start_times_seconds[spoken[0]!.i]!;
    const words = text.split(/\s+/).filter(Boolean).length;
    if (!(seconds > 0)) throw new Error('ElevenLabs returned timings with no length');
    return { wpm: words / (seconds / 60), audio: new Uint8Array(Buffer.from(body.audio_base64, 'base64')) };
  }
}
