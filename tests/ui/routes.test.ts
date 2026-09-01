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
  // Several routes intentionally share one view: Shopping/Errands/Reminders use
  // lists.js and every Shia Baby sub-route uses business.js. What matters is
  // that every referenced module exists, not that every route has a unique file.
  for (const specifier of new Set(modules)) {
    const path = resolve(root, 'public', specifier.replace(/^\.\//, ''));
    await assert.doesNotReject(access(path), `missing route module ${specifier}`);
  }
});

const viewDir = resolve(root, 'public/views');
const viewFiles = (await readdir(viewDir)).filter((name) => name.endsWith('.js')).sort();

test('completed V1 view set is present', () => {
  assert.ok(viewFiles.length >= 12, 'expected the completed V1 view set');
});

for (const file of viewFiles) {
  test(`browser view parses: ${file}`, () => {
    const checked = spawnSync(process.execPath, ['--check', resolve(viewDir, file)], { encoding: 'utf8' });
    assert.equal(checked.status, 0, `${file} has invalid JavaScript:\n${checked.stderr}`);
  });
}

test('VPS deployment bundle contains the required production pieces', async () => {
  for (const file of ['Dockerfile', 'compose.yml', 'Caddyfile', '.env.example', 'backup.sh', 'restore.sh',
    'restore-drill.sh', 'manual-rollback.sh', 'approve-deploy.sh', 'bootstrap-gated-release.sh', 'README.md']) {
    await assert.doesNotReject(access(resolve(root, 'docs/deploy', file)), `missing docs/deploy/${file}`);
  }
});
