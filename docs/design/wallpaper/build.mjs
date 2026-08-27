/**
 * Generate the seasonal-wallpaper artboards.
 *
 * The home screen here is rebuilt from the real values in `public/app.css` at a
 * 390px viewport — resolved clamps, not rounded approximations — so the
 * wallpaper is judged against the layout it actually has to sit behind.
 */
import { writeFileSync } from 'node:fs';
import { tileUrl, TILE } from './motifs.mjs';

/** Where the artboards land. Override with an argument to build elsewhere. */
const OUT = process.argv[2] ?? new URL('.', import.meta.url).pathname;

/* The four seasons, with the canvas + wash tokens already shipping in app.css. */
const SEASONS = {
  christmas: {
    label: 'Christmas', canvas: '#eef1e9', navyLine: '#dae0d2', gold: '#bd8f5c',
    a: 'rgba(38, 88, 63, 0.30)', b: 'rgba(150, 44, 40, 0.18)', c: 'rgba(206, 172, 116, 0.28)',
    note: 'Fir sprigs and six-point stars. Evergreen ink, a brick-red wash at the left, champagne at the foot.',
  },
  halloween: {
    label: 'Halloween', canvas: '#f3ece4', navyLine: '#e2d6c8', gold: '#b07c3c',
    a: 'rgba(86, 55, 93, 0.30)', b: 'rgba(190, 106, 30, 0.26)', c: 'rgba(66, 54, 47, 0.18)',
    note: 'Bare branches and a crescent moon. Plum ink over a burnt-amber wash — an almanac, not a cartoon.',
  },
  valentines: {
    label: "Valentine's", canvas: '#f8eeec', navyLine: '#ebd8d6', gold: '#c2848a',
    a: 'rgba(178, 88, 104, 0.26)', b: 'rgba(214, 156, 162, 0.30)', c: 'rgba(201, 151, 117, 0.22)',
    note: 'Laurel sprigs with two small open hearts. The hearts are outlines and sparse — the leaves carry the pattern.',
  },
  spring: {
    label: 'Spring / Easter', canvas: '#eff3ea', navyLine: '#dbe3d5', gold: '#a8944f',
    a: 'rgba(116, 154, 111, 0.28)', b: 'rgba(146, 126, 182, 0.22)', c: 'rgba(214, 184, 128, 0.26)',
    note: 'New-growth sprigs and two eggs drawn as plain outlines. Sage ink, a lilac wash at the left.',
  },
};

const TILES9 = [
  ['appointments-176-0382ac3391bf74e5.webp', 'Appointments'],
  ['practice-176-aaac8fb4990a74eb.webp', 'Practice'],
  ['shia-baby-176-df9ebdaee61ccfb8.webp', 'Shia Baby'],
  ['school-176-e7e9f490c27a59f3.webp', 'School'],
  ['competition-176-708761457905d017.webp', 'Competition'],
  ['games-176-46fe624141cbebe7.webp', 'Games'],
  ['errands-176-a4b274a67469aa27.webp', 'Errands'],
  ['hubby-work-176-36c4b0c854138f2b.webp', 'Hubby Work'],
  ['shopping-176-e3ae08f053d51d74.webp', 'Shopping'],
];

/** The page background: motif tile over the three corner washes over the canvas. */
function backdrop(s, key, opacity) {
  return [
    `${tileUrl(key, { opacity })} repeat`,
    `radial-gradient(46rem 30rem at 100% 0%, ${s.a}, transparent 66%)`,
    `radial-gradient(44rem 30rem at 0% 18%, ${s.b}, transparent 65%)`,
    `radial-gradient(36rem 24rem at 50% 100%, ${s.c}, transparent 72%)`,
    s.canvas,
  ].join(', ');
}

function stat(value, label, s, alert) {
  return `      <div style="min-width:0;min-height:83.2px;padding:11.2px 5.6px;text-align:center${
    label === 'TODAY' ? '' : `;border-inline-start:1px solid ${s.navyLine}`}">
        <span style="display:block;font-family:Georgia,'Times New Roman',serif;font-size:28.8px;font-weight:400;color:${alert ? '#b85f50' : '#211f1c'};font-variant-numeric:tabular-nums">${value}</span>
        <span style="display:block;margin-top:2.4px;color:#5e5750;font-size:10.88px;line-height:1.3;letter-spacing:0.05em;text-transform:uppercase;white-space:nowrap">${label}</span>
      </div>`;
}

