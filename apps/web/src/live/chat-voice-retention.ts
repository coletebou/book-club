import { createContext } from 'react';

export const ChatVoiceRetention = createContext<{
  readonly retain: (clipId: string, messageId: string, playing: boolean) => void;
  readonly positions: Map<string, number>;
} | null>(null);
