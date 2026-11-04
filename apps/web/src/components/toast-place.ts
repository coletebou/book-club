/*
 * Where a toast goes in the reader and the player (D89, D94): somewhere it covers nothing to tap.
 * Elsewhere it comes in over the app's top bar, as components.css places it.
 *
 * - In the header's middle, between its buttons, as wide as they leave room for, where that is
 *   room enough: a computer's reader and player, a phone's player (two buttons).
 * - On a computer during a look (its buttons are in the header's middle, D91): at the foot, between
 *   what is to tap on either side of its middle (the page arrows, the format switch, D194), unless a
 *   card is up there or the audiobook's controls are.
 * - Otherwise (a phone's reader always): just under the header and the club bar (and the PDF's view
 *   panel, open), over the top of the page for its few seconds, clear of the notes' markers in its
 *   margin. A phone's reader header has no room for it, and its foot holds the page arrows, the way
 *   back from a look, the audiobook's controls and the cards.
 *
 * With a dialog up, nothing here: over the top bar, whose buttons are behind the dialog.
 */

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** What decides where a toast goes, as the screen is now. */
export interface ToastScreen {
  readonly width: number;
  readonly height: number;
  /** The reader's (or player's) header, and what there is to tap in it: its buttons, and a look's. */
  readonly header: Box | null;
  readonly headerControls: readonly Box[];
  /** Where the page begins: under the header, the club bar and the PDF's view panel when it is open. */
  readonly under: number;
  /** The reader's footer, and what there is to tap in it: the page arrows, the audiobook's controls, the way back. */
  readonly foot: Box | null;
  readonly footControls: readonly Box[];
  /** A card is up at the foot: a chapter's end, the next stop. */
  readonly card: boolean;
  /** The audiobook's controls are in the footer (reading along, or another book's audiobook). */
  readonly player?: boolean;
  /** The way back from a look (or to the narrator) is in the header (D91). */
  readonly look: boolean;
  /** The notes' markers on the page, each something to tap. */
  readonly markers: readonly Box[];
}

/** Where the toasts go: `top` or `bottom` in px from the screen's edge (neither: the header's, as the stylesheet has it). */
export interface ToastPlace {
  readonly where: 'header' | 'foot' | 'page';
  readonly left: number;
  readonly width: number;
  readonly top?: number;
  readonly bottom?: number;
}

/** A computer's screen: the stylesheet's breakpoint for the reader's header (components.css, app.css). */
export const COMPUTER_WIDTH = 700;
/** The widest a toast is. */
export const TOAST_WIDTH = 560;
/** A toast is at most two lines, and 40 px tall: what is within this of its top is under it. */
export const TOAST_HEIGHT = 44;
/** The narrowest a toast is put between buttons; narrower, it goes over the page. */
export const TOAST_MIN_WIDTH = 260;
/** Room kept between a toast and what is beside it. */
const GAP = 8;

const centreX = (b: Box) => (b.left + b.right) / 2;

/** The widest stretch centred on the screen between the controls on either side of its middle, inside [from, to]. */
function between(from: number, to: number, controls: readonly Box[], width: number): { left: number; width: number } | null {
  const middle = width / 2;
  let left = from;
  let right = to;
  for (const c of controls) {
    if (centreX(c) < middle) left = Math.max(left, c.right + GAP);
    else right = Math.min(right, c.left - GAP);
  }
  const half = Math.min(TOAST_WIDTH / 2, middle - left, right - middle);
  return half * 2 >= TOAST_MIN_WIDTH ? { left: middle - half, width: half * 2 } : null;
}

/** Under the header and the club bar, over the top of the page, clear of the markers in its way. */
function overPage(s: ToastScreen): ToastPlace {
  const top = s.under + GAP / 2;
  // As wide as the header's buttons span, from the first to the last.
  const edges = s.headerControls;
  let left = edges.length > 0 ? Math.min(...edges.map((c) => c.left)) : GAP;
  let right = edges.length > 0 ? Math.max(...edges.map((c) => c.right)) : s.width - GAP;
  const middle = (left + right) / 2;
  for (const m of s.markers) {
    if (m.bottom <= top || m.top >= top + TOAST_HEIGHT) continue;
    if (centreX(m) >= middle) right = Math.min(right, m.left - GAP / 2);
    else left = Math.max(left, m.right + GAP / 2);
  }
  const width = Math.max(0, Math.min(TOAST_WIDTH, right - left));
  return { where: 'page', top, left: left + (right - left - width) / 2, width };
}

