import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('every client route points at a real view module', async () => {
  const source = await readFile(resolve(root, 'public/app.js'), 'utf8');
  const modules = [...source.matchAll(/import\('([^']*views\/[^']+\.js)'\)/g)].map((match) => match[1]!);

  assert.ok(modules.length >= 10, 'expected the router to contain the Michel OS view modules');
  assert.equal(new Set(modules).size, modules.length, 'route imports should not be duplicated accidentally');

  for (const specifier of modules) {
    const path = resolve(root, 'public', specifier.replace(/^\.\//, ''));
    await assert.doesNotReject(access(path), `missing route module ${specifier}`);
  }
});

test('all browser view modules are valid JavaScript', async () => {
  const dir = resolve(root, 'public/views');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.js')).sort();
  assert.ok(files.length >= 12, 'expected the completed V1 view set');

  for (const file of files) {
    const checked = spawnSync(process.execPath, ['--check', resolve(dir, file)], { encoding: 'utf8' });
    assert.equal(checked.status, 0, `${file} has invalid JavaScript:\n${checked.stderr}`);
  }
});

test('VPS deployment bundle contains the required production pieces', async () => {
  for (const file of ['Dockerfile', 'compose.yml', 'Caddyfile', '.env.example', 'backup.sh', 'restore.sh', 'README.md']) {
    await assert.doesNotReject(access(resolve(root, 'docs/deploy', file)), `missing docs/deploy/${file}`);
  }
});
