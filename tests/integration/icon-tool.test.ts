import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('actual icon CLI preserves existing artwork derivatives and rejects drift without writing', () => {
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
