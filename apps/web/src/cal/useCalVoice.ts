import { useCallback, useEffect, useRef, useState } from 'react';
import { CAL_HANDS_FREE_MAX_MS, CAL_HANDS_FREE_MAX_TURNS } from '@bookclub/shared';
import { pickVoiceMimeType, stopCaptureOnCarPlay, stopCaptureWhenHidden, supportsVoiceRecording } from '../lib/media-capture';
import { listeningCaptureAllowed, useListeningCaptureAllowed } from '../player/native-bridge';

// The server's WebSocket payload limit applies to each message, even within one voice turn.
const CAL_VOICE_FRAME_BYTES = 64 * 1024;
const REPLY_SETTLE_MS = 500;
const HANDS_FREE_LIMIT = 'Hands-free listening ended. Tap Talk hands-free to start again.';

/**
 * Whose voice Cal's reply is spoken in (D223), as the server's `speakingStart` says: his own, or
 * the conversation's book's narrator's: (a) the narration's own voice, (c) a clone the narrator
 * agreed to, or (b) one designed to match them.
 */
export type ReplyVoice =
  | { readonly kind: 'cal' }
  | {
      readonly kind: 'narrator';
      readonly narrator: string;
      readonly source: 'narration' | 'clone' | 'designed';
      /** The server's correction for the narrator's pace, played on top of the listener's own speed (absent: 1). */
      readonly rate?: number;
    };

export type CalVoiceMode = 'push-to-talk' | 'hands-free';

export interface CalVoiceOptions {
  /** Save any pending book progress before the server uses it to fence the answer. */
  readonly beforeTurn?: () => Promise<void>;
  readonly onTurnDone?: (conversationId: string) => void;

  /**
   * The rate a reply in this voice plays at: a narrator's voice at the listener's own speed for
   * that audiobook, so the answer keeps the pace they were hearing (D223). 1 when absent.
   */
  readonly replyRate?: (voice: ReplyVoice) => number;
}

export interface CalVoiceState {
  readonly supported: boolean;
  readonly handsFreeSupported: boolean;
  readonly handsFree: boolean;
  readonly recording: boolean;
  readonly speaking: boolean;
  /** Cal's spoken reply is playing (it starts once `speaking` ends, from the queued audio). */
  readonly replying: boolean;
  readonly transcript: string | null;
  /** The voice of the reply on its way or playing; null before the first reply of a turn. */
  readonly replyVoice: ReplyVoice | null;
  readonly error: string | null;
  /**
   * A voice turn is under way (D183): from the moment the mic is asked for until Cal's reply has
   * been sent in full (or the turn failed, was talked over, or heard nothing). Its socket is bound
   * to one thread, so the panel keeps the thread fixed until it is over.
   */
  readonly busy: boolean;
  /** Start a turn; `inConversation` names the thread when it was only just created (D183), before a re-render has passed it in. */
  start(inConversation?: string, mode?: CalVoiceMode): Promise<void>;
  stop(): void;
  cancel(): void;
  bargeIn(): void;
}

/**
 * Voice with Cal over /ws/cal/voice. `stop()` ends a push-to-talk recording (D160, D167).
 * In hands-free mode, local silence detection ends each recording and the microphone reopens
 * after the spoken reply finishes (D273). `cancel()` ends the session and releases its audio.
 */
