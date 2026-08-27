/**
 * The four seasonal wallpapers, defined once.
 *
 * Both the design canvas and the shipped `app.css` are generated from this
 * file, so the preview the user judges is the same pixels the app paints.
 * Every motif is engraved botanical line work on one shared system: 1.1px
 * strokes, no fills, a sparse off-grid scatter on a 180px tile. What changes
 * between seasons is the plant and the ink — not the hand.
 */

/** Shared stroke weight, so the four seasons read as one drawing. */
const W = 1.1;

/* ---------------------------------------------------------------- motifs */

const g = (x, y, s, r, d) =>
  `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})">${d}</g>`;

/** Fir sprig — a stem with needles angled down and out. */
const fir = (x, y, s, r) => g(x, y, s, r,
  '<path d="M0 -20 L0 20 M0 -13 L-8 -8 M0 -13 L8 -8 M0 -6 L-9 0 M0 -6 L9 0 ' +
  'M0 1 L-8 7 M0 1 L8 7 M0 8 L-6 13 M0 8 L6 13"/>');

/** A six-point star, three crossed strokes. */
const star = (x, y, s) => g(x, y, s, 0,
  '<path d="M0 -9 L0 9 M-7.8 -4.5 L7.8 4.5 M-7.8 4.5 L7.8 -4.5"/>');

/** Bare winter branch with three twigs. */
const branch = (x, y, s, r) => g(x, y, s, r,
  '<path d="M-14 18 C -6 6, -2 -4, 4 -18 M-8 8 L-17 2 M-4 0 L6 -6 M-11 14 L-19 11"/>');

/** Crescent moon — outer arc against an offset inner arc. */
const moon = (x, y, s) => g(x, y, s, 0,
  '<path d="M4.5 -11 a 11 11 0 1 0 0 22 a 7 7 0 1 1 0 -22 z"/>');

/** Laurel sprig — a curved stem with alternating teardrop leaves. */
const laurel = (x, y, s, r) => g(x, y, s, r,
  '<path d="M-2 20 C -1 8, 0 -4, 3 -18"/>' +
  '<path d="M-1 12 c -7 -1 -10 -6 -8 -10 c 5 0 8 5 8 10 z"/>' +
  '<path d="M0 4 c 7 -1 10 -6 8 -10 c -5 0 -8 5 -8 10 z"/>' +
  '<path d="M1 -4 c -6 -1 -9 -5 -7 -9 c 4 0 7 4 7 9 z"/>');

/** A small open heart, one continuous outline. */
const heart = (x, y, s, r) => g(x, y, s, r,
  '<path d="M0 11 C -7 4, -11 0, -11 -4 a 5.6 5.6 0 0 1 11 -2.4 ' +
  'a 5.6 5.6 0 0 1 11 2.4 c 0 4 -4 8 -11 15 z"/>');

/** Spring sprig — rounded alternating leaves on a straight stem. */
const sprig = (x, y, s, r) => g(x, y, s, r,
  '<path d="M0 20 L0 -18"/>' +
  '<path d="M0 10 c -8 -1 -11 -7 -9 -11 c 6 0 9 6 9 11 z"/>' +
  '<path d="M0 1 c 8 -1 11 -7 9 -11 c -6 0 -9 6 -9 11 z"/>' +
  '<path d="M0 -8 c -6 -1 -9 -5 -7 -9 c 5 0 7 5 7 9 z"/>');

/** An egg — narrower at the top than a circle. */
const egg = (x, y, s) => g(x, y, s, 0,
  '<path d="M0 -14.5 c 5.4 0 8.8 8.8 8.8 14.4 a 8.8 8.8 0 0 1 -17.6 0 c 0 -5.6 3.4 -14.4 8.8 -14.4 z"/>');

/* --------------------------------------------------------------- the four */

/**
 * Positions are deliberately off-grid — irregular offsets and rotations, so a
 * repeating 180px tile does not resolve into visible wallpaper stripes.
 */
export const TILE = 260;

export const TILES = {
  christmas: {
    ink: '#2f5741',
    body: fir(38, 52, 1, -14) + fir(178, 34, 0.8, 11) + fir(112, 158, 0.9, -5) +
      fir(232, 128, 0.72, 19) +
      star(150, 96, 0.85) + star(58, 190, 0.7) + star(216, 210, 0.6) + star(96, 16, 0.5),
  },
  halloween: {
    ink: '#5c4763',
    body: branch(46, 58, 1, -8) + branch(186, 168, 0.85, 172) + branch(124, 226, 0.7, 14) +
      moon(168, 44, 0.9) + moon(52, 168, 0.62) +
      star(238, 118, 0.55) + star(104, 120, 0.42),
  },
  valentines: {
    ink: '#9c5a66',
    body: laurel(40, 54, 1, -16) + laurel(180, 160, 0.85, 12) + laurel(240, 44, 0.7, -6) +
      heart(150, 88, 0.85, -8) + heart(62, 196, 0.68, 12) + heart(212, 226, 0.55, -4),
  },
  spring: {
    ink: '#5b7a55',
    body: sprig(38, 50, 1, -12) + sprig(178, 150, 0.85, 10) + sprig(120, 232, 0.72, -6) +
      egg(160, 48, 0.85) + egg(56, 172, 0.65) + egg(238, 206, 0.55),
  },
};

/**
 * One tile as a CSS `url(...)` value.
 *
 * The payload is encoded so that no quote, space or parenthesis survives into
 * the stylesheet: the result is safe unquoted inside `url()`, and safe again
 * inside a double-quoted HTML `style` attribute. Getting this wrong produces a
 * silently broken background rather than an error.
 */
export function tileUrl(name, { opacity = 1 } = {}) {
  const t = TILES[name];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}" viewBox="0 0 ${TILE} ${TILE}">` +
    `<g fill="none" stroke="${t.ink}" stroke-width="${W}" stroke-linecap="round" ` +
    `stroke-linejoin="round" opacity="${opacity}">${t.body}</g></svg>`;
  const encoded = encodeURIComponent(svg)
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    // A `{{hole}}` passed in as the opacity has to survive the encoder, or the
    // canvas tweak silently stops driving anything.
    .replace(/%7B%7B/g, '{{').replace(/%7D%7D/g, '}}');
  return `url(data:image/svg+xml,${encoded})`;
}
