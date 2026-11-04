import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Box, type ToastScreen, TOAST_HEIGHT, readScreen, samePlace, toastPlace } from './toast-place';

/*
 * Where a toast goes in the reader and the player (fidelity review round 16: on a phone, a reply's
 * toast was the topmost element over Back, Listen, Contents, Reading settings and Leave a note for
 * its ten seconds, and over "Stay here"). Boxes as the reader lays them out (measured in WebKit's
 * iPhone 15 and desktop Chromium).
 */

const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** The box a toast takes at its place, at most TOAST_HEIGHT tall. */
const toastBox = (s: ToastScreen) => {
  const p = toastPlace(s);
  const top = p.top ?? (p.bottom !== undefined ? s.height - p.bottom - TOAST_HEIGHT : 2);
  return box(p.left, top, p.left + p.width, top + TOAST_HEIGHT);
};

/** An iPhone 15: Back, then Listen, Contents, Reading settings and Leave a note; the club bar under them; the page arrows. */
const phone = (over: Partial<ToastScreen> = {}): ToastScreen => ({
  width: 393,
  height: 659,
  header: box(0, 0, 393, 48),
  headerControls: [box(8, 4, 52, 48), box(197, 4, 241, 48), box(245, 4, 289, 48), box(293, 4, 337, 48), box(341, 4, 385, 48)],
  under: 97,
  foot: box(0, 607, 393, 659),
  footControls: [box(8, 609, 52, 653), box(341, 609, 385, 653)],
  card: false,
  look: false,
  markers: [],
  ...over,
});

/** A computer: the same header at 1280 px, the club bar, the page arrows at the foot. */
const computer = (width = 1280, over: Partial<ToastScreen> = {}): ToastScreen => ({
  width,
  height: 860,
  header: box(0, 0, width, 48),
  headerControls: [box(8, 4, 52, 48), ...[4, 3, 2, 1].map((n) => box(width - 8 - 44 * n - 4 * (n - 1), 4, width - 8 - 44 * (n - 1) - 4 * (n - 1), 48))],
  under: 97,
  foot: box(0, 808, width, 860),
  footControls: [box(8, 810, 52, 854), box(width - 52, 810, width - 8, 854)],
  card: false,
  look: false,
  markers: [],
  ...over,
});

describe('a toast on a phone, in the reader or the player', () => {
  it('comes in under the header and the club bar, over the top of the page, as wide as the header’s buttons span', () => {
    expect(toastPlace(phone())).toEqual({ where: 'page', top: 101, left: 8, width: 377 });
  });

  it('covers none of the header’s buttons, the look’s, the club bar or the foot’s', () => {
    // During a look: "Read from here" in the header's middle, the way back in the footer between the arrows (D91).
    const stay = box(64, 6, 190, 40);
    const back = box(70, 617, 323, 649);
    const s = phone({ look: true, headerControls: [...phone().headerControls, stay], footControls: [...phone().footControls, back] });
    const t = toastBox(s);
    for (const control of [...s.headerControls, ...s.footControls]) expect(overlaps(t, control)).toBe(false);
    // The club bar ends where the page begins.
    expect(t.top).toBeGreaterThanOrEqual(s.under);
  });

  it('stays clear of a note’s marker in the page’s margin where it comes in, and of none lower down', () => {
    const inTheWay = box(349, 100, 393, 144);
    const lower = box(349, 196, 393, 240);
    expect(toastPlace(phone({ markers: [inTheWay, lower] }))).toEqual({ where: 'page', top: 101, left: 8, width: 337 });
    expect(toastPlace(phone({ markers: [lower] }))).toEqual({ where: 'page', top: 101, left: 8, width: 377 });
    // A PDF's markers sit on its page's right edge.
    const t = toastBox(phone({ markers: [box(327, 120, 371, 164)] }));
    expect(overlaps(t, box(327, 120, 371, 164))).toBe(false);
  });

  it('in the player, whose header has two buttons, sits between them, over its title, as on a computer', () => {
    const player = phone({ headerControls: [box(8, 4, 52, 48), box(341, 4, 385, 48)], foot: null, footControls: [] });
    const p = toastPlace(player);
    expect(p).toEqual({ where: 'header', left: 60, width: 273 });
    for (const control of player.headerControls) expect(overlaps(toastBox(player), control)).toBe(false);
  });

  it('with the PDF’s view panel open, comes in under it', () => {
    expect(toastPlace(phone({ under: 165 }))).toMatchObject({ where: 'page', top: 169 });
  });

  it('is never over a card at the foot, which is in the footer', () => {
    const t = toastBox(phone({ card: true }));
    expect(overlaps(t, box(0, 607, 393, 659))).toBe(false);
  });
});

