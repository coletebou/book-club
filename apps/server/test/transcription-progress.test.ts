import { describe, expect, it } from 'vitest';
import {
  FALLBACK_RTF,
  applyProgressDoc,
  etaMsOf,
  fractionOf,
  initialLive,
  lastRecogniserError,
  parseProgressDoc,
  parseProgressLine,
  toTranscriptionStatus,
} from '../src/services/transcription-progress';

describe('transcription progress', () => {
  it('parses a progress file and a PROGRESS stderr line', () => {
    const raw = JSON.stringify({
      format: 'bookclub-transcribe-progress/1',
      stage: 'transcribing_gpu',
      tracksDone: 1,
      tracksTotal: 4,
      audioMsDone: 60_000,
      audioMsTotal: 240_000,
      engine: 'gpu',
      startedAt: 1_700_000_000,
      updatedAt: 1_700_000_030,
    });
    expect(parseProgressDoc(raw)?.stage).toBe('transcribing_gpu');
    expect(parseProgressLine(`PROGRESS ${raw}`)?.tracksDone).toBe(1);
    expect(parseProgressLine('track 1/4: 12 words')).toBeNull();
    expect(parseProgressDoc('{"format":"nope"}')).toBeNull();
  });

  it('computes fraction from audio when present, else tracks', () => {
    expect(fractionOf({ audioMsDone: 30_000, audioMsTotal: 120_000, tracksDone: 0, tracksTotal: 4 })).toBe(0.25);
    expect(fractionOf({ audioMsDone: null, audioMsTotal: null, tracksDone: 1, tracksTotal: 4 })).toBe(0.25);
    expect(fractionOf({ audioMsDone: null, audioMsTotal: null, tracksDone: null, tracksTotal: null })).toBeNull();
  });

  it('ETA uses measured RTF once enough audio is heard, else the GPU/CPU fallback', () => {
    const startedAt = Date.now() - 60_000;
    const measured = initialLive({ tracksTotal: 2, audioMsTotal: 600_000, engine: 'gpu', now: startedAt });
    measured.stage = 'transcribing_gpu';
    measured.audioMsDone = 60_000;
    measured.startedAt = startedAt;
    const eta = etaMsOf(measured, startedAt + 60_000);
    expect(eta).toBeGreaterThan(500_000);
    expect(eta).toBeLessThan(600_000);

    const fresh = initialLive({ tracksTotal: 1, audioMsTotal: 3_600_000, engine: 'gpu' });
    fresh.stage = 'transcribing_gpu';
    expect(etaMsOf(fresh)).toBe(Math.round(3_600_000 * FALLBACK_RTF.gpu));

    const cpu = initialLive({ tracksTotal: 1, audioMsTotal: 3_600_000, engine: 'cpu' });
    cpu.stage = 'transcribing_cpu';
    expect(etaMsOf(cpu)).toBe(Math.round(3_600_000 * FALLBACK_RTF.cpu));
  });

  it('applyProgressDoc accepts unix seconds for startedAt', () => {
    const live = initialLive({ tracksTotal: 3, audioMsTotal: 1000 });
    applyProgressDoc(live, {
      format: 'bookclub-transcribe-progress/1',
      stage: 'transcribing_cpu',
      tracksDone: 2,
      audioMsDone: 500,
      startedAt: 1_700_000_000,
      engine: 'cpu',
    });
    expect(live.stage).toBe('transcribing_cpu');
    expect(live.tracksDone).toBe(2);
    expect(live.startedAt).toBe(1_700_000_000_000);
    const view = toTranscriptionStatus(live);
    expect(view.fraction).toBe(0.5);
    expect(view.updatedAt).toEqual(expect.any(String));
  });

  it('takes the last non-PROGRESS stderr line as the recogniser error', () => {
    const progress = 'PROGRESS {"format":"bookclub-transcribe-progress/1","stage":"transcribing_cpu"}';
    expect(lastRecogniserError(`${progress}\ncannot make sense of this file\n${progress}\n`)).toBe(
      'cannot make sense of this file',
    );
    expect(lastRecogniserError(`${progress}\n${progress}\n`)).toBe('');
    expect(lastRecogniserError('boom')).toBe('boom');
    expect(lastRecogniserError('')).toBe('');
  });
});
