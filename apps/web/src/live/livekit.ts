import { type LocalAudioTrack, ParticipantEvent, Room, RoomEvent, Track } from 'livekit-client';
import { stopCaptureOnCarPlay } from '../lib/media-capture';
import { listeningCaptureAllowed } from '../player/native-bridge';

/**
 * The LiveKit room, wrapped down to what Book Club needs (D153): join, mute, deafen, push-to-talk,
 * speaking. Echo cancellation and noise suppression are requested on every published microphone
 * track (D158's sharpest limit: they cancel a device's own output in its own mic, not a second
 * device's speakers picked up by a third's mic — earbuds are the real fix for that, documented in
 * autopause.ts). Remote audio is attached to real `<audio>` elements kept here (LiveKit does not
 * attach by itself), so "deafen" is simply muting them.
 */

const AUDIO_CAPTURE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export interface VoiceHandle {
  readonly room: Room;
  setMuted(muted: boolean): Promise<void>;
  setDeafened(deafened: boolean): void;
  /** While held: unmuted; released: muted again. For a push-to-talk key or a hold-to-talk button. */
  setPushToTalk(active: boolean): Promise<void>;
  disconnect(): Promise<void>;
  /** This device's own mic crossing LiveKit's speaking threshold (never anyone else's, D158). */
  onLocalSpeaking(cb: (speaking: boolean) => void): () => void;
  /** Anyone else in the room currently speaking (for ducking the audiobook, D155). */
  onRemoteSpeaking(cb: (speaking: boolean) => void): () => void;
}

export async function connectVoice(url: string, token: string, onDisconnect: (room: Room) => void): Promise<VoiceHandle> {
  const room = new Room({ adaptiveStream: true, dynacast: true });
  const elements = new Map<string, HTMLAudioElement>();
  let deafened = false;
  let closed = false;
  let microphone: MediaStreamTrack | undefined;
  const canCapture = () => !closed && listeningCaptureAllowed();
  const close = () => {
    if (closed) return false;
    closed = true;
    unwatchCar();
    microphone?.removeEventListener('ended', endVoice);
    microphone?.stop();
    for (const el of elements.values()) el.remove();
    elements.clear();
    onDisconnect(room);
    return true;
  };
  const disconnect = async () => {
    if (close()) await room.disconnect();
  };
  const endVoice = () => { void disconnect().catch(() => {}); };
  const unwatchCar = stopCaptureOnCarPlay(endVoice);
  room.on(RoomEvent.Disconnected, close);

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (closed || track.kind !== Track.Kind.Audio) return;
    const el = track.attach();
    el.muted = deafened;
    elements.set(`${participant.identity}:${publication.trackSid}`, el);
  });
  room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    const key = `${participant.identity}:${publication.trackSid}`;
    elements.get(key)?.remove();
    elements.delete(key);
    track.detach();
  });

  const remoteListeners = new Set<(speaking: boolean) => void>();
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const remoteSpeaking = speakers.some((p) => p.identity !== room.localParticipant.identity);
    for (const cb of remoteListeners) cb(remoteSpeaking);
  });

  const captureError = () => new Error('Voice is unavailable while CarPlay may be connected.');
  let audioTrack: LocalAudioTrack;
  try {
    if (!canCapture()) throw captureError();
    await room.connect(url, token);
    if (!canCapture()) throw captureError();

    // D243: own the microphone directly so neither a delayed permission result nor a LiveKit
    // reconnect or unmute can reacquire it after the car has connected.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CAPTURE });
    [microphone] = stream.getAudioTracks();
    if (!canCapture() || !microphone) {
      for (const track of stream.getTracks()) track.stop();
      if (!canCapture()) throw captureError();
      throw new Error('The microphone did not provide an audio track.');
    }
    microphone.addEventListener('ended', endVoice);
    const publication = await room.localParticipant.publishTrack(microphone, { source: Track.Source.Microphone });
    if (!canCapture()) throw captureError();
    if (!publication.audioTrack) throw new Error('Could not publish the microphone.');
    audioTrack = publication.audioTrack;
  } catch (err) {
    await disconnect().catch(() => {});
    throw err;
  }

  const setMuted = async (muted: boolean) => {
    if (!canCapture()) return;
    if (muted) await audioTrack.mute();
    else await audioTrack.unmute();
  };

  const localListeners = new Set<(speaking: boolean) => void>();
  room.localParticipant.on(ParticipantEvent.IsSpeakingChanged, (speaking: boolean) => {
    for (const cb of localListeners) cb(speaking);
  });

  return {
    room,
    setMuted,
    setDeafened(d) {
      deafened = d;
      for (const el of elements.values()) el.muted = d;
    },
    async setPushToTalk(active) {
      await setMuted(!active);
    },
    disconnect,
    onLocalSpeaking(cb) {
      localListeners.add(cb);
      return () => localListeners.delete(cb);
    },
    onRemoteSpeaking(cb) {
      remoteListeners.add(cb);
      return () => remoteListeners.delete(cb);
    },
  };
}
