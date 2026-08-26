/**
 * Icon derivatives (Agent A, orchestrator-owned tooling).
 *
 * The approved artwork is thirteen 1024×1024 PNGs averaging 1.2 MB each. The
 * home screen shows all thirteen at once, so shipping the originals means a
 * ~10 MB paint for a grid of 88 px tiles — on a phone, on a driveway, waiting
 * for a practice to start. That is the difference between an app the family
 * opens and one they stop opening.
 *
 * So the originals stay in the repository as the source of truth and this
 * script produces what the browser actually loads: WebP and PNG at the sizes
 * the grid uses, plus the PWA install icons.
 *
 * It is deliberately NOT part of serving or of `npm start`. ADR-001 committed
 * to no build step, and this does not add one: it is run by hand when the art
 * changes, and its output is committed. `--check` re-runs it in CI-safe mode to
 * report drift rather than write.
 *
 *   node --experimental-strip-types tools/assets/icons.ts
 *   node --experimental-strip-types tools/assets/icons.ts --check
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE_DIR = new URL('../../public/icons/', import.meta.url).pathname;
const REFERENCE_DIR = new URL('../../art/reference/', import.meta.url).pathname;
const OUT_DIR = new URL('../../public/icons/derived/', import.meta.url).pathname;
const MANIFEST = join(OUT_DIR, 'manifest.json');

/**
 * Four mini-apps whose "production" icon file is actually a design board.
 *
 * `public/icons/{appointments,practice,school,shia-baby}.png` are crops of the
 * concept boards in `art/reference/*-design-board.png`: a hero icon beside a
 * phone mockup, sales copy, a colour palette and a row of variations. Rendered
 * into an 88px tile, what the family sees is a sliver of the icon and a
 * fragment of a fake screenshot. The other four (`competition`, `errands`,
 * `games`, `hubby-work`, all named `-full.png` in the reference folder) are
 * genuine icons and pass through untouched.
 *
 * This is a packaging mistake in the handoff, not a design decision, so the fix
 * is to take the hero icon out of the board rather than to substitute different
 * art — ASSET_MAP.md is explicit that approved artwork must not be replaced,
 * and the hero IS the approved artwork, just framed inside a presentation.
 *
 * The boxes below were read off each 1254x1254 board by eye. They are marked
 * `provisional` in the manifest, which is what puts the "DRAFT ART" corner on
 * the tile: a crop somebody chose from a concept board is not the same thing as
 * an exported production asset, and it should not be mistaken for one.
 */
interface Extraction { board: string; left: number; top: number; size: number }

const EXTRACT: Readonly<Record<string, Extraction>> = Object.freeze({
  appointments: { board: 'appointments-design-board.png', left: 178, top: 112, size: 478 },
  practice:     { board: 'practice-design-board.png',     left: 268, top: 148, size: 428 },
  school:       { board: 'school-design-board.png',       left: 266, top: 162, size: 400 },
  'shia-baby':  { board: 'shia-baby-design-board.png',    left: 124, top:  84, size: 388 },
});

/**
 * The sizes the UI actually asks for.
 *
 * 88 is the grid tile on a phone; 176 is the same tile at 2× for a retina
 * screen; 256 covers the tablet grid and the mini-app header. There is no 512
 * for the grid because nothing displays an icon that large — the PWA install
 * icons are generated separately below and are the only place 512 is used.
 */
const GRID_SIZES = [88, 176, 256] as const;
const PWA_SIZES = [192, 512] as const;

export interface IconRecord {
  /** The mini-app key: `appointments`, `shia-baby`, ... */
  key: string;
  /** True when the source is a `.placeholder.png` awaiting final artwork. */
  placeholder: boolean;
  /** True when the art was cropped out of a concept board — see EXTRACT. */
  provisional: boolean;
  /** Content hash of the SOURCE, so drift is detected from the art, not the output. */
  sourceHash: string;
  /** `{ '88': { webp: '/icons/derived/…', png: '/icons/derived/…' }, … }` */
  sizes: Record<string, { webp: string; png: string }>;
}

