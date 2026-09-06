import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('.github/scripts/verify-gauntlet-reports.mjs');
const sha = 'a'.repeat(40);
const paths = ['.swarm/gauntlet-report.json', '.swarm/receipt-consumer-integration.json'];
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'michel-report-retention-'));
  try {
    await mkdir(join(root, '.swarm'));
    await writeFile(join(root, paths[0]!), JSON.stringify({ verdict: 'PASSED', rounds: [] }));
    await writeFile(join(root, paths[1]!), JSON.stringify({ michelCandidateSha: sha, applicationCertification: false }));
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const verify = (root: string, candidate = sha) => spawnSync(process.execPath, [script], {
  cwd: root, env: { ...process.env, MICHEL_CANDIDATE_SHA: candidate }, encoding: 'utf8', timeout: 10000,
});
const blocked = (result: ReturnType<typeof verify>) => {
  assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, '');
};

test('retention preflight verifies exactly two hidden reports and ignores operational files', async () => {
  await fixture(async root => {
    await mkdir(join(root, '.swarm/factory-source'));
    await mkdir(join(root, '.swarm/quality-governance'));
    await writeFile(join(root, '.swarm/quality-governance/credentials.json'), 'PRIVATE_SENTINEL');
    await writeFile(join(root, '.swarm/governance.sqlite'), 'PRIVATE_SENTINEL');
    const result = verify(root); assert.equal(result.status, 0, result.stderr);
    assert(!result.stdout.includes('PRIVATE_SENTINEL'));
    const evidence = JSON.parse(result.stdout) as { candidateSha: string; files: Array<{ path: string; bytes: number; sha256: string }> };
    assert.equal(evidence.candidateSha, sha); assert.deepEqual(evidence.files.map(f => f.path), paths);
    for (const file of evidence.files) {
      const bytes = await readFile(join(root, file.path));
      assert.equal(file.bytes, bytes.length); assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
  });
});
for (const missing of paths) {
  test(`retention fails when only ${missing} is missing`, async () => {
    await fixture(async root => { await rm(join(root, missing)); blocked(verify(root)); });
  });
}
test('retention fails on malformed report JSON without printing its contents', async () => {
  await fixture(async root => {
    await writeFile(join(root, paths[0]!), 'PRIVATE_SENTINEL malformed');
    const result = verify(root); blocked(result); assert(!result.stderr.includes('PRIVATE_SENTINEL'));
  });
});
test('retention fails on an empty required report', async () => {
  await fixture(async root => { await writeFile(join(root, paths[0]!), ''); blocked(verify(root)); });
});
test('retention rejects a report symlink to an operational file', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'private.json'), '{"secret":"PRIVATE_SENTINEL"}');
    await rm(join(root, paths[0]!)); await symlink(join(root, 'private.json'), join(root, paths[0]!));
    const result = verify(root); blocked(result); assert(!result.stderr.includes('PRIVATE_SENTINEL'));
  });
});
test('retention rejects a symlinked operational directory', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'operational')); await rm(join(root, '.swarm'), { recursive: true });
    await symlink(join(root, 'operational'), join(root, '.swarm')); blocked(verify(root));
  });
});
test('retention rejects a directory in place of a required report', async () => {
  await fixture(async root => { await rm(join(root, paths[0]!)); await mkdir(join(root, paths[0]!)); blocked(verify(root)); });
});
test('retention rejects stale candidate identity', async () => {
  await fixture(async root => { blocked(verify(root, 'b'.repeat(40))); });
});
test('retention rejects a missing exact CI candidate', async () => {
  await fixture(async root => { blocked(verify(root, '')); });
});
test('CI upload allowlist excludes operational directories and depends on both reports verifying', async () => {
  const workflow = await readFile(resolve('.github/workflows/gauntlet.yml'), 'utf8');
  const upload = workflow.split('      - name: Upload gauntlet report\n')[1]!.split('      - name:')[0]!;
  const allowlist = upload.split('          path: |\n')[1]!.split('          include-hidden-files:')[0]!.trim().split('\n').map(p => p.trim());
  assert.deepEqual(allowlist, paths);
  assert.match(upload, /include-hidden-files: true/); assert.match(upload, /if-no-files-found: error/);
  assert.match(upload, /if: always\(\) && steps\.required-reports\.outcome == 'success'/);
  assert.match(workflow, /id: required-reports/); assert.match(workflow, /run: node \.github\/scripts\/verify-gauntlet-reports\.mjs/);
});
