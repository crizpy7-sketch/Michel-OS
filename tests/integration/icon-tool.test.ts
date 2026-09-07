import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { samePngContent, type IconManifest } from '../../tools/assets/icons.ts';

const repository = resolve(import.meta.dirname, '../..');
const artwork = 'ai-assistant.png';
const derivative = 'ai-assistant-88-fee95697ad460a47.png';
const committed = readFileSync(join(repository, 'public/icons/derived', derivative));

function pngChunk(kind: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(kind, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function withGamma(bytes: Buffer, gamma: number): Buffer {
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  const data = Buffer.alloc(4);
  data.writeUInt32BE(gamma);
  // The valid reviewer witness: gAMA follows IHDR, before PLTE and IDAT.
  return Buffer.concat([bytes.subarray(0, 33), pngChunk('gAMA', data), bytes.subarray(33)]);
}

// Change only IDAT compression, independently of sharp's encoding choices.
function recompressPng(bytes: Buffer): Buffer {
  const chunks: Buffer[] = [bytes.subarray(0, 8)];
  let count = 0;
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (kind === 'IDAT') {
      count += 1;
      const data = deflateSync(inflateSync(bytes.subarray(offset + 8, end - 4)), { level: 0 });
      const chunk = Buffer.alloc(data.length + 12);
      chunk.writeUInt32BE(data.length);
      chunk.write('IDAT', 4, 'ascii');
      data.copy(chunk, 8);
      chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
      chunks.push(chunk);
    } else chunks.push(bytes.subarray(offset, end));
    offset = end;
  }
  assert.equal(count, 1, 'this repository fixture has one IDAT chunk');
  return Buffer.concat(chunks);
}

test('PNG compatibility accepts encoding changes but rejects pixel, alpha, metadata, format and decode drift', async () => {
  const encodedDifferently = recompressPng(committed);
  assert(!committed.equals(encodedDifferently));
  assert(await samePngContent(committed, encodedDifferently));

  const { data, info } = await sharp(committed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = data.findIndex((value, index) => index % 4 === 3 && value === 255) - 3;
  assert(pixel >= 0, 'fixture contains an opaque pixel');
  for (const channel of [0, 3]) {
    const changed = Buffer.from(data);
    const original = changed[pixel + channel];
    assert(original !== undefined);
    changed[pixel + channel] = channel === 3 ? 0 : (original + 128) % 256;
    const image = await sharp(changed, { raw: info }).png({ palette: true }).toBuffer();
    assert(!await samePngContent(committed, image), channel === 3 ? 'alpha drift' : 'RGB drift');
  }
  assert(!await samePngContent(committed, await sharp(committed).resize(87, 88).png({ palette: true }).toBuffer()));
  assert(!await samePngContent(committed, await sharp(committed).withMetadata({ density: 144 }).png({ palette: true }).toBuffer()));
  assert(!await samePngContent(committed, await sharp(committed).webp().toBuffer()));
  assert(!await samePngContent(committed, Buffer.from('not an image')));
});

test('SR-REVIEW-1: exported helper rejects added, changed and removed gamma', async (t) => {
  const gammaOne = withGamma(committed, 100000);
  const gammaOther = withGamma(committed, 45455);
  assert.equal(createHash('sha256').update(gammaOne).digest('hex'), 'dc7ea0d3fb54f9a53959d4ab263efb8c6e493a8b1c1dfd6ae5e0d8d2b30a813f');
  // Decodability alone is insufficient: this witness previously passed both
  // sharp metadata and RGBA comparison despite its changed rendering semantics.
  assert.equal((await sharp(gammaOne).metadata()).format, 'png');
  await sharp(gammaOne).raw().toBuffer();
  for (const [name, before, after] of [
    ['added gamma', committed, gammaOne],
    ['changed gamma', gammaOne, gammaOther],
    ['removed gamma', gammaOne, committed],
  ] as const) {
    await t.test(name, async () => assert.equal(await samePngContent(before, after), false, name));
  }
  assert(await samePngContent(gammaOne, recompressPng(gammaOne)), 'unchanged valid gamma with compression-only drift');
});

test('PNG comparison validates bounded structure and the complete compressed stream', async (t) => {
  const chunks: { kind: string; data: Buffer }[] = [];
  for (let offset = 8; offset < committed.length;) {
    const length = committed.readUInt32BE(offset);
    chunks.push({ kind: committed.toString('ascii', offset + 4, offset + 8), data: committed.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  const make = (parts = chunks) => Buffer.concat([committed.subarray(0, 8), ...parts.map(({ kind, data }) => pngChunk(kind, data))]);
  const replace = (kind: string, data: Buffer) => make(chunks.map(chunk => chunk.kind === kind ? { kind, data } : chunk));
  const compressed = Buffer.concat(chunks.filter(chunk => chunk.kind === 'IDAT').map(chunk => chunk.data));
  const scanlines = inflateSync(compressed);
  const recompressed = deflateSync(scanlines, { level: 0 });
  const split = make(chunks.flatMap(chunk => chunk.kind === 'IDAT' ? [
    { kind: 'IDAT', data: recompressed.subarray(0, 7) },
    { kind: 'IDAT', data: recompressed.subarray(7) },
  ] : [chunk]));
  assert(await samePngContent(committed, split), 'compression-only positive control across consecutive IDAT chunks');

  const header = Buffer.from(committed.subarray(16, 29));
  const changedHeader = (offset: number, value: number) => {
    const data = Buffer.from(header);
    data[offset] = value;
    return replace('IHDR', data);
  };
  const badCrc = Buffer.from(committed);
  badCrc.writeUInt32BE(0, badCrc.length - 4);
  const badLength = Buffer.from(committed);
  badLength.writeUInt32BE(0x7fffffff, 8);
  const badAdler = Buffer.from(compressed);
  badAdler.writeUInt32BE(0, badAdler.length - 4);
  const badFilter = Buffer.from(scanlines);
  badFilter[0] = 5;
  const unsupportedFilter = Buffer.from(scanlines);
  // A valid Sub-filtered first row of the same image is outside this fallback.
  for (let x = header.readUInt32BE(0); x > 1; x -= 1) {
    const here = scanlines[x];
    const left = scanlines[x - 1];
    assert(here !== undefined && left !== undefined);
    unsupportedFilter[x] = (here - left + 256) % 256;
  }
  unsupportedFilter[0] = 1;
  const gamma = { kind: 'gAMA', data: Buffer.from('000186a0', 'hex') };
  const phys = Buffer.from('00000b1300000b1302', 'hex');
  const invalidType = Buffer.from(pngChunk('gAMA', gamma.data));
  invalidType[4] = 0xe7; // Must not alias ASCII 'g' when parsing chunk types.
  invalidType.writeUInt32BE(crc32(invalidType.subarray(4, -4)), invalidType.length - 4);
  const cases: [string, Buffer][] = [
    ['bad PNG signature', Buffer.concat([Buffer.alloc(8), committed.subarray(8)])],
    ['chunk length exceeds remaining file', badLength],
    ['invalid chunk CRC', badCrc],
    ['truncated chunk', committed.subarray(0, -1)],
    ['missing IHDR', make(chunks.filter(chunk => chunk.kind !== 'IHDR'))],
    ['duplicate IHDR', make([{ kind: 'IHDR', data: header }, ...chunks])],
    ['missing palette', make(chunks.filter(chunk => chunk.kind !== 'PLTE'))],
    ['invalid palette length', replace('PLTE', Buffer.alloc(767))],
    ['invalid transparency length', replace('tRNS', Buffer.alloc(257))],
    ['transparency before palette', make(chunks.flatMap(chunk => chunk.kind === 'IHDR' ? [chunk, { kind: 'tRNS', data: Buffer.from([0]) }] : chunk.kind === 'tRNS' ? [] : [chunk]))],
    ['palette index outside palette', make(chunks.map(chunk => chunk.kind === 'PLTE' ? { kind: 'PLTE', data: Buffer.alloc(3) } : chunk.kind === 'tRNS' ? { kind: 'tRNS', data: Buffer.from([0]) } : chunk))],
    ['zero gamma', withGamma(committed, 0)],
    ['duplicate gamma', withGamma(withGamma(committed, 100000), 100000)],
    ['gamma after palette', make(chunks.flatMap(chunk => chunk.kind === 'PLTE' ? [chunk, gamma] : [chunk]))],
    ['invalid pHYs unit', replace('pHYs', phys)],
    ['nonconsecutive IDAT', make(chunks.filter(chunk => chunk.kind !== 'pHYs').flatMap(chunk => chunk.kind === 'IDAT' ? [
      { kind: 'IDAT', data: recompressed.subarray(0, 7) },
      { kind: 'pHYs', data: Buffer.from('00000b1300000b1301', 'hex') },
      { kind: 'IDAT', data: recompressed.subarray(7) },
    ] : [chunk]))],
    ['missing IDAT', make(chunks.filter(chunk => chunk.kind !== 'IDAT'))],
    ['missing IEND', make(chunks.filter(chunk => chunk.kind !== 'IEND'))],
    ['IEND with data', replace('IEND', Buffer.from([0]))],
    ['trailing data after IEND', Buffer.concat([committed, Buffer.from([0])])],
    ['unknown ancillary chunk', make(chunks.flatMap(chunk => chunk.kind === 'IHDR' ? [chunk, { kind: 'tEXt', data: Buffer.from('Comment\0test') }] : [chunk]))],
    ['unknown critical chunk', make(chunks.flatMap(chunk => chunk.kind === 'IHDR' ? [chunk, { kind: 'ABCD', data: Buffer.alloc(0) }] : [chunk]))],
    ['animation chunk', make(chunks.flatMap(chunk => chunk.kind === 'IHDR' ? [chunk, { kind: 'acTL', data: Buffer.from('0000000100000000', 'hex') }] : [chunk]))],
    ['non-ASCII chunk type', Buffer.concat([committed.subarray(0, 33), invalidType, committed.subarray(33)])],
    ['truncated zlib stream', replace('IDAT', compressed.subarray(0, -1))],
    ['invalid Adler checksum with valid chunk CRC', replace('IDAT', badAdler)],
    ['trailing bytes in IDAT', replace('IDAT', Buffer.concat([compressed, Buffer.from([0, 1])]))],
    ['concatenated zlib streams', replace('IDAT', Buffer.concat([compressed, compressed]))],
    ['too few decompressed scanline bytes', replace('IDAT', deflateSync(scanlines.subarray(0, -1)))],
    ['too many decompressed scanline bytes', replace('IDAT', deflateSync(Buffer.concat([scanlines, Buffer.from([0])])) )],
    ['invalid scanline filter', replace('IDAT', deflateSync(badFilter))],
    ['unsupported valid scanline filter', replace('IDAT', deflateSync(unsupportedFilter))],
    ['unsupported color type', changedHeader(9, 6)],
    ['unsupported bit depth', changedHeader(8, 4)],
    ['unsupported interlace', changedHeader(12, 1)],
    ['invalid compression method', changedHeader(10, 1)],
    ['invalid filter method', changedHeader(11, 1)],
    ['geometry exceeds derivative limit', changedHeader(0, 1)],
    ['file exceeds byte limit', Buffer.concat([committed, Buffer.alloc(2 * 1024 * 1024)])],
    ['excessive chunk count', make(chunks.flatMap(chunk => chunk.kind === 'IDAT' ? [...Array.from({ length: 256 }, () => ({ kind: 'IDAT', data: Buffer.alloc(0) })), chunk] : [chunk]))],
  ];
  for (const [name, bytes] of cases) {
    await t.test(name, async () => {
      assert.equal(await samePngContent(bytes, bytes), false, 'identical malformed or unsupported inputs must not receive an equivalence PASS');
      assert.equal(await samePngContent(committed, bytes), false);
      assert.equal(await samePngContent(bytes, committed), false);
    });
  }
});

function createCliFixture() {
  const root = mkdtempSync(join(tmpdir(), 'michel-icons-'));
  try {
    const source = join(root, 'public/icons');
    const output = join(source, 'derived');
    mkdirSync(output, { recursive: true });
    mkdirSync(join(root, 'tools/assets'), { recursive: true });
    copyFileSync(join(repository, 'tools/assets/icons.ts'), join(root, 'tools/assets/icons.ts'));
    copyFileSync(join(repository, 'package.json'), join(root, 'package.json'));
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    copyFileSync(join(repository, 'public/icons', artwork), join(source, artwork));
    const manifest = JSON.parse(readFileSync(join(repository, 'public/icons/derived/manifest.json'), 'utf8')) as IconManifest;
    manifest.icons = manifest.icons.filter(icon => icon.key === 'ai-assistant');
    assert.equal(manifest.icons.length, 1);
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const name of readdirSync(join(repository, 'public/icons/derived')).filter(name => name.startsWith('ai-assistant-'))) {
      copyFileSync(join(repository, 'public/icons/derived', name), join(output, name));
    }
    const snapshot = () => Object.fromEntries(readdirSync(output).sort().map(name => [name, readFileSync(join(output, name))]));
    const before = snapshot();
    assert.equal(Object.keys(before).length, 11);
    const run = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', join(root, 'tools/assets/icons.ts'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 180000,
    });
    return { root, source, output, snapshot, before, run };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('SR-REVIEW-1: actual CLI rejects valid gamma drift without writing or repairing files', () => {
  const { root, output, snapshot, run } = createCliFixture();
  try {
    for (const gamma of [100000, 45455]) {
      writeFileSync(join(output, derivative), withGamma(committed, gamma));
      const before = snapshot();
      const result = run(['--check']);
      assert.equal(result.status, 1, result.error?.message ?? result.stdout + result.stderr);
      assert(result.stderr.includes(derivative));
      assert.match(result.stdout, /0 file\(s\) written/);
      assert.deepEqual(snapshot(), before, '--check must retain the altered image and every other output byte');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual icon CLI preserves existing artwork derivatives and rejects drift without writing', () => {
  const { root, source, output, snapshot, before, run } = createCliFixture();
  try {
    for (const args of [['--check'], []]) {
      const result = run(args);
      assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
      assert.match(result.stdout, /\[icons\] 1 icons, 0 file\(s\) written/);
      assert.deepEqual(snapshot(), before, 'checking and generation retain compatible committed bytes');
    }
    writeFileSync(join(output, derivative), 'damaged derivative');
    writeFileSync(join(output, 'manifest.json'), '{}\n');
    const damaged = snapshot();
    const failure = run(['--check']);
    assert.equal(failure.status, 1, failure.error?.message ?? failure.stdout + failure.stderr);
    assert(failure.stderr.includes(derivative));
    assert.match(failure.stderr, /manifest is out of date/);
    assert.deepEqual(snapshot(), damaged, '--check reports drift without repairing it');
    assert.deepEqual(readFileSync(join(source, artwork)), readFileSync(join(repository, 'public/icons', artwork)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