export function useCalVoice(clubId: string, conversationId: string | null, onSpeakingChange?: (speaking: boolean) => void, options: CalVoiceOptions = {}): CalVoiceState {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [replying, setReplying] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [replyVoice, setReplyVoice] = useState<ReplyVoice | null>(null);
  const replyVoiceRef = useRef<ReplyVoice | null>(null);
  const replyMimeType = useRef('audio/mpeg');
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const modeRef = useRef<CalVoiceMode>('push-to-talk');
  const interrupting = useRef(false);
  const finishRecording = useRef<(() => void) | null>(null);
  const stopMeter = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioQueue = useRef<Uint8Array[]>([]);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const replyUrlRef = useRef<string | null>(null);
  const disposed = useRef(false);
  const generation = useRef(0);
  const limitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearTimers = useCallback(() => {
    clearTimeout(limitTimer.current);
    clearTimeout(settleTimer.current);
  }, []);

  const disposeReply = useCallback(() => {
    const player = playerRef.current;
    if (player) {
      player.onended = null;
      player.onerror = null;
      player.pause();
      player.removeAttribute?.('src');
      playerRef.current = null;
    }
    if (replyUrlRef.current) URL.revokeObjectURL(replyUrlRef.current);
    replyUrlRef.current = null;
    audioQueue.current = [];
  }, []);

  const releaseMic = useCallback(() => {
    stopMeter.current?.();
    stopMeter.current = null;
    finishRecording.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const disposeSession = useCallback(() => {
    generation.current += 1;
    clearTimers();
    interrupting.current = false;
    releaseMic();
    const socket = wsRef.current;
    wsRef.current = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    disposeReply();
  }, [clearTimers, disposeReply, releaseMic]);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      disposeSession();
    };
  }, [disposeSession]);

  const setSpeakingBoth = useCallback(
    (value: boolean) => {
      setSpeaking(value);
      onSpeakingChange?.(value);
    },
    [onSpeakingChange],
  );

  const resetSession = useCallback(() => {
    disposeSession();
    setRecording(false);
    setBusy(false);
    setHandsFree(false);
    setSpeakingBoth(false);
    setReplying(false);
  }, [disposeSession, setSpeakingBoth]);

  // D243: a car connection can interrupt permission, recording or a reply already in flight.
  useEffect(() => stopCaptureOnCarPlay(resetSession), [resetSession]);

  useEffect(() => stopCaptureWhenHidden(resetSession), [resetSession]);

  const playQueued = useCallback((onFinished: (played: boolean) => void) => {
    if (audioQueue.current.length === 0) return;
    const blob = new Blob(audioQueue.current as BlobPart[], { type: replyMimeType.current });
    audioQueue.current = [];
    disposeReply();
    const url = URL.createObjectURL(blob);
    replyUrlRef.current = url;
    const el = (playerRef.current ??= new Audio());
    el.src = url;
    // Set after src (a new source resets the rate to its default), pitch kept as the narrator's.
    const voice = replyVoiceRef.current ?? { kind: 'cal' };
    const rate = optionsRef.current.replyRate?.(voice) ?? 1;
    el.preservesPitch = true;
    el.playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const finished = (played: boolean) => {
      if (replyUrlRef.current !== url) return;
      URL.revokeObjectURL(url);
      replyUrlRef.current = null;
      if (!disposed.current) {
        setReplying(false);
        onFinished(played);
      }
    };
    el.onended = () => finished(true);
    el.onerror = () => finished(false);
    setReplying(true);
    void el.play().catch(() => finished(false));
  }, [disposeReply]);

  const start = useCallback(async (inConversation?: string, mode: CalVoiceMode = 'push-to-talk') => {
    if (!listeningCaptureAllowed() || document.hidden) return;
    const threadId = inConversation ?? conversationId;
    if (!threadId) {
      setError('Start a conversation with Cal first.');
      return;
    }
    if (disposed.current) return;
    resetSession();
    const turnGeneration = generation.current;
    const continuous = mode === 'hands-free';
    const deadline = Date.now() + CAL_HANDS_FREE_MAX_MS;
    let turns = 0;
    modeRef.current = mode;
    setHandsFree(continuous);
    setError(null);
    setTranscript(null);
    setReplyVoice(null);
    replyVoiceRef.current = null;
    replyMimeType.current = 'audio/mpeg';
    setBusy(true);

    const current = () => !disposed.current && generation.current === turnGeneration && listeningCaptureAllowed() && !document.hidden;
    const fail = (message: string) => {
      if (!current()) return;
      resetSession();
      setError(message);
    };
    if (continuous) limitTimer.current = setTimeout(() => fail(HANDS_FREE_LIMIT), CAL_HANDS_FREE_MAX_MS);
    const withinTime = () => {
      if (!continuous || Date.now() < deadline) return true;
      fail(HANDS_FREE_LIMIT);
      return false;
    };
    const openMicrophone = async () => {
      if (!current() || !withinTime()) return null;
      const audio = continuous ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      if (!current() || !withinTime()) {
        stream.getTracks().forEach((track) => track.stop());
        return null;
      }
      streamRef.current = stream;
      return stream;
    };

    try {
      const watchSpeechEnd = continuous ? (await import('./speech-end')).watchSpeechEnd : undefined;
      const stream = await openMicrophone();
      if (!stream || !current()) return;
      const params = new URLSearchParams({ clubId, conversationId: threadId });
      const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/cal/voice?${params}`);
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';
      let turnDone = false;
      let replyFailed = false;
      let serverLimited = false;
      let reopening = false;

      const record = (input: MediaStream) => {
        if (!current() || !withinTime()) {
          if (generation.current === turnGeneration && !listeningCaptureAllowed()) resetSession();
          return;
        }
        try {
          const mimeType = pickVoiceMimeType();
          const recorder = new MediaRecorder(input, mimeType ? { mimeType } : undefined);
          recorderRef.current = recorder;
          const type = recorder.mimeType || mimeType || 'audio/webm';
          const startMessage = JSON.stringify({ type: 'start', mimeType: type, handsFree: continuous });
          const audio: Blob[] = [];
          let finished = false;
          const live = () => current() && ws.readyState === WebSocket.OPEN;
          const sendAudio = (clip: Blob) => {
            for (let offset = 0; offset < clip.size; offset += CAL_VOICE_FRAME_BYTES) {
              ws.send(clip.slice(offset, offset + CAL_VOICE_FRAME_BYTES));
            }
          };
          if (!continuous) ws.send(startMessage);
          recorder.ondataavailable = ({ data }) => {
            if (!data.size || !live()) return;
            if (continuous) audio.push(data);
            else sendAudio(data);
          };
          recorder.onerror = () => fail('Recording stopped. Try speaking to Cal again.');
          recorder.onstop = () => {
            releaseMic();
            setRecording(false);
            if (!live()) return;
            if (!finished) {
              fail('The microphone stopped. Try speaking to Cal again.');
              return;
            }
            void (async () => {
              await optionsRef.current.beforeTurn?.();
              if (!live() || !withinTime()) return;
              if (continuous) {
                turns += 1;
                ws.send(startMessage);
                for (const chunk of audio) sendAudio(chunk);
              }
              ws.send(JSON.stringify({ type: 'end' }));
            })().catch(() => fail('Could not save your place before asking Cal. Try again.'));
          };
          const finish = () => {
            if (!finishRecording.current) return;
            finished = true;
            finishRecording.current = null;
            stopMeter.current?.();
            stopMeter.current = null;
            setRecording(false);
            recorder.stop();
          };
          finishRecording.current = finish;
          recorder.start(continuous ? undefined : 250);
          setRecording(true);
          if (watchSpeechEnd) stopMeter.current = watchSpeechEnd(input, (heard) => {
            if (heard) finish();
            else fail('Cal did not hear a question.');
          });
        } catch {
          fail('Could not start the microphone.');
        }
      };
      const reopen = () => {
        if (!continuous || !turnDone || reopening || replyUrlRef.current !== null || !current() || ws.readyState !== WebSocket.OPEN) return;
        if (serverLimited || turns >= CAL_HANDS_FREE_MAX_TURNS) {
          fail(HANDS_FREE_LIMIT);
          return;
        }
        if (replyFailed) {
          fail('Cal’s answer could not play. You can read it in this chat.');
          return;
        }
        if (streamRef.current) return;
        turnDone = false;
        reopening = true;
        setTranscript(null);
        settleTimer.current = setTimeout(() => {
          if (!current() || ws.readyState !== WebSocket.OPEN) return;
          void openMicrophone().then((input) => {
            if (input) record(input);
          }).catch(() => fail('Could not reopen the microphone.')).finally(() => { reopening = false; });
        }, REPLY_SETTLE_MS);
      };

      ws.onopen = () => record(stream);
      ws.onmessage = (event) => {
        if (!current()) return;
        if (typeof event.data !== 'string') {
          if (!interrupting.current) audioQueue.current.push(new Uint8Array(event.data as ArrayBuffer));
          return;
        }
        const msg = JSON.parse(event.data) as { type: string; text?: string; message?: string; voice?: ReplyVoice; mimeType?: string; outcome?: string; limitReached?: boolean };
        if (msg.type === 'transcript') {
          setTranscript(msg.text ?? null);
          if (!continuous && !(msg.text ?? '').trim()) setBusy(false);
        } else if (msg.type === 'speakingStart' && !interrupting.current) {
          const voice: ReplyVoice = msg.voice?.kind === 'narrator' ? msg.voice : { kind: 'cal' };
          replyVoiceRef.current = voice;
          replyMimeType.current = msg.mimeType ?? 'audio/mpeg';
          setReplyVoice(voice);
          setSpeakingBoth(true);
        } else if (msg.type === 'speakingEnd') {
          setSpeakingBoth(false);
          if (!continuous) setBusy(false);
          if (!interrupting.current) playQueued((played) => {
            replyFailed = !played;
            reopen();
          });
        } else if (msg.type === 'turnDone') {
          if (continuous && msg.outcome === 'answered') optionsRef.current.onTurnDone?.(threadId);
          // A reply can finish in flight just before the server acknowledges an interruption.
          if (interrupting.current && msg.outcome !== 'aborted') return;
          interrupting.current = false;
          if (msg.outcome === 'stopped') {
            resetSession();
            setTranscript(null);
            return;
          }
          if (!continuous) setBusy(false);
          turnDone = true;
          serverLimited = msg.limitReached === true;
          reopen();
        } else if (msg.type === 'error') {
          fail(msg.message ?? 'Cal had trouble with that.');
        }
      };
      ws.onerror = () => fail('Lost the connection to Cal.');
      ws.onclose = ({ code }) => {
        if (!current()) return;
        if (code === 4001 || code === 4003 || code === 4010) {
          fail(code === 4010 ? HANDS_FREE_LIMIT : code === 4001 ? 'Sign in again to talk to Cal.' : 'Voice access ended. Check your club membership or Cal AI access.');
          return;
        }
        // A permission result from a pending follow-up must not open a recorder on a closed socket.
        generation.current += 1;
        clearTimers();
        wsRef.current = null;
        releaseMic();
        audioQueue.current = [];
        setSpeakingBoth(false);
        setBusy(false);
        setRecording(false);
        setHandsFree(false);
        // The audio already queued for a completed answer can keep playing after a normal close.
      };
    } catch {
      fail('Could not use the microphone.');
    }
  }, [clubId, conversationId, setSpeakingBoth, playQueued, resetSession, releaseMic, clearTimers]);

  const stop = useCallback(() => {
    if (!listeningCaptureAllowed()) {
      resetSession();
      return;
    }
    finishRecording.current?.();
  }, [resetSession]);

  const bargeIn = useCallback(() => {
    interrupting.current = true;
    disposeReply();
    setReplying(false);
    setSpeakingBoth(false);
    setBusy(modeRef.current === 'hands-free');
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'bargeIn' }));
  }, [setSpeakingBoth, disposeReply]);

  const captureAllowed = useListeningCaptureAllowed();
  const supported = captureAllowed && supportsVoiceRecording();
  const handsFreeSupported = supported && typeof AudioContext === 'function';
  return { supported, handsFreeSupported, handsFree, recording, speaking, replying, transcript, replyVoice, error, busy, start, stop, cancel: resetSession, bargeIn };
}
