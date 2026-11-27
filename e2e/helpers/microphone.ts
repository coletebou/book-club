import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type Page } from '@playwright/test';
import { FIXTURES } from './api';

/** Linux WebKit cannot supply a microphone. Give the recorder valid WAV bytes; the upload is real. */
export async function useWebKitMicrophoneStandIn(page: Page) {
  await page.addInitScript((wav) => {
    class Recorder {
      readonly mimeType = 'audio/wav';
      state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array(wav)], { type: this.mimeType }) });
        this.onstop?.();
      }
      static isTypeSupported() { return false; }
    }
    // @ts-expect-error The stand-in implements the MediaRecorder behavior used by the composer.
    window.MediaRecorder = Recorder;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
  }, Array.from(readFileSync(path.join(FIXTURES, 'audio/voice-tone.wav'))));
}
