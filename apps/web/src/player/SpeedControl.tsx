import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { type ListeningSettings, RATE_MAX, RATE_MIN, RATE_PRESETS, formatRate, normalizeRate, rateLabel, stepRate } from '@bookclub/shared';
import { useAllowAudioOnly } from './allow-audio-only';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toasts';
import { keys, useListening, useParty, useSession } from '../lib/queries';
import { useAudio, useAudioState } from './AudioProvider';
import { maxPlayableRate } from './native-bridge';
import { chooseDefaultRate, currentDefaultRate } from './speed-memory';
import { useAudioControlsDefaultChoice } from './audio-controls';

/**
 * Choosing a listening speed (D195): a stepper in 0.05 steps (1.35× is one tap from 1.3×), and the
 * speeds most people use one tap away. Used by the player's speed sheet and by Settings, for the
 * default; `max` is what this device plays (an older iOS build stops at 2×).
 */
export function SpeedPicker({ value, onChange, max = RATE_MAX, label }: { value: number; onChange: (rate: number) => void; max?: number; label: string }) {
  const speed = normalizeRate(value);
  const slower = stepRate(speed, -1, max);
  const faster = stepRate(speed, 1, max);
  return (
    <div className="speed-picker">
      <div className="speed-stepper" role="group" aria-label={label}>
        <button type="button" className="icon-btn speed-step" aria-label={`Slower, ${rateLabel(slower)}`} disabled={speed <= RATE_MIN} onClick={() => onChange(slower)} data-testid="speed-down">
          <span aria-hidden="true">−</span>
        </button>
        <output className="speed-value" aria-live="polite" aria-label={rateLabel(speed)} data-testid="speed-value">
          {formatRate(speed)}
        </output>
        <button type="button" className="icon-btn speed-step" aria-label={`Faster, ${rateLabel(faster)}`} disabled={speed >= max} onClick={() => onChange(faster)} data-testid="speed-up">
          <span aria-hidden="true">+</span>
        </button>
      </div>
      <div className="speed-presets" role="radiogroup" aria-label="Common speeds">
        {RATE_PRESETS.filter((r) => r <= max).map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={speed === r}
            aria-label={rateLabel(r)}
            className={`btn btn-small speed-preset${speed === r ? ' btn-primary' : ' btn-ghost'}`}
            onClick={() => onChange(r)}
            data-testid={`speed-preset-${r}`}
          >
            {formatRate(r)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Your default speed now: the newest of this device's and the server's (speed-memory.ts). */
export function useDefaultRate(): { readonly rate: number; readonly set: (rate: number) => Promise<void> } {
  const qc = useQueryClient();
  const selfId = useSession().data?.user?.id;
  const listening = useListening(!!selfId);
  const [, rerender] = useState(0);
  return {
    rate: currentDefaultRate(selfId, listening.data),
    async set(rate: number) {
      const saved = await chooseDefaultRate(selfId, rate);
      if (saved) qc.setQueryData<ListeningSettings>(keys.listening, saved);
      rerender((n) => n + 1); // Offline, the device's copy changed and nothing else did.
    },
  };
}

/** The player's speed button: the speed in effect, opening the sheet to change it. */
export function SpeedButton({ bookId, disabled = false }: { bookId: string; disabled?: boolean }) {
  const state = useAudioState();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-small speed-btn" aria-haspopup="dialog" aria-label={`Playback speed, ${rateLabel(state.speed)}`} disabled={disabled} onClick={() => setOpen(true)} data-testid="speed">
        {formatRate(state.speed)}
      </button>
      {open && !disabled ? <SpeedSheet bookId={bookId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SpeedSheet({ bookId, onClose }: { bookId: string; onClose: () => void }) {
  const audio = useAudio();
  const state = useAudioState();
  const toast = useToast();
  const selfId = useSession().data?.user?.id;
  const party = useParty(bookId).data;
  const together = !!party && party.members.some((m) => m.userId === selfId);
  const fallback = useDefaultRate();
  const max = maxPlayableRate();
  const speed = state.speed;
  const isDefault = speed === fallback.rate;
  return (
    <Modal title="Playback speed" onClose={onClose} className="speed-sheet">
      <div className="stack">
        <SpeedPicker value={speed} onChange={(r) => audio.setRate(r)} max={max} label="Playback speed" />
        {together ? <p className="small muted">You are listening together: a new speed is everyone’s.</p> : null}
        {speed > max ? (
          <p className="small muted" data-testid="speed-capped">
            This version of the app plays up to {formatRate(max)}, so {formatRate(speed)} plays at {formatRate(max)} here.
          </p>
        ) : null}
        <div className="speed-default" data-testid="speed-default-panel">
          <p className="small">
            This book remembers its own speed. New audiobooks start at your default, <strong data-testid="speed-default">{formatRate(fallback.rate)}</strong>.
          </p>
          {isDefault ? (
            <p className="small faint" data-testid="speed-is-default">
              {formatRate(speed)} is your default.
            </p>
          ) : (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                void fallback.set(speed).then(() => toast.show(`${formatRate(speed)} is now your default speed.`));
              }}
              data-testid="speed-make-default"
            >
              Make {formatRate(speed)} my default
            </button>
          )}
          <p className="small faint">
            <Link to="/settings#listening" onClick={onClose}>
              Listening settings
            </Link>
          </p>
        </div>
      </div>
    </Modal>
  );
}

/** Settings' "Listening" card: your default speed, saved as you choose it. */
export function ListeningSettingsCard() {
  const fallback = useDefaultRate();
  const [saved, setSaved] = useState<number | null>(null);
  const ref = useRef<HTMLElement>(null);
  const { hash } = useLocation();
  // From the player's "Listening settings" link: straight to this card.
  useEffect(() => {
    if (hash === '#listening') ref.current?.scrollIntoView({ block: 'start' });
  }, [hash]);
  return (
    <section ref={ref} className="card stack" id="listening" aria-labelledby="listening-title">
      <h2 id="listening-title">Listening</h2>
      <p className="muted small">
        Your default speed. An audiobook you have not listened to yet starts at it; after that, each book remembers the speed you last listened to it at, on every device you use.
      </p>
      <SpeedPicker
        value={fallback.rate}
        label="Default speed"
        onChange={(r) => {
          void fallback.set(r).then(() => setSaved(r));
        }}
      />
      <p className="small faint" role="status" data-testid="default-speed-status">
        {saved !== null ? `Saved. New audiobooks start at ${formatRate(saved)}.` : ''}
      </p>
      <AudioControlsDefault />
      <AllowAudioOnlySetting />
    </section>
  );
}

/**
 * Your default for the audiobook's controls in the book (D197): shown, unless you only read. Each
 * book can say otherwise in its reading settings or on its page.
 */
function AudioControlsDefault() {
  const choice = useAudioControlsDefaultChoice();
  return (
    <label className="setting-check">
      <input type="checkbox" checked={choice.hidden} onChange={(e) => void choice.set(e.target.checked)} data-testid="hide-audio-controls" />
      <span>
        Hide the audiobook in books
        <span className="small muted setting-hint">For books you only read: Continue opens the text without starting the audiobook. A book can say otherwise in Book settings.</span>
      </span>
    </label>
  );
}

/** Whether the full audio-only player page is allowed (D198). Off by default. */
function AllowAudioOnlySetting() {
  const { allowed, set } = useAllowAudioOnly();
  return (
    <label className="setting-check">
      <input type="checkbox" checked={allowed} onChange={(e) => set(e.target.checked)} data-testid="allow-audio-only" />
      <span>
        Allow audio-only view
        <span className="small muted setting-hint">When off, a book with text always opens as text with the audiobook docked. Books that are only audiobooks still use the player.</span>
      </span>
    </label>
  );
}
