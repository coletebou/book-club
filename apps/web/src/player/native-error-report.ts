import { type NativeAudioDiagnostic, type PartyDiagnosticsBody } from '@bookclub/shared';
import { PartyDiagnostics } from '../live/party-diagnostics';

/**
 * The iOS app's native playback errors, reported while no listening party is (D207): to the same
 * diagnostics endpoint a party's go to, with the same closed vocabulary — the error's domain and
 * code, the track's index, and whether it played from the device's copy or the network. Never the
 * error's text, a URL, a path or a title (the schema has no field for any of them). Inside a party
 * the party's own log already records every native diagnostic.
 *
 * Returns what stops it; whatever is queued then is sent first.
 */
export function reportNativeErrors(el: EventTarget, track: () => number, send: (body: PartyDiagnosticsBody) => Promise<void>): () => void {
  const log = new PartyDiagnostics(send);
  log.start();
  const onDiagnostic = (event: Event) => {
    const detail = (event as CustomEvent<NativeAudioDiagnostic>).detail;
    if (detail?.event === 'native-error') log.record({ ...detail, track: track() });
  };
  el.addEventListener('native-diagnostic', onDiagnostic);
  return () => {
    el.removeEventListener('native-diagnostic', onDiagnostic);
    void log.flush().finally(() => log.stop());
  };
}