describe('a toast on a computer, in the reader or the player', () => {
  it('sits in the header’s middle, between its buttons, as D89 has it', () => {
    expect(toastPlace(computer())).toEqual({ where: 'header', left: 360, width: 560 });
  });

  it('leaves the header’s fourth button (Listen from your place) whole where the screen is narrower', () => {
    const s = computer(760);
    const p = toastPlace(s);
    expect(p).toEqual({ where: 'header', left: 204, width: 352 });
    for (const control of s.headerControls) expect(overlaps(toastBox(s), control)).toBe(false);
  });

  it('goes over the page where the header’s buttons leave too little room', () => {
    const s = computer(1280, { headerControls: [...computer().headerControls, box(560, 4, 620, 48)] });
    expect(toastPlace(s)).toMatchObject({ where: 'page', top: 101 });
  });

  it('during a look, comes in at the foot between the page arrows (the look’s buttons are in the header’s middle)', () => {
    expect(toastPlace(computer(1280, { look: true }))).toEqual({ where: 'foot', left: 360, width: 560, bottom: 6 });
  });

  it('during a look, beside the Read · Listen · Both switch next to the first arrow, still at the foot’s middle (D194)', () => {
    const s = computer(1280, { look: true, footControls: [...computer().footControls, box(62, 813, 104, 851), box(106, 813, 148, 851), box(150, 813, 230, 851)] });
    const p = toastPlace(s);
    expect(p).toEqual({ where: 'foot', left: 360, width: 560, bottom: 6 });
    for (const control of s.footControls) expect(overlaps(toastBox(s), control)).toBe(false);
  });

  it('during a look, with a card up at the foot or the audiobook’s controls there, comes in over the page instead', () => {
    expect(toastPlace(computer(1280, { look: true, card: true }))).toMatchObject({ where: 'page', top: 101 });
    const reading = computer(1280, { look: true, player: true, footControls: [...computer().footControls, box(60, 818, 96, 846), box(100, 818, 160, 846)] });
    const p = toastPlace(reading);
    expect(p).toMatchObject({ where: 'page' });
    for (const control of [...reading.headerControls, ...reading.footControls]) expect(overlaps(toastBox(reading), control)).toBe(false);
  });
});

describe('samePlace', () => {
  it('is the same to the pixel, and only then', () => {
    expect(samePlace(null, null)).toBe(true);
    expect(samePlace({ where: 'page', top: 101, left: 8, width: 377 }, null)).toBe(false);
    expect(samePlace({ where: 'page', top: 101, left: 8, width: 377 }, { where: 'page', top: 101.2, left: 8, width: 377 })).toBe(true);
    expect(samePlace({ where: 'page', top: 101, left: 8, width: 377 }, { where: 'page', top: 103, left: 8, width: 377 })).toBe(false);
    expect(samePlace({ where: 'header', left: 360, width: 560 }, { where: 'page', top: 101, left: 360, width: 560 })).toBe(false);
  });
});

