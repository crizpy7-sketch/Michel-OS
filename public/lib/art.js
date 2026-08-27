/**
 * Mini-app artwork (Agent L).
 *
 * The approved originals are 1024×1024 PNGs of about 1.2 MB each. Thirteen of
 * them on one home screen is a ten-megabyte paint, which on a phone in a
 * car park is the difference between an app the family opens and one they stop
 * opening. `tools/assets/icons.ts` produces the sizes the grid actually uses;
 * this module picks between them.
 *
 * `<picture>` with a WebP source and a PNG fallback, `srcset` for retina, and
 * `loading="lazy"` on everything below the first row. Explicit `width` and
 * `height` so the grid does not reflow as the images arrive — a home screen
 * that jumps while you are reaching for a tile is a home screen you mis-tap.
 */

import { h } from './dom.js';
import { icons } from './state.js';

const cache = new Map();

async function manifest() {
  const loaded = await icons();
  if (cache.size === 0) {
    for (const record of loaded.icons ?? []) cache.set(record.key, record);
  }
  return cache;
}

function fallbackArt(app) {
  return h('div', {
    class: 'tile__art',
    style: {
      display: 'grid', placeItems: 'center',
      fontSize: '1.6rem', fontWeight: '700', color: 'var(--faint)',
    },
    'aria-hidden': 'true',
  }, app.label.slice(0, 1));
}

/**
 * The artwork for one mini-app, or a lettered fallback.
 *
 * The fallback exists because a missing icon must not leave a blank square: an
 * empty tile reads as a broken app, whereas a monogram reads as art that has
 * not arrived yet — which is exactly what it is.
 */
export async function miniAppArt(app, { size = 88, eager = false } = {}) {
  // Shia Baby is a protected brand asset. Use an exact crop from the approved
  // original source rather than the older concept-board extraction.
  if (app.key === 'shia-baby') {
    return h('div', { class: 'tile__art tile__art--shia-original', title: 'Shia Baby original bear artwork' },
      h('img', {
        src: '/brand/shia-baby-bear.png', width: size, height: size, alt: '',
        loading: eager ? 'eager' : 'lazy', decoding: 'async',
      }),
    );
  }
  if (app.key === 'shopping') {
    return h('div', { class: 'tile__art tile__art--shopping-approved', title: 'Shopping approved artwork' },
      h('img', {
        src: '/brand/shopping-approved.png', width: size, height: size, alt: '',
        loading: eager ? 'eager' : 'lazy', decoding: 'async',
      }),
    );
  }

  const records = await manifest();
  const record = records.get(app.key);

  if (record === undefined) return fallbackArt(app);

  // Editorial list rows use smaller display sizes than the generated icon
  // manifest. Pick the nearest larger export instead of assuming every CSS
  // size has a dedicated asset; that keeps the UI sharp and fail-safe.
  const available = Object.keys(record.sizes ?? {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const nearest = (target) => {
    const key = available.find((candidate) => candidate >= target) ?? available.at(-1);
    return key === undefined ? undefined : record.sizes[String(key)];
  };
  const one = record.sizes?.[String(size)] ?? nearest(size);
  const two = record.sizes?.[String(size * 2)] ?? nearest(size * 2) ?? one;
  if (!one?.webp || !one?.png || !two?.webp || !two?.png) return fallbackArt(app);

  const picture = h('picture', {},
    h('source', { type: 'image/webp', srcset: `${one.webp} 1x, ${two.webp} 2x` }),
    h('img', {
      src: one.png,
      srcset: `${one.png} 1x, ${two.png} 2x`,
      width: size, height: size,
      // The artwork repeats the label that is already under the tile, so it is
      // decorative to a screen reader: announcing it twice is noise.
      alt: '',
      loading: eager ? 'eager' : 'lazy',
      decoding: 'async',
    }),
  );

  // Two different kinds of not-final, marked the same way on purpose: a
  // stand-in awaiting artwork, and a hero cropped out of a concept board
  // because the production export is a design board rather than an icon.
  // ASSET_MAP.md says neither may ship silently as final, and a note in a
  // document nobody opens is silent — so it goes on the tile.
  const draft = record.placeholder === true || record.provisional === true;

  return h('div', {
    class: `tile__art${draft ? ' tile__art--placeholder' : ''}`,
    title: draft ? `${app.label} — artwork not final` : undefined,
  }, picture,
    // The corner tag is `::after` content, which a screen reader may or may not
    // announce depending on the browser. This says it in text either way.
    draft ? h('span', { class: 'sr-only' }, 'Artwork not final') : null,
  );
}
