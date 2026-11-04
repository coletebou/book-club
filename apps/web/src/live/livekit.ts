import { ParticipantEvent, Room, RoomEvent, Track } from 'livekit-client';

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

export async function connectVoice(url: string, token: string, startMuted = false): Promise<VoiceHandle> {
  const room = new Room({ adaptiveStream: true, dynacast: true });
  const elements = new Map<string, HTMLAudioElement>();
  let deafened = false;

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (track.kind !== Track.Kind.Audio) return;
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

  await room.connect(url, token);
  await room.localParticipant.setMicrophoneEnabled(!startMuted, AUDIO_CAPTURE);

  const localListeners = new Set<(speaking: boolean) => void>();
  room.localParticipant.on(ParticipantEvent.IsSpeakingChanged, (speaking: boolean) => {
    for (const cb of localListeners) cb(speaking);
  });

  return {
    room,
    async setMuted(muted) {
      await room.localParticipant.setMicrophoneEnabled(!muted, AUDIO_CAPTURE);
    },
    setDeafened(d) {
      deafened = d;
      for (const el of elements.values()) el.muted = d;
    },
    async setPushToTalk(active) {
      await room.localParticipant.setMicrophoneEnabled(active, AUDIO_CAPTURE);
    },
    async disconnect() {
      for (const el of elements.values()) el.remove();
      elements.clear();
      await room.disconnect();
    },
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
