import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The dialogs open now, the last one on top: only that one answers the keyboard. */
const open: object[] = [];

/**
 * Keep a sheet in the part of the screen still seen. On a phone the keyboard covers the bottom of
 * the page without making it shorter (iOS only shrinks its visual viewport), so a sheet fixed to
 * the bottom would have its text box and its Post button under the keys. The backdrop is fitted
 * to the visual viewport instead, as `--seen-top`, `--seen-bottom` and `--seen-height` (D88);
 * zoomed in, the page is left as it is.
 */
export function useSeenArea(element: { readonly current: HTMLElement | null }): void {
  useEffect(() => {
    const view = window.visualViewport;
    const el = element.current;
    if (!view || !el) return;
    const fit = () => {
      const zoomed = Math.abs(view.scale - 1) > 0.01;
      const top = zoomed ? 0 : Math.max(0, view.offsetTop);
      const bottom = zoomed ? 0 : Math.max(0, window.innerHeight - view.offsetTop - view.height);
      el.style.setProperty('--seen-top', `${Math.round(top)}px`);
      el.style.setProperty('--seen-bottom', `${Math.round(bottom)}px`);
      el.style.setProperty('--seen-height', `${Math.round(zoomed ? window.innerHeight : view.height)}px`);
    };
    fit();
    view.addEventListener('resize', fit);
    view.addEventListener('scroll', fit);
    return () => {
      view.removeEventListener('resize', fit);
      view.removeEventListener('scroll', fit);
    };
  }, [element]);
}

interface ModalProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly wide?: boolean;
  /** Element to focus first (defaults to the first focusable element). */
  readonly initialFocus?: string;
  /** `alertdialog`: a question to answer before going on (a confirmation). */
  readonly role?: 'dialog' | 'alertdialog';
  /** The id of what the dialog says, read out after its title. */
  readonly describedBy?: string;
  readonly className?: string;
  /** An extra action beside the close button (Cal's settings gear): never a replacement for it. */
  readonly headerExtra?: ReactNode;
}

/**
 * Accessible modal dialog / bottom sheet: focus moves in once, is trapped inside, Escape and the
 * backdrop close it, focus returns to the opener. `onClose` is read through a ref so a parent
 * passing a new function every render never re-runs the focus effect (v1 lost focus that way).
 * A dialog opened over another (a confirmation over the upload dialog) takes the keyboard until it
 * closes: Escape closes it alone.
 */
export function Modal({ title, onClose, children, footer, wide, initialFocus, role = 'dialog', describedBy, className, headerExtra }: ModalProps) {
  const titleId = useId();
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useSeenArea(backdrop);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const self = {};
    open.push(self);
    const opener = document.activeElement as HTMLElement | null;
    const root = panel.current;
    const first = (initialFocus ? root?.querySelector<HTMLElement>(initialFocus) : null) ?? root?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? root)?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (open[open.length - 1] !== self) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && root) {
        const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (items.length === 0) return;
        const firstItem = items[0]!;
        const lastItem = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === firstItem) {
          e.preventDefault();
          lastItem.focus();
        } else if (!e.shiftKey && document.activeElement === lastItem) {
          e.preventDefault();
          firstItem.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      const i = open.indexOf(self);
      if (i !== -1) open.splice(i, 1);
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, [initialFocus]);

  return createPortal(
    <div
      ref={backdrop}
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panel}
        className={`modal${wide ? ' modal-wide' : ''}${className ? ` ${className}` : ''}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <div className="modal-header-actions">
            {headerExtra}
            <button type="button" className="icon-btn" onClick={() => onCloseRef.current()} aria-label="Close">
              <Icon name="close" />
            </button>
          </div>
        </div>
        {children}
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
