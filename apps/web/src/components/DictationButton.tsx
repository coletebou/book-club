import { useQuery } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { api } from '../lib/api';
import { calApi } from '../lib/cal-api';
import { pickVoiceMimeType, suggestedFilename, supportsVoiceRecording } from '../lib/media-capture';
import { usePauseAudiobookWhile } from '../player/pauseWhile';
import { Icon } from './Icon';
import { useToast } from './Toasts';

const RECORDING_MS = 25_000;
type Phase = 'idle' | 'opening' | 'recording' | 'transcribing';

/** Turn a short clip into draft text (D233). The surrounding composer decides where it goes. */
export function DictationButton({ clubId, userId, disabled = false, onText, onActiveChange }: {
  clubId: string;
  userId: string;
  disabled?: boolean;
  onText: (text: string) => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const supported = supportsVoiceRecording();
  const status = useQuery({ queryKey: ['cal-status', clubId], queryFn: () => calApi.status(clubId), enabled: supported, staleTime: 60_000 });
  const toast = useToast();
  const [session, setSession] = useState<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const finish = useRef<(() => void) | null>(null);
  const insert = useEffectEvent(onText);
  const notify = useEffectEvent((active: boolean) => onActiveChange?.(active));
  const showError = useEffectEvent((message: string) => toast.show(message, 'error'));

  usePauseAudiobookWhile(phase === 'opening' || phase === 'recording');

  useEffect(() => {
    if (!session) return;
    const { signal } = session;
    notify(true);
    let stream: MediaStream | undefined;
    let recorder: MediaRecorder | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Blob[] = [];

    const reset = () => {
      setPhase('idle');
      setSession(null);
    };
    const releaseMic = () => {
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      stream = undefined;
    };
    const fail = (message: string) => {
      if (signal.aborted) return;
      // A terminal recorder error can be followed immediately by dataavailable and stop.
      session.abort();
      releaseMic();
      showError(message);
      reset();
    };
    const sendClip = async (clip: Blob) => {
      if (signal.aborted) return;
      if (!clip.size) {
        fail('No speech was recorded. Try again.');
        return;
      }
      setPhase('transcribing');
      try {
        const { text } = await api.dictate(clubId, clip, suggestedFilename('voice', clip.type), signal, userId);
        if (signal.aborted) return;
        if (text) insert(text);
        else showError('No speech was heard. Try again.');
        reset();
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Could not transcribe that recording.');
      }
    };
    const open = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (signal.aborted) {
          releaseMic();
          return;
        }
        const mimeType = pickVoiceMimeType();
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorder.ondataavailable = ({ data }) => {
          if (data.size) chunks.push(data);
        };
        recorder.onerror = () => fail('The recording stopped early. Try again.');
        recorder.onstop = () => {
          releaseMic();
          void sendClip(new Blob(chunks, { type: recorder?.mimeType || chunks[0]?.type || mimeType }));
        };
        const stop = () => {
          if (recorder?.state === 'recording') recorder.stop();
        };
        finish.current = stop;
        recorder.start();
        setPhase('recording');
        timer = setTimeout(stop, RECORDING_MS);
      } catch {
        releaseMic();
        fail('Could not start recording. Check your microphone permission and try again.');
      }
    };
    void open();

    return () => {
      session.abort();
      finish.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== 'inactive') recorder.stop();
      }
      releaseMic();
      notify(false);
    };
  }, [clubId, session, userId]);

  if (phase === 'idle' && (!supported || status.data?.dictation !== true)) return null;

  const label = {
    idle: 'Dictate',
    opening: 'Cancel microphone request',
    recording: 'Finish dictation',
    transcribing: 'Cancel transcription',
  }[phase];

  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label={label}
        title={label}
        data-testid="dictation"
        data-phase={phase}
        disabled={phase === 'idle' && disabled}
        onClick={() => {
          if (phase === 'idle') {
            setPhase('opening');
            setSession(new AbortController());
          } else if (phase === 'recording') {
            finish.current?.();
          } else {
            session?.abort();
            setPhase('idle');
            setSession(null);
          }
        }}
      >
        {phase === 'transcribing' ? <span className="spinner" aria-hidden="true" /> : <Icon name={phase === 'recording' ? 'stop' : 'mic'} size={20} />}
      </button>
      <span className="visually-hidden" role="status">
        {phase === 'recording' ? 'Recording dictation' : phase === 'transcribing' ? 'Transcribing' : ''}
      </span>
    </>
  );
}
