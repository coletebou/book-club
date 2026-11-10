import path from 'node:path';
import { type Config } from '../../config';
import { ElevenLabsSttProvider, ElevenLabsTtsProvider } from './elevenlabs';
import { FakeSttProvider, FakeTtsProvider } from './fake';
import { OpenAiSttProvider, OpenAiTtsProvider } from './openai';
import { CachedTtsProvider } from './tts-cache';
import { type SttProvider, type TtsProvider } from './types';

export * from './types';

export function sttProviderFor(config: Config): SttProvider | null {
  switch (config.CAL_STT_PROVIDER) {
    case 'fake':
      return new FakeSttProvider();
    case 'elevenlabs':
      return config.ELEVENLABS_API_KEY ? new ElevenLabsSttProvider(config.ELEVENLABS_API_KEY) : null;
    case 'openai':
      return config.OPENAI_API_KEY ? new OpenAiSttProvider(config.OPENAI_API_KEY) : null;
  }
}

function uncachedTtsProviderFor(config: Config): TtsProvider | null {
  switch (config.CAL_TTS_PROVIDER) {
    case 'fake':
      return new FakeTtsProvider();
    case 'elevenlabs':
      return config.ELEVENLABS_API_KEY ? new ElevenLabsTtsProvider(config.ELEVENLABS_API_KEY, config.ELEVENLABS_VOICE_ID) : null;
    case 'openai':
      return config.OPENAI_API_KEY ? new OpenAiTtsProvider(config.OPENAI_API_KEY) : null;
  }
}

/** One provider per server (the voice route asks on every connection), so the cache's pruning clock is shared. */
const ttsProviders = new WeakMap<Config, TtsProvider | null>();

/** The server's text-to-speech, behind the spoken-reply cache unless CAL_TTS_CACHE_MB is 0 (D223). */
export function ttsProviderFor(config: Config): TtsProvider | null {
  if (ttsProviders.has(config)) return ttsProviders.get(config)!;
  const inner = uncachedTtsProviderFor(config);
  const provider =
    inner && config.CAL_TTS_CACHE_MB > 0
      ? new CachedTtsProvider(inner, path.join(config.dataDir, 'derived', 'tts-cache'), {
          maxBytes: config.CAL_TTS_CACHE_MB * 1024 * 1024,
          maxAgeMs: config.CAL_TTS_CACHE_DAYS * 86_400_000,
          calVoiceId: config.CAL_TTS_PROVIDER === 'elevenlabs' ? config.ELEVENLABS_VOICE_ID : config.CAL_TTS_PROVIDER,
        })
      : inner;
  ttsProviders.set(config, provider);
  return provider;
}
