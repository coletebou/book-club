import { type CSSProperties, type ReactNode, type RefObject, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { type ToastPlace, readScreen, samePlace, toastPlace } from './toast-place';

/** The one thing a toast offers to do about what it says ("Show"). */
export interface ToastAction {
  readonly label: string;
  readonly run: () => void;
}

export interface ToastOptions {
  readonly tone?: 'info' | 'error';
  /** It stays longer, and while it is hovered, focused or under a newer toast, so it can be used. */
  readonly action?: ToastAction;
}

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: 'info' | 'error';
  readonly action: ToastAction | undefined;
}

interface ToastApi {
  show(message: string, options?: ToastOptions | ToastOptions['tone']): void;
}

/** How long a toast is on screen: long enough to read, and with something to do, to do it. */
export const TOAST_MS = { info: 4000, error: 6000, action: 10_000 } as const;
/** What is left of a toast's time once nothing holds it any more, at least. */
export const TOAST_AFTER_HOLD_MS = 2000;
/** Toasts kept at once: the newest is on screen, the ones under it wait their turn. */
const KEPT = 3;

const ToastContext = createContext<ToastApi>({ show: () => {} });

/**
 * Where the toasts are while one is on screen, in the reader or the player (toast-place.ts): looked
 * at again whenever what is on screen changes (a page turned, a look begun, a panel opened, the
 * phone turned), never for the toasts' own changes. Null: the stylesheet's place.
 */
function useToastPlace(on: boolean, region: RefObject<HTMLElement | null>): ToastPlace | null {
  const [place, setPlace] = useState<ToastPlace | null>(null);
  useLayoutEffect(() => {
    if (!on) {
      setPlace(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const screen = readScreen(document);
      const next = screen ? toastPlace(screen) : null;
      setPlace((prev) => (samePlace(prev, next) ? prev : next));
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new MutationObserver((records) => {
      if (records.some((r) => !region.current?.contains(r.target))) later();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-modal', 'disabled'] });
    window.addEventListener('resize', later);
    window.addEventListener('scroll', later, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', later);
      window.removeEventListener('scroll', later, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [on, region]);
  return place;
}

function placeStyle(place: ToastPlace | null): CSSProperties | undefined {
  if (!place) return undefined;
  return {
    left: place.left,
    width: place.width,
    transform: 'none',
    ...(place.top !== undefined ? { top: place.top } : {}),
    ...(place.bottom !== undefined ? { top: 'auto', bottom: place.bottom } : {}),
  };
}

/**
 * The app's short messages (D89). One is on screen at a time, the newest, unless the pointer is
 * on the one there or the focus in it; a toast with something to do waits under a newer one and
 * comes back for the rest of its time, a plain one only says its piece. They are said politely to a
 * screen reader, reached with the keyboard after the page, and placed where they cover nothing to
 * read or tap: over the app's top bar (components.css, `.toast-region`), and in the reader and the
 * player where its buttons leave room (toast-place.ts).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** The toast the pointer is on, or the focus is in: it stays on screen while it is, newer or not. */
  const [engaged, setEngaged] = useState<number | null>(null);
  const next = useRef(1);
  const show = useCallback<ToastApi['show']>((message, options = 'info') => {
    const { tone = 'info', action } = typeof options === 'string' ? { tone: options } : options;
    const id = next.current++;
    setToasts((t) => [...t.slice(-(KEPT - 1)), { id, message, tone, action }]);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const engage = useCallback((id: number, on: boolean) => setEngaged((e) => (on ? id : e === id ? null : e)), []);
  const api = useMemo(() => ({ show }), [show]);
  const shown = toasts.some((t) => t.id === engaged) ? engaged : toasts[toasts.length - 1]?.id;
  const region = useRef<HTMLElement>(null);
  const place = useToastPlace(shown != null, region);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <section ref={region} className="toast-region" style={placeStyle(place)} data-place={place?.where ?? 'bar'} aria-label="Messages" aria-live="polite" data-testid="toasts">
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} shown={t.id === shown} onDone={dismiss} onEngage={engage} />
        ))}
      </section>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Calls `done` once `ms` have run while not `held`; held, the time stops, and runs on with at least TOAST_AFTER_HOLD_MS. */
function useCountdown(ms: number, held: boolean, done: () => void): void {
  const left = useRef(ms);
  const latest = useRef(done);
  latest.current = done;
  useEffect(() => {
    if (held) return;
    const started = Date.now();
    const timer = setTimeout(() => latest.current(), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(TOAST_AFTER_HOLD_MS, left.current - (Date.now() - started));
    };
  }, [held]);
}

function ToastView({ toast, shown, onDone, onEngage }: { toast: Toast; shown: boolean; onDone: (id: number) => void; onEngage: (id: number, on: boolean) => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  /** Where the focus was before it came into the toast: it goes back there when the toast is dismissed. */
  const cameFrom = useRef<HTMLElement | null>(null);
  const { action, id } = toast;
  // Pointed at or focused, it is not swapped for a newer one under the pointer (whose Show would be another's).
  const engaged = hovered || focused;
  useEffect(() => onEngage(id, engaged), [onEngage, id, engaged]);
  // A toast with something to do waits while it is pointed at, focused or under a newer one.
  useCountdown(action ? TOAST_MS.action : TOAST_MS[toast.tone], !!action && (!shown || engaged), () => onDone(id));
  const dismiss = () => {
    onDone(id);
    if (cameFrom.current?.isConnected) cameFrom.current.focus();
  };
  return (
    <div
      className={`toast${toast.tone === 'error' ? ' toast-error' : ''}${action ? ' has-action' : ''}`}
      hidden={!shown}
      data-testid="toast"
      // A mouse resting on it holds it (a touch does not: tapping it is using it).
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={(e) => {
        if (!focused) cameFrom.current = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
        setFocused(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        dismiss();
      }}
    >
      <span className="toast-text">{toast.message}</span>
      {action ? (
        <>
          <button
            type="button"
            className="btn btn-small btn-primary toast-action"
            onClick={() => {
              onDone(id);
              action.run();
            }}
          >
            {action.label}
          </button>
          <button type="button" className="icon-btn toast-close" aria-label="Dismiss" onClick={dismiss}>
            <Icon name="close" size={16} />
          </button>
        </>
      ) : null}
    </div>
  );
}
