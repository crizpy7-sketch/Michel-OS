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
const OUT_DIR = new URL('../../public/icons/derived/', import.meta.url).pathname;
const MANIFEST = join(OUT_DIR, 'manifest.json');

/**
 * There is no longer a board-crop step here.
 *
 * Previously four mini-apps (`appointments`, `practice`, `school`,
 * `shia-baby`) had no standalone export: their "production" file was a crop
 * taken out of a concept board, and the manifest marked those `provisional` so
 * the tile could carry a "DRAFT ART" corner. Real exports have since been
 * supplied for all thirteen, so every icon is now read straight from
 * `public/icons/<key>.png`.
 *
 * Keeping the crop map would have been worse than useless: it took precedence
 * over the source file, so the four new icons would have been silently ignored
 * in favour of a crop of the old board.
 */

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
  /**
   * True when the art is not a final export. No icon sets this today; it is
   * kept so the manifest shape survives the next batch of provisional art.
   */
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

    // Hashed from the source art, so replacing an icon busts its cache.
    const bytes = await readFile(join(SOURCE_DIR, filename));

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
      provisional: false,
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