function artboard(key) {
  const s = SEASONS[key];
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
    a { color: #8b642f; } a:hover { color: #6d4d24; }
  </style>
</helmet>
<div style="width:390px;height:844px;overflow:hidden;background:${backdrop(s, key, '{{motifOpacity}}')};background-attachment:local">
  <div style="padding:16px 16px 0">

    <div style="padding:28.8px 21.6px;margin-bottom:27.3px;background:rgba(255,253,249,0.86);border:1px solid rgba(121,96,70,0.12);border-radius:30px;box-shadow:0 1px 2px rgba(92,67,43,0.04), 0 10px 26px rgba(92,67,43,0.09)">
      <p style="max-width:11ch;margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:40.8px;line-height:0.98;letter-spacing:-0.025em;color:#211f1c">Good morning, Michelle.</p>
      <p style="margin:0;color:#675f57;font-size:12px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase">${s.dateLine ?? 'Thursday, December 18'}</p>
      <div style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:0;margin-top:35.2px">
${stat('3', 'TODAY', s)}
${stat('0', 'TO DO', s)}
${stat('6', 'TO BUY', s)}
${stat('2', 'CLASHES', s, true)}
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:30.4px 10.4px">
${TILES9.map(([file, label]) => `      <a href="#" style="display:flex;flex-direction:column;align-items:center;gap:8.8px;text-decoration:none">
        <img src="${file}" alt="" style="width:97.6px;height:97.6px;max-width:97.6px;object-fit:contain;border-radius:22px">
        <span style="max-width:7.3rem;font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:14.88px;line-height:1.05;letter-spacing:-0.025em;color:#211f1c;text-align:center">${label}</span>
      </a>`).join('\n')}
    </div>

  </div>
</div>
</x-dc>
<script data-dc-script data-props='{"motifOpacity":{"editor":"range","default":0.5,"min":0,"max":1,"step":0.05,"section":"Wallpaper"}}'>
class Component extends DCLogic {
  renderVals() {
    return { motifOpacity: this.props.motifOpacity ?? 0.5 };
  }
}
</script>
</body>
</html>
`;
}

SEASONS.christmas.dateLine = 'Thursday, December 18';
SEASONS.halloween.dateLine = 'Friday, October 24';
SEASONS.valentines.dateLine = 'Friday, February 13';
SEASONS.spring.dateLine = 'Saturday, April 4';

const FILES = { christmas: 'Main.dc.html', halloween: 'Halloween.dc.html', valentines: 'Valentines.dc.html', spring: 'Spring.dc.html' };
for (const [key, file] of Object.entries(FILES)) writeFileSync(`${OUT}/${file}`, artboard(key));

/* ------------------------------------------------------------ motif sheet */

function swatch(key) {
  const s = SEASONS[key];
  return `      <div>
        <div style="height:250px;border:1px solid ${s.navyLine};border-radius:20px;background:${tileUrl(key, { opacity: 0.9 })} repeat, ${s.canvas};background-size:310px 310px, auto"></div>
        <p style="margin:12px 0 4px;font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:19px;letter-spacing:-0.025em;color:#211f1c">${s.label}</p>
        <p style="margin:0;color:#756d64;font-size:12.5px;line-height:1.5;text-wrap:pretty">${s.note}</p>
      </div>`;
}

writeFileSync(`${OUT}/Motifs.dc.html`, `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }
    a { color: #8b642f; } a:hover { color: #6d4d24; }
  </style>
</helmet>
<div style="width:900px;padding:48px;background:#f7f1e8">
  <p style="margin:0 0 6px;color:#655d55;font-size:11.5px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase">Michel-OS · seasonal wallpaper</p>
  <h1 style="margin:0 0 10px;font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:38px;line-height:1.05;letter-spacing:-0.025em;color:#211f1c">Four seasons, one hand</h1>
  <p style="max-width:62ch;margin:0 0 36px;color:#756d64;font-size:14.5px;line-height:1.6;text-wrap:pretty">Every motif is engraved botanical line work on the same system — 1.1px strokes, no fills, a sparse off-grid scatter on a ${TILE}px tile. What changes between seasons is the plant and the ink, so the four read as one family rather than four holiday stickers. Shown here a little larger than life and without the corner washes that sit over them in the app.</p>
  <div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:36px 32px">
${['christmas', 'halloween', 'valentines', 'spring'].map(swatch).join('\n')}
  </div>
</div>
</x-dc>
</body>
</html>
`);

/* --------------------------------------------------------------- manifest */

writeFileSync(`${OUT}/canvas.json`, JSON.stringify({
  artboards: [
    { file: 'Main.dc.html', x: 0, y: 0, w: 390, h: 844, title: 'Christmas' },
    { file: 'Halloween.dc.html', x: 490, y: 0, w: 390, h: 844 },
    { file: 'Valentines.dc.html', x: 980, y: 0, w: 390, h: 844, title: "Valentine's" },
    { file: 'Spring.dc.html', x: 1470, y: 0, w: 390, h: 844, title: 'Spring / Easter' },
    { file: 'Motifs.dc.html', x: 0, y: 980, w: 900, h: 1010, title: 'The motifs up close' },
  ],
  annotations: [
    { id: 'brief', x: 980, y: 980, w: 320,
      text: 'Each phone artboard is the real home screen at 390px — values lifted from app.css, real mini-app artwork.\n\nThe Wallpaper tweak above each frame dials motif strength; 0.5 is what ships.' },
  ],
  launch: { view: 'canvas' },
}, null, 2));

console.log('wrote 5 artboards + canvas.json');
