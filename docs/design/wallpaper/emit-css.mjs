/**
 * Print the `--season-motif` declarations for `public/app.css`.
 *
 *   node docs/design/wallpaper/emit-css.mjs
 *
 * The four wallpaper tiles in the stylesheet are generated, not hand-written.
 * If a motif changes, edit `motifs.mjs`, re-run this, and paste the four
 * declarations over the ones in the `html[data-skin='...']` blocks.
 */
import { tileUrl, TILE } from './motifs.mjs';

/** What ships. Full strength is for the design canvas, not the product. */
const OPACITY = 0.5;

console.log(`/* --season-tile: ${TILE}px */\n`);
for (const name of ['christmas', 'halloween', 'valentines', 'spring']) {
  console.log(`html[data-skin='${name}'] {`);
  console.log(`  --season-motif: ${tileUrl(name, { opacity: OPACITY })};`);
  console.log('}\n');
}