describe('readScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  /** Lay elements out where their data-box says (jsdom lays nothing out). */
  function layOut(html: string) {
    document.body.innerHTML = html;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const [l, t, r, b] = (this.getAttribute('data-box') ?? '0,0,0,0').split(',').map(Number) as [number, number, number, number];
      return { left: l, top: t, right: r, bottom: b, x: l, y: t, width: r - l, height: b - t, toJSON: () => ({}) };
    });
  }

  const reader = (extra = '', footer = '') => `
    <div class="reader">
      <header class="reader-header" data-box="0,0,393,48">
        <a href="/books/b" data-box="8,4,52,48">Back</a>
        <button data-box="341,4,385,48">Note</button>
      </header>
      <div class="reader-bar" data-box="0,48,393,97">
        <button data-box="41,43,67,69">A reaction on the bar</button>
        ${extra}
      </div>
      <div class="reader-area" data-box="0,97,393,607">
        <button class="margin-marker" data-box="349,100,393,144">💬</button>
        <button class="margin-marker" inert data-box="740,100,784,144">💬</button>
      </div>
      <footer class="reader-footer" data-box="0,607,393,659">
        <button data-box="8,609,52,653">Previous page</button>
        <button data-box="341,609,385,653">Next page</button>
        ${footer}
      </footer>
    </div>`;

  it('reads the header’s controls, the page’s top, the foot’s controls and the markers that can be tapped', () => {
    layOut(reader());
    const s = readScreen(document)!;
    expect(s.headerControls).toEqual([box(8, 4, 52, 48), box(341, 4, 385, 48)]);
    // The bar's reaction lane reaches into the header: it is the bar's, not the header's.
    expect(s.under).toBe(97);
    expect(s.footControls).toEqual([box(8, 609, 52, 653), box(341, 609, 385, 653)]);
    // A marker of another page (inert) is not there to tap.
    expect(s.markers).toEqual([box(349, 100, 393, 144)]);
    expect(s).toMatchObject({ look: false, card: false });
  });

  it('sees a look and its buttons where they are drawn, and a card at the foot', () => {
    layOut(
      reader(
        '<div class="look-chip"><button class="look-back" data-box="70,617,323,649">Back to Chapter 1</button><button class="look-stay" data-box="64,6,190,40">Read from here</button></div>',
        '<div class="chapter-end"><button data-box="300,612,340,650">Show</button></div>',
      ),
    );
    const s = readScreen(document)!;
    expect(s.look).toBe(true);
    expect(s.card).toBe(true);
    expect(s.headerControls).toContainEqual(box(64, 6, 190, 40));
    expect(s.footControls).toContainEqual(box(70, 617, 323, 649));
  });

  it('leaves out what is scrolled out of sight in what holds it: the player’s controls under its header', () => {
    layOut(`
      <div class="listen-page">
        <header class="reader-header" data-box="0,0,1280,48">
          <a href="/books/b" data-box="8,4,52,48">Back</a>
          <button data-box="1228,4,1272,48">Track list</button>
        </header>
        <div class="reader-bar" data-box="0,48,1280,97"></div>
        <main class="listen-main" style="overflow-y: auto" data-box="0,97,1280,860">
          <select data-box="560,10,640,40"><option>1×</option></select>
          <button data-box="600,300,680,340">Note here</button>
        </main>
      </div>`);
    const s = readScreen(document)!;
    expect(s.headerControls).toEqual([box(8, 4, 52, 48), box(1228, 4, 1272, 48)]);
    expect(toastPlace({ ...s, width: 1280 })).toMatchObject({ where: 'header' });
  });

  it('takes the PDF’s view panel, open, as part of what is over the page', () => {
    layOut(reader('<div class="pdf-view-panel" data-box="0,48,393,165"><button data-box="20,60,64,104">Zoom in</button></div>'));
    expect(readScreen(document)!.under).toBe(165);
  });

  it('is nothing with a dialog up, or away from the reader and the player: the stylesheet’s place', () => {
    layOut(`${reader()}<div role="dialog" aria-modal="true"></div>`);
    expect(readScreen(document)).toBeNull();
    layOut('<main><button data-box="0,0,40,40">Elsewhere</button></main>');
    expect(readScreen(document)).toBeNull();
  });
});
