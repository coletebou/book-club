/** A minimal, valid 8-bit PCM WAV of silence: real bytes the server's content-sniff accepts. */
export function stubRecorderScript() {
  return () => {
    function makeWavBlob(seconds: number, mimeType: string): Blob {
      const sampleRate = 8000;
      const numSamples = Math.floor(sampleRate * seconds);
      const buffer = new ArrayBuffer(44 + numSamples);
      const view = new DataView(buffer);
      const writeStr = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
      };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + numSamples, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate, true);
      view.setUint16(32, 1, true);
      view.setUint16(34, 8, true);
      writeStr(36, 'data');
      view.setUint32(40, numSamples, true);
      const bytes = new Uint8Array(buffer);
      for (let i = 44; i < bytes.length; i++) bytes[i] = 128;
      return new Blob([bytes], { type: mimeType });
    }
    class FakeMediaRecorder {
      stream: unknown;
      mimeType: string;
      state = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(stream: unknown, opts?: { mimeType?: string }) {
        this.stream = stream;
        this.mimeType = opts?.mimeType ?? 'audio/wav';
      }
      start() {
        this.state = 'recording';
      }
      pause() {
        this.state = 'paused';
      }
      resume() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: makeWavBlob(1, this.mimeType) });
        this.onstop?.();
      }
      static isTypeSupported() {
        return true;
      }
    }
    // @ts-expect-error test stub replacing the browser's own implementation
    window.MediaRecorder = FakeMediaRecorder;
    // Replacing `navigator.mediaDevices` wholesale (not just its `getUserMedia` property):
    // WebKit's own `mediaDevices` does not reliably keep a property assigned onto it, still
    // running its real (permission-checked, device-less) getUserMedia on the next access.
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ stop() {} }] }) as unknown as MediaStream,
      },
    });
  };
}