export interface IconManifest {
  generatedFrom: string;
  icons: IconRecord[];
}

/** `appointments.png` → `appointments`; `inbox.placeholder.png` → `inbox`. */
export function keyOf(filename: string): string {
  return filename.replace(/\.placeholder\.png$/i, '').replace(/\.png$/i, '');
}

export function isPlaceholder(filename: string): boolean {
  return /\.placeholder\.png$/i.test(filename);
}

async function run(): Promise<void> {
  const check = process.argv.includes('--check');
  await mkdir(OUT_DIR, { recursive: true });

  const sharp = (await import('sharp')).default;

  const sources = (await readdir(SOURCE_DIR))
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort();

  const icons: IconRecord[] = [];
  let written = 0;

  for (const filename of sources) {
    const key = keyOf(filename);
    const extraction = EXTRACT[key];

    // The hash is taken from what is actually rendered — the cropped hero, not
    // the board it came from — so adjusting a crop box busts the cache the same
    // way replacing the artwork would.
    const bytes = extraction === undefined
      ? await readFile(join(SOURCE_DIR, filename))
      : await sharp(await readFile(join(REFERENCE_DIR, extraction.board)))
          .extract({ left: extraction.left, top: extraction.top, width: extraction.size, height: extraction.size })
          .png()
          .toBuffer();

    const sourceHash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);

    const sizes: IconRecord['sizes'] = {};
    for (const size of [...GRID_SIZES, ...PWA_SIZES]) {
      // The hash is in the filename, so a changed icon gets a new URL and the
      // `immutable` cache header on /assets-style paths is safe to keep.
      const stem = `${key}-${size}-${sourceHash}`;
      const targets = [
        { path: join(OUT_DIR, `${stem}.webp`), make: () => sharp(bytes).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 82, effort: 6 }).toBuffer() },
        { path: join(OUT_DIR, `${stem}.png`), make: () => sharp(bytes).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9, palette: true }).toBuffer() },
      ];

      for (const target of targets) {
        const next = await target.make();
        const existing = await readFile(target.path).catch(() => null);
        if (existing !== null && existing.equals(next)) continue;
        if (check) {
          console.error(`[icons] out of date: ${target.path}`);
          process.exitCode = 1;
          continue;
        }
        await writeFile(target.path, next);
        written += 1;
      }

      if (GRID_SIZES.includes(size as (typeof GRID_SIZES)[number])) {
        sizes[String(size)] = {
          webp: `/icons/derived/${stem}.webp`,
          png: `/icons/derived/${stem}.png`,
        };
      }
    }

    icons.push({
      key,
      placeholder: isPlaceholder(filename),
      provisional: extraction !== undefined,
      sourceHash,
      sizes,
    });
  }

  const manifest: IconManifest = {
    generatedFrom: 'public/icons/*.png — do not edit files in this directory by hand',
    icons,
  };
  const serialised = `${JSON.stringify(manifest, null, 2)}\n`;
  const previous = await readFile(MANIFEST, 'utf8').catch(() => null);
  if (previous !== serialised) {
    if (check) {
      console.error('[icons] manifest is out of date');
      process.exitCode = 1;
    } else {
      await writeFile(MANIFEST, serialised);
      written += 1;
    }
  }

  const placeholders = icons.filter((i) => i.placeholder).map((i) => i.key);
  const provisional = icons.filter((i) => i.provisional).map((i) => i.key);
  console.log(`[icons] ${icons.length} icons, ${written} file(s) written`);
  // Loud on purpose: ASSET_MAP.md says neither of these may ship silently as
  // final artwork, and a note in a document nobody opens is silent.
  if (placeholders.length > 0) {
    console.log(`[icons] AWAITING FINAL ARTWORK: ${placeholders.join(', ')}`);
  }
  if (provisional.length > 0) {
    console.log(`[icons] CROPPED FROM A CONCEPT BOARD, needs a real export: ${provisional.join(', ')}`);
  }
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await run();
}