/** Where the toasts go on the reader's or the player's screen as it is now (see the top of this file). */
export function toastPlace(s: ToastScreen): ToastPlace {
  if (s.header && !s.look) {
    const band = between(s.header.left + GAP, s.header.right - GAP, s.headerControls, s.width);
    if (band) return { where: 'header', ...band };
  }
  // At the foot's middle, between what there is to tap on either side of it (the page arrows, and
  // the Read · Listen · Both switch beside the first, D194), where that leaves room: not where the
  // audiobook's controls are (reading along, the dock spans the foot).
  if (s.width >= COMPUTER_WIDTH && s.look && s.foot && !s.card && !s.player && s.footControls.length >= 2) {
    const band = between(s.foot.left + GAP, s.foot.right - GAP, s.footControls, s.width);
    if (band) return { where: 'foot', ...band, bottom: s.height - Math.max(...s.footControls.map((c) => c.bottom)) };
  }
  return overPage(s);
}

/** Two places alike, to the pixel. */
export function samePlace(a: ToastPlace | null, b: ToastPlace | null): boolean {
  if (!a || !b) return a === b;
  const near = (x: number | undefined, y: number | undefined) => (x === undefined || y === undefined ? x === y : Math.abs(x - y) < 0.5);
  return a.where === b.where && near(a.left, b.left) && near(a.width, b.width) && near(a.top, b.top) && near(a.bottom, b.bottom);
}

/** What can be tapped. */
const CONTROLS = 'a[href], button, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** Out of sight inside what holds it: the player's controls scrolled up under its header, a page ahead. */
function clippedAway(el: Element, x: number, y: number): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(p);
    if (!/auto|scroll|hidden|clip/.test(`${overflowX} ${overflowY}`)) continue;
    const b = p.getBoundingClientRect();
    if (x < b.left || x > b.right || y < b.top || y > b.bottom) return true;
  }
  return false;
}

/** On screen to be tapped: laid out, not hidden, not inert, not out of sight in what holds it. */
function tappable(el: Element): boolean {
  if (el.closest('[inert], [hidden]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && !clippedAway(el, r.left + r.width / 2, r.top + r.height / 2);
}

const inside = (b: Box, area: Box) => {
  const x = centreX(b);
  const y = (b.top + b.bottom) / 2;
  return x >= area.left && x <= area.right && y >= area.top && y <= area.bottom;
};

/**
 * The reader's or the player's screen as it is now, or null where toasts keep the stylesheet's
 * place: no reader or player open, or a dialog up.
 */
export function readScreen(doc: Document): ToastScreen | null {
  const page = doc.querySelector('.reader, .listen-page');
  if (!page || doc.querySelector('[aria-modal="true"]')) return null;
  const view = doc.defaultView;
  const width = view?.innerWidth ?? 0;
  const height = view?.innerHeight ?? 0;
  const area = (selector: string) => {
    const el = page.querySelector(selector);
    return el ? boxOf(el) : null;
  };
  const header = area('.reader-header');
  const foot = area('.reader-footer');
  const controls = [...page.querySelectorAll(CONTROLS)].filter(tappable);
  const boxes = controls.map(boxOf);
  const under = Math.max(0, ...[header, area('.reader-bar'), area('.pdf-view-panel')].map((b) => b?.bottom ?? 0));
  return {
    width,
    height,
    header,
    headerControls: header ? boxes.filter((b) => inside(b, header)) : [],
    under,
    foot,
    footControls: foot ? boxes.filter((b) => inside(b, foot)) : [],
    card: !!page.querySelector('.reader-footer .chapter-end'),
    player: !!page.querySelector('.reader-footer .footer-player'),
    look: !!page.querySelector('.look-chip, .follow-chip'),
    markers: controls.filter((el) => el.classList.contains('margin-marker')).map(boxOf),
  };
}
