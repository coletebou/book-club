import { useSyncExternalStore } from 'react';
import type { VoiceRoomKind } from '@bookclub/shared';
import { api } from '../lib/api';
import { realtime } from '../lib/realtime';
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

export async function joinVoice(clubId: string, roomKind: VoiceRoomKind = 'club', adhocId?: string): Promise<VoiceSession> {
  if (session && session.clubId === clubId && session.roomKind === roomKind) return session;
  if (session) await leaveVoice();
  const config = await api.livekitConfig();
  if (!config.enabled) throw new Error('Voice is not set up on this instance yet.');
  const { url, token, roomName } = await api.livekitToken({ clubId, room: roomKind, adhocId });
  const handle = await connectVoice(url, token);
  session = { handle, clubId, roomKind, roomName, muted: false, deafened: false, pushToTalk: false };
  realtime()?.sendVoiceJoin(clubId, roomKind, adhocId);
  // Speaking indicator in presence (D154): only ever this device's own mic, as LiveKit reports it.
  handle.onLocalSpeaking((speaking) => {
    if (session?.handle === handle) realtime()?.sendVoiceSelf(clubId, roomKind, { speaking }, adhocId);
  });
  emit();
  return session;
}

export async function leaveVoice(): Promise<void> {
  if (!session) return;
  const { handle, clubId, roomKind } = session;
  session = null;
  emit();
  realtime()?.sendVoiceLeave(clubId, roomKind);
  await handle.disconnect();
}

export async function setMuted(muted: boolean): Promise<void> {
  if (!session) return;
  await session.handle.setMuted(muted);
  session.muted = muted;
  realtime()?.sendVoiceSelf(session.clubId, session.roomKind, { muted });
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
  if (!session || !session.pushToTalk) return;
  await session.handle.setPushToTalk(active);
  realtime()?.sendVoiceSelf(session.clubId, session.roomKind, { speaking: active });
  emit();
}

export async function setPushToTalkMode(on: boolean): Promise<void> {
  if (!session) return;
  session.pushToTalk = on;
  // Entering push-to-talk starts muted (push to speak); leaving it unmutes continuously.
  await session.handle.setMuted(on);
  session.muted = on;
  realtime()?.sendVoiceSelf(session.clubId, session.roomKind, { pushToTalk: on, muted: on });
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
