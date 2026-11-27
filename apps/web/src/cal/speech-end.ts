const SAMPLE_MS = 50;
const SPEECH_LEVEL = 0.02;
const MIN_SPEECH_MS = 150;
const END_SILENCE_MS = 1000;
const IDLE_MS = 12_000;
const MAX_TURN_MS = 25_000;

/** D272: decide the turn locally. Silences and room audio between turns stay on the device. */
export function watchSpeechEnd(stream: MediaStream, finish: (heard: boolean) => void): () => void {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  try {
    context.createMediaStreamSource(stream).connect(analyser);
  } catch (err) {
    void context.close().catch(() => {});
    throw err;
  }
  void context.resume().catch(() => {});

  const samples = new Float32Array(analyser.fftSize);
  const began = performance.now();
  let voiceBegan: number | null = null;
  let lastVoice: number | null = null;

  const timer = setInterval(() => {
    const now = performance.now();
    analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    if (Math.sqrt(energy / samples.length) >= SPEECH_LEVEL) {
      voiceBegan ??= now;
      if (now - voiceBegan >= MIN_SPEECH_MS) lastVoice = now;
    } else {
      voiceBegan = null;
    }

    if (lastVoice !== null && now - lastVoice >= END_SILENCE_MS) {
      finish(true);
    } else if (now - began >= (lastVoice === null ? IDLE_MS : MAX_TURN_MS)) {
      finish(lastVoice !== null);
    }
  }, SAMPLE_MS);

  return () => {
    clearInterval(timer);
    void context.close().catch(() => {});
  };
}
