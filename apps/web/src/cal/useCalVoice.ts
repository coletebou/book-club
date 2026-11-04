import { useCallback, useEffect, useRef, useState } from 'react';

export interface CalVoiceState {
  readonly supported: boolean;
  readonly recording: boolean;
  readonly speaking: boolean;
  /** Cal's spoken reply is playing (it starts once `speaking` ends, from the queued audio). */
  readonly replying: boolean;
  readonly transcript: string | null;
  readonly error: string | null;
  /**
   * A voice turn is under way (D183): from the moment the mic is asked for until Cal's reply has
   * been sent in full (or the turn failed, was talked over, or heard nothing). Its socket is bound
   * to one thread, so the panel keeps the thread fixed until it is over.
   */
  readonly busy: boolean;
  /** Start a turn; `inConversation` names the thread when it was only just created (D183), before a re-render has passed it in. */
  start(inConversation?: string): Promise<void>;
  stop(): void;
  bargeIn(): void;
}

/**
 * Push-to-talk voice with Cal over /ws/cal/voice (D160, D167): `start()` opens the mic and the
 * socket, `stop()` ends the turn (the server runs STT -> Claude -> TTS and streams audio chunks
 * back, which are queued and played in order), `bargeIn()` stops whatever Cal is saying so the
 * listener can talk over him. `onSpeakingChange` is for the reader/player to duck or pause an
 * audiobook while Cal talks (D169).
 */
export function useCalVoice(clubId: string, conversationId: string | null, onSpeakingChange?: (speaking: boolean) => void): CalVoiceState {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [replying, setReplying] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioQueue = useRef<Uint8Array[]>([]);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const replyUrlRef = useRef<string | null>(null);
  const disposed = useRef(false);
  const generation = useRef(0);

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

  useEffect(() => {
    disposed.current = false;
    const mountedGeneration = generation.current;
    return () => {
      disposed.current = true;
      generation.current = mountedGeneration + 1;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        if (recorder.state !== 'inactive') recorder.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      const socket = wsRef.current;
      wsRef.current = null;
      if (socket) {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        socket.close();
      }
      disposeReply();
    };
  }, [disposeReply]);

  const setSpeakingBoth = useCallback(
    (value: boolean) => {
      setSpeaking(value);
      onSpeakingChange?.(value);
    },
    [onSpeakingChange],
  );

  const playQueued = useCallback(() => {
    if (audioQueue.current.length === 0) return;
    const blob = new Blob(audioQueue.current as BlobPart[], { type: 'audio/mpeg' });
    audioQueue.current = [];
    disposeReply();
    const url = URL.createObjectURL(blob);
    replyUrlRef.current = url;
    const el = (playerRef.current ??= new Audio());
    el.src = url;
    const finished = () => {
      if (replyUrlRef.current !== url) return;
      URL.revokeObjectURL(url);
      replyUrlRef.current = null;
      if (!disposed.current) setReplying(false);
    };
    el.onended = finished;
    el.onerror = finished;
    setReplying(true);
    void el.play().catch(finished);
  }, [disposeReply]);

  const start = useCallback(async (inConversation?: string) => {
    const threadId = inConversation ?? conversationId;
    if (!threadId) {
      setError('Start a conversation with Cal first.');
      return;
    }
    if (disposed.current) return;
    const turnGeneration = generation.current;
    setError(null);
    setTranscript(null);
    setBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (disposed.current || generation.current !== turnGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/cal/voice?clubId=${clubId}&conversationId=${threadId}`);
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
        // The spoiler scope is not sent (D183): the server reads the standing setting each turn.
        ws.send(JSON.stringify({ type: 'start', mimeType }));
        const recorder = new MediaRecorder(stream, { mimeType });
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) void e.data.arrayBuffer().then((buf) => {
            if (!disposed.current && generation.current === turnGeneration && ws.readyState === WebSocket.OPEN) ws.send(buf);
          });
        };
        recorder.start(250);
        setRecording(true);
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          audioQueue.current.push(new Uint8Array(event.data as ArrayBuffer));
          return;
        }
        const msg = JSON.parse(event.data) as { type: string; text?: string; message?: string };
        if (msg.type === 'transcript') {
          setTranscript(msg.text ?? null);
          // Nothing heard: the server ends the turn there, with no reply to wait for.
          if (!(msg.text ?? '').trim()) setBusy(false);
        } else if (msg.type === 'speakingStart') setSpeakingBoth(true);
        else if (msg.type === 'speakingEnd') {
          setSpeakingBoth(false);
          setBusy(false);
          playQueued();
        } else if (msg.type === 'error') {
          audioQueue.current = [];
          setSpeakingBoth(false);
          setBusy(false);
          setError(msg.message ?? 'Cal had trouble with that.');
        }
      };
      ws.onerror = () => {
        audioQueue.current = [];
        setSpeakingBoth(false);
        setBusy(false);
        setError('Lost the connection to Cal.');
      };
      ws.onclose = () => {
        audioQueue.current = [];
        setSpeakingBoth(false);
        setBusy(false);
        setRecording(false);
        // A completed reply can keep playing after a normal socket close.
      };
    } catch {
      if (!disposed.current && generation.current === turnGeneration) {
        setBusy(false);
        setError('Could not use the microphone.');
      }
    }
  }, [clubId, conversationId, setSpeakingBoth, playQueued]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setRecording(false);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' }));
  }, []);

  const bargeIn = useCallback(() => {
    disposeReply();
    setReplying(false);
    setSpeakingBoth(false);
    setBusy(false);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'bargeIn' }));
  }, [setSpeakingBoth, disposeReply]);

  const supported = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  return { supported, recording, speaking, replying, transcript, error, busy, start, stop, bargeIn };
}
