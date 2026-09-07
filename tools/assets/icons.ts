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
import { crc32, Inflate, inflateSync } from 'node:zlib';

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

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_PNG_CHUNKS = 256;
const MAX_ICON_SIZE = Math.max(...GRID_SIZES, ...PWA_SIZES);

/**
 * A conservative equivalence fallback for the current derivatives, not an input
 * decoder: 8-bit indexed, non-interlaced PNGs with unfiltered scanlines only.
 * Unknown chunks/representations cannot prove compression-only drift. Source
 * selection and sharp's decoding/generation options remain independent of this.
 */
function comparablePng(bytes: Buffer): { nonIdat: Buffer; scanlines: Buffer } | null {
  if (bytes.length > MAX_PNG_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const nonIdat: Buffer[] = [];
  const idat: Buffer[] = [];
  const seen = new Set<string>();
  let width = 0;
  let height = 0;
  let paletteEntries = 0;
  let chunks = 0;
  let ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (++chunks > MAX_PNG_CHUNKS || bytes.length - offset < 12) return null;
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return null;
    const end = offset + 12 + length;
    // latin1 preserves high bits, so malformed type bytes cannot alias ASCII.
    const kind = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return null;
    if (chunks === 1 && kind !== 'IHDR') return null;
    if (kind !== 'IDAT') {
      if (seen.has(kind)) return null;
      seen.add(kind);
      nonIdat.push(bytes.subarray(offset, end));
    }
    switch (kind) {
      case 'IHDR':
        if (chunks !== 1 || length !== 13) return null;
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        if (width === 0 || height === 0 || width > MAX_ICON_SIZE || height > MAX_ICON_SIZE
          || data[8] !== 8 || data[9] !== 3 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return null;
        break;
      case 'PLTE':
        if (idat.length > 0 || length === 0 || length > 768 || length % 3 !== 0) return null;
        paletteEntries = length / 3;
        break;
      case 'tRNS':
        if (idat.length > 0 || paletteEntries === 0 || length === 0 || length > paletteEntries) return null;
        break;
      case 'pHYs':
        if (idat.length > 0 || length !== 9 || data.readUInt32BE(0) === 0 || data.readUInt32BE(4) === 0
          || data.readUInt32BE(0) > 0x7fffffff || data.readUInt32BE(4) > 0x7fffffff
          || (data[8] !== 0 && data[8] !== 1)) return null;
        break;
      case 'gAMA':
        if (paletteEntries > 0 || idat.length > 0 || length !== 4
          || data.readUInt32BE(0) === 0 || data.readUInt32BE(0) > 0x7fffffff) return null;
        break;
      case 'IDAT':
        if (paletteEntries === 0) return null;
        idat.push(data);
        break;
      case 'IEND':
        if (length !== 0 || idat.length === 0 || end !== bytes.length) return null;
        ended = true;
        break;
      default:
        return null;
    }
    // All supported chunks except IEND must precede IDAT. Thus the IDAT run
    // above is necessarily consecutive, and IEND consumes the complete file.
    offset = end;
  }
  if (!ended) return null;
  const compressed = Buffer.concat(idat);
  const expectedLength = (width + 1) * height;
  // Default Z_FINISH checks stream completion and Adler-32. The consumed byte
  // count additionally rejects trailing garbage or a second zlib stream.
  const inflated: unknown = inflateSync(compressed, { info: true, maxOutputLength: expectedLength });
  if (typeof inflated !== 'object' || inflated === null
    || !('buffer' in inflated) || !Buffer.isBuffer(inflated.buffer)
    || !('engine' in inflated) || !(inflated.engine instanceof Inflate)
    || inflated.engine.bytesWritten !== compressed.length || inflated.buffer.length !== expectedLength) return null;
  const scanlines = inflated.buffer;
  for (let offset = 0; offset < scanlines.length; offset += width + 1) {
    if (scanlines[offset] !== 0
      || scanlines.subarray(offset + 1, offset + width + 1).some(index => index >= paletteEntries)) return null;
  }
  return { nonIdat: Buffer.concat(nonIdat), scanlines };
}

/** Keep committed PNGs only when complete validated data proves compression-only drift. */
export async function samePngContent(existing: Buffer, next: Buffer): Promise<boolean> {
  try {
    const before = comparablePng(existing);
    const after = comparablePng(next);
    return before !== null && after !== null
      && before.nonIdat.equals(after.nonIdat) && before.scanlines.equals(after.scanlines);
  } catch {
    // Malformed/unsupported data is drift; --check must report it without writing.
    return false;
  }
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
  let encodingOnly = 0;

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
        if (existing !== null && target.path.endsWith('.png') && await samePngContent(existing, next)) {
          encodingOnly += 1;
          continue;
        }
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
  if (encodingOnly > 0) {
    console.log(`[icons] ${encodingOnly} PNG file(s) differ only in encoding; existing files retained`);
  }
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
