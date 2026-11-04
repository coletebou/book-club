import { type Config } from '../../config';
import { ElevenLabsSttProvider, ElevenLabsTtsProvider } from './elevenlabs';
import { FakeSttProvider, FakeTtsProvider } from './fake';
import { OpenAiSttProvider, OpenAiTtsProvider } from './openai';
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

export function ttsProviderFor(config: Config): TtsProvider | null {
  switch (config.CAL_TTS_PROVIDER) {
    case 'fake':
      return new FakeTtsProvider();
    case 'elevenlabs':
      return config.ELEVENLABS_API_KEY ? new ElevenLabsTtsProvider(config.ELEVENLABS_API_KEY, config.ELEVENLABS_VOICE_ID) : null;
    case 'openai':
      return config.OPENAI_API_KEY ? new OpenAiTtsProvider(config.OPENAI_API_KEY) : null;
  }
}
