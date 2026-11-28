import { useSyncExternalStore } from 'react';
import type { VoiceRoomKind } from '@bookclub/shared';
import { api } from '../lib/api';
import { stopCaptureOnCarPlay } from '../lib/media-capture';
import { realtime } from '../lib/realtime';
import { listeningCaptureAllowed } from '../player/native-bridge';
import { type VoiceHandle, connectVoice } from './livekit';

/**
 * One voice connection per tab (D153-D154), shared by whatever UI joins it (the club's voice
 * channel button, a listening party): a microphone is one device's, so there is one LiveKit room
 * connected at a time here, whichever room it is for. Other components (PartyBar) read it to duck
 * the audiobook while someone else is heard, without threading a connection through props.
 */
export interface VoiceSession {
  readonly handle: VoiceHandle;
  readonly clubId: string;
  readonly roomKind: VoiceRoomKind;
  readonly roomName: string;
  muted: boolean;
  deafened: boolean;
  pushToTalk: boolean;
}

let session: VoiceSession | null = null;
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version++;
  for (const l of listeners) l();
}

export async function joinVoice(clubId: string, roomKind: VoiceRoomKind = 'club', adhocId?: string, onMicrophoneDisconnected?: () => void): Promise<VoiceSession> {
  let interrupted = false;
  const checkCapture = () => {
    if (interrupted || !listeningCaptureAllowed()) throw new Error('Voice is unavailable while CarPlay may be connected.');
  };
  checkCapture();
  if (session && session.clubId === clubId && session.roomKind === roomKind) return session;
  // Preserve a car connection edge while the voice configuration or token request is pending.
  const unwatchCar = stopCaptureOnCarPlay(() => { interrupted = true; });
  try {
    if (session) await leaveVoice();
    const config = await api.livekitConfig();
    checkCapture();
    if (!config.enabled) throw new Error('Voice is not set up on this instance yet.');
    const { url, token, roomName } = await api.livekitToken({ clubId, room: roomKind, adhocId });
    checkCapture();
    const handle = await connectVoice(url, token, (room, reason) => {
      if (session?.handle.room !== room) return;
      removeSession(session);
      if (reason === 'microphone-disconnected') onMicrophoneDisconnected?.();
    });
    session = { handle, clubId, roomKind, roomName, muted: false, deafened: false, pushToTalk: false };
    realtime()?.sendVoiceJoin(clubId, roomKind, adhocId);
    // Speaking indicator in presence (D154): only ever this device's own mic, as LiveKit reports it.
    handle.onLocalSpeaking((speaking) => {
      if (session?.handle === handle) realtime()?.sendVoiceSelf(clubId, roomKind, { speaking }, adhocId);
    });
    emit();
    return session;
  } finally {
    unwatchCar();
  }
}

function removeSession(active: VoiceSession): void {
  session = null;
  emit();
  realtime()?.sendVoiceLeave(active.clubId, active.roomKind);
}

export async function leaveVoice(): Promise<void> {
  const active = session;
  if (!active) return;
  removeSession(active);
  await active.handle.disconnect();
}

export async function setMuted(muted: boolean): Promise<void> {
  const active = session;
  if (!active) return;
  await active.handle.setMuted(muted);
  if (session !== active) return;
  active.muted = muted;
  realtime()?.sendVoiceSelf(active.clubId, active.roomKind, { muted });
  emit();
}

export function setDeafened(deafened: boolean): void {
  if (!session) return;
  session.handle.setDeafened(deafened);
  session.deafened = deafened;
  realtime()?.sendVoiceSelf(session.clubId, session.roomKind, { deafened });
  emit();
}

export async function setPushToTalkHeld(active: boolean): Promise<void> {
  const joined = session;
  if (!joined?.pushToTalk) return;
  await joined.handle.setPushToTalk(active);
  if (session !== joined) return;
  realtime()?.sendVoiceSelf(joined.clubId, joined.roomKind, { speaking: active });
  emit();
}

export async function setPushToTalkMode(on: boolean): Promise<void> {
  const active = session;
  if (!active) return;
  active.pushToTalk = on;
  // Entering push-to-talk starts muted (push to speak); leaving it unmutes continuously.
  await active.handle.setMuted(on);
  if (session !== active) return;
  active.muted = on;
  realtime()?.sendVoiceSelf(active.clubId, active.roomKind, { pushToTalk: on, muted: on });
  emit();
}

export function currentVoice(): VoiceSession | null {
  return session;
}

export function useVoiceSession(): VoiceSession | null {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return session;
}
