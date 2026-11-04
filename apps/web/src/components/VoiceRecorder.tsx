import { useEffect, useMemo, useRef, useState } from 'react';
import { LIMITS } from '@bookclub/shared';
import { pickVoiceMimeType, supportsVoiceRecording } from '../lib/media-capture';
import { usePauseAudiobookWhile } from '../player/pauseWhile';
import { Icon } from './Icon';

type RecordState = 'idle' | 'recording' | 'paused' | 'preview';

function formatSeconds(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Record a voice note in the browser (D140): a level meter while recording, pause and resume,
 * re-record, and a preview before it is attached. The audiobook (if playing) pauses while this
 * is live or its preview plays, and resumes after (player/pauseWhile.ts).
 */
export function VoiceRecorder({ onUse, onCancel }: { onUse: (blob: Blob, mimeType: string, durationMs: number) => void; onCancel: () => void }) {
  const [state, setState] = useState<RecordState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const mimeTypeRef = useRef<string>('');
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  // The wall-clock moment "elapsed 0" would have been, so elapsed time is Date.now() minus this
  // (re-anchored on resume to account for the gap while paused: see resume()).
  const startedAtRef = useRef(0);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  usePauseAudiobookWhile(state === 'recording' || state === 'paused' || previewPlaying);

  const stopMeter = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  const teardown = () => {
    stopMeter();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
  };

  // Unmount only: stop the microphone and close the audio context, whatever was reached.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => teardown(), []);

  const meter = () => {
    // The elapsed-time clock runs regardless; the level itself needs an analyser (not every
    // stream can be wired to one, start()'s own try/catch), and stays at 0 without one.
    const analyser = analyserRef.current;
    if (analyser) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += (v - 128) ** 2;
      setLevel(Math.min(1, Math.sqrt(sum / data.length) / 48));
    }
    setElapsedMs(Date.now() - startedAtRef.current);
    rafRef.current = requestAnimationFrame(meter);
  };

  const start = async () => {
    setError(null);
    if (!supportsVoiceRecording()) {
      setError('This browser cannot record audio.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // The level meter is a nicety: a stream the AnalyserNode cannot be wired to (a fake device,
      // an odd browser) must not stop the recording itself from working.
      try {
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analyserRef.current = analyser;
      } catch {
        audioCtxRef.current = null;
        analyserRef.current = null;
      }
      const mimeType = pickVoiceMimeType();
      mimeTypeRef.current = mimeType ?? '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const made = new Blob(chunksRef.current, { type: mimeTypeRef.current || recorder.mimeType || 'audio/webm' });
        setBlob(made);
        setState('preview');
        teardown();
      };
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      recorder.start();
      setState('recording');
      setElapsedMs(0);
      meter();
    } catch {
      setError('Could not reach the microphone. Check its permission and try again.');
      teardown();
    }
  };

  // Stops itself at the limit, so nobody discovers it the hard way (a failed upload after five minutes).
  useEffect(() => {
    if (state === 'recording' && elapsedMs >= LIMITS.voiceNoteSeconds * 1000) recorderRef.current?.stop();
  }, [state, elapsedMs]);

  const pause = () => {
    recorderRef.current?.pause();
    setState('paused');
    stopMeter();
  };
  const resume = () => {
    const resumedAt = Date.now();
    recorderRef.current?.resume();
    setState('recording');
    startedAtRef.current = resumedAt - elapsedMs;
    meter();
  };
  const stop = () => recorderRef.current?.stop();
  const reRecord = () => {
    setBlob(null);
    setElapsedMs(0);
    setState('idle');
  };

  const remaining = Math.max(0, LIMITS.voiceNoteSeconds * 1000 - elapsedMs);
  const previewUrl = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  return (
    <div className="voice-recorder" data-testid="voice-recorder" data-state={state}>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {state === 'idle' ? (
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => void start()} data-testid="voice-record-start">
            <Icon name="mic" size={18} /> Record a voice note
          </button>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : null}
      {state === 'recording' || state === 'paused' ? (
        <div className="voice-recording">
          <div className="level-meter" role="img" aria-label="Recording level">
            <span className="level-bar" style={{ transform: `scaleY(${0.1 + level * 0.9})` }} />
          </div>
          <time className="voice-elapsed" data-testid="voice-elapsed">
            {formatSeconds(elapsedMs)} · {formatSeconds(remaining)} left
          </time>
          <div className="row">
            {state === 'recording' ? (
              <button type="button" className="btn btn-ghost" onClick={pause} data-testid="voice-pause">
                <Icon name="pause" size={16} /> Pause
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={resume} data-testid="voice-resume">
                <Icon name="play" size={16} /> Resume
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={stop} data-testid="voice-stop">
              <Icon name="stop" size={16} /> Stop
            </button>
          </div>
        </div>
      ) : null}
      {state === 'preview' && blob && previewUrl ? (
        <div className="voice-preview">
          <audio
            ref={audioElRef}
            controls
            src={previewUrl}
            data-testid="voice-preview-player"
            onPlay={() => setPreviewPlaying(true)}
            onPause={() => setPreviewPlaying(false)}
            onEnded={() => setPreviewPlaying(false)}
          />
          <div className="row">
            <button type="button" className="btn btn-ghost" onClick={reRecord} data-testid="voice-rerecord">
              <Icon name="redo" size={16} /> Re-record
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onUse(blob, mimeTypeRef.current || blob.type, elapsedMs)} data-testid="voice-use">
              Use this recording
            </button>
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
