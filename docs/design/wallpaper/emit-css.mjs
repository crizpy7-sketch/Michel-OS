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

/**
 * The tiles are emitted at full strength. How strong the wallpaper actually
 * reads is set on the layer in `app.css` (`--season-motif-strength`), because
 * it has to come down as the viewport grows: a 260px tile that is discreet
 * behind a phone's cards puts five times as many motifs on a desktop, where
 * far more bare canvas is showing.
 */

console.log(`/* --season-tile: ${TILE}px */\n`);
for (const name of ['christmas', 'halloween', 'valentines', 'spring']) {
  console.log(`html[data-skin='${name}'] {`);
  console.log(`  --season-motif: ${tileUrl(name)};`);
  console.log('}\n');
}
