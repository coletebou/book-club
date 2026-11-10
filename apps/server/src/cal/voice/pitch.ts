/**
 * A voice's median pitch (fundamental frequency), for choosing which of Voice Design's previews
 * sounds most like the narrator (D223): one number, measured the same way on the narration and on
 * each preview, so what is compared is like for like. Autocorrelation over 40 ms frames of mono
 * 16-bit PCM, the louder half of the frames only (speech, not the pauses between it), each frame
 * kept only when its periodicity is clear (a correlation of at least 0.6).
 */
export interface Pitch {
  readonly medianHz: number;
  readonly p25Hz: number;
  readonly p75Hz: number;
  readonly voicedFrames: number;
}

const FLOOR_HZ = 60;
const CEIL_HZ = 400;
const CLEAR = 0.6;
/** Fewer voiced frames than this (about two seconds of speech) say too little. */
const MIN_VOICED = 50;

export function medianPitch(pcm: Int16Array, sampleRate: number): Pitch | null {
  const frame = Math.round(sampleRate * 0.04);
  const hop = frame >> 1;
  const minLag = Math.floor(sampleRate / CEIL_HZ);
  const maxLag = Math.ceil(sampleRate / FLOOR_HZ);
  const starts: number[] = [];
  const energies: number[] = [];
  for (let i = 0; i + frame + maxLag < pcm.length; i += hop) {
    let e = 0;
    for (let j = 0; j < frame; j++) e += pcm[i + j]! * pcm[i + j]!;
    starts.push(i);
    energies.push(e);
  }
  if (starts.length === 0) return null;
  const gate = [...energies].sort((a, b) => a - b)[Math.floor(energies.length / 2)]!;
  const pitches: number[] = [];
  for (let k = 0; k < starts.length; k++) {
    if (energies[k]! <= gate || energies[k] === 0) continue;
    const i = starts[k]!;
    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      let e1 = 0;
      for (let j = 0; j < frame; j++) {
        c += pcm[i + j]! * pcm[i + j + lag]!;
        e1 += pcm[i + j + lag]! * pcm[i + j + lag]!;
      }
      const r = c / Math.sqrt(energies[k]! * e1 + 1);
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    if (best >= CLEAR && bestLag > 0) pitches.push(sampleRate / bestLag);
  }
  if (pitches.length < MIN_VOICED) return null;
  pitches.sort((a, b) => a - b);
  const at = (q: number) => Math.round(pitches[Math.floor((pitches.length - 1) * q)]!);
  return { medianHz: at(0.5), p25Hz: at(0.25), p75Hz: at(0.75), voicedFrames: pitches.length };
}

/** How far apart two pitches are, in semitones (what the ear hears), never negative. */
export function semitonesApart(a: number, b: number): number {
  return Math.abs(12 * Math.log2(a / b));
}
