import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repository = process.cwd();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
interface LintReport {
  candidateSha: string; treeSha: string; exactCandidate: boolean; state: string; exitCode: number;
  eslintExitCode: number | null; command: string; evidenceState: string; qualityEvidenceGrantsActionAuthority: boolean;
  checkedFiles: Array<{ path: string; sha256: string }>;
  configuration: Array<{ path: string; sha256: string }>;
  diagnostics: Array<{ path: string; ruleId: string; message: string }>;
  negativeControl: { eslintExitCode: number; expectedRule: string; violationRejected: boolean };
}
function fixture(source: string, check: (root: string, sha: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'michel-lint-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    for (const path of ['eslint.config.mjs', 'tools/lint/run.mjs', 'package.json', 'package-lock.json']) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); copyFileSync(join(repository, path), join(root, path));
    }
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.swarm/\n');
    mkdirSync(join(root, 'server')); writeFileSync(join(root, 'server/check.ts'), source);
    mkdirSync(join(root, '.swarm')); writeFileSync(join(root, '.swarm/credentials.json'), 'PRIVATE_SENTINEL');
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Lint Fixture', '-c', 'user.email=lint@example.invalid', 'commit', '-qm', 'disposable lint fixture');
    check(root, git('rev-parse', 'HEAD'));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const run = (root: string, sha: string, args: string[] = []) => spawnSync('npm', ['run', 'lint', ...args], {
  cwd: root, env: { ...process.env, CI: 'true', MICHEL_CANDIDATE_SHA: sha }, encoding: 'utf8', timeout: 30000,
});
const report = (root: string) => JSON.parse(readFileSync(join(root, '.swarm/lint-report.json'), 'utf8')) as LintReport;

test('same npm lint command checks real files and retains exact candidate/config identity with no source or secrets', () => {
  fixture('export const value: number = 1;\n', (root, sha) => {
    const result = run(root, sha); assert.equal(result.status, 0, result.stdout + result.stderr);
    const r = report(root); assert.equal(r.exitCode, 0); assert.equal(r.eslintExitCode, 0);
    assert.equal(r.state, 'pass'); assert.equal(r.candidateSha, sha); assert.equal(r.exactCandidate, true);
    assert.equal(r.command, 'npm run lint'); assert.equal(r.evidenceState, 'raw-unverified');
    assert.equal(r.qualityEvidenceGrantsActionAuthority, false);
    assert.equal(r.negativeControl.eslintExitCode, 1); assert.equal(r.negativeControl.expectedRule, 'no-debugger');
    assert.equal(r.negativeControl.violationRejected, true);
    assert.deepEqual(r.checkedFiles.map(f => f.path), ['eslint.config.mjs', 'server/check.ts', 'tools/lint/run.mjs']);
    for (const f of [...r.checkedFiles, ...r.configuration]) assert.equal(f.sha256, hash(readFileSync(join(root, f.path))));
    assert(!JSON.stringify(r).includes('PRIVATE_SENTINEL')); assert(!JSON.stringify(r).includes('export const value'));
  });
});
test('controlled negative: known debugger violation fails the same npm lint command and persists actual diagnostics', () => {
  fixture('debugger;\nexport const value: number = 1;\n', (root, sha) => {
    const before = readFileSync(join(root, 'server/check.ts'));
    const result = run(root, sha); assert.equal(result.status, 1, result.stdout + result.stderr);
    const r = report(root); assert.equal(r.state, 'fail'); assert.equal(r.exitCode, 1); assert.equal(r.eslintExitCode, 1);
    assert(r.diagnostics.some(d => d.path === 'server/check.ts' && d.ruleId === 'no-debugger'));
    assert.deepEqual(readFileSync(join(root, 'server/check.ts')), before, 'lint must not autofix source');
  });
});
test('inline blanket suppression cannot hide a known violation', () => {
  fixture('/* eslint-disable */\ndebugger;\n', (root, sha) => {
    assert.equal(run(root, sha).status, 1);
    assert(report(root).diagnostics.some(d => d.ruleId === 'no-debugger'));
  });
});
test('lint rejects a mismatched exact CI candidate', () => {
  fixture('export const value = 1;\n', (root) => {
    assert.equal(run(root, 'f'.repeat(40)).status, 2); assert.equal(report(root).state, 'error');
  });
});
test('lint rejects caller-requested subset execution or rule overrides', () => {
  fixture('export const value = 1;\n', (root, sha) => {
    assert.equal(run(root, sha, ['--', 'server/check.ts']).status, 2);
    assert.equal(report(root).eslintExitCode, null);
  });
});
test('zero-file lint cannot pass', () => {
  fixture('export const value = 1;\n', (root) => {
    execFileSync('git', ['rm', 'eslint.config.mjs', 'tools/lint/run.mjs', 'server/check.ts'], { cwd: root });
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    metadata.scripts.lint = `node ${join(repository, 'tools/lint/run.mjs')}`;
    writeFileSync(join(root, 'package.json'), JSON.stringify(metadata));
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Lint Fixture', '-c', 'user.email=lint@example.invalid', 'commit', '-qm', 'no source files'], { cwd: root });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(run(root, sha).status, 2); assert.equal(report(root).checkedFiles.length, 0);
    assert.equal(report(root).eslintExitCode, null);
  });
});
test('dirty CI source cannot claim exact-candidate evidence', () => {
  fixture('export const value = 1;\n', (root, sha) => {
    writeFileSync(join(root, 'server/check.ts'), 'export const value = 2;\n');
    assert.equal(run(root, sha).status, 2); assert.equal(report(root).exactCandidate, false);
  });
});
test('CI invokes normal lint without masking its exit, and retains all three allowlisted reports after failure', () => {
  const workflow = readFileSync(resolve('.github/workflows/gauntlet.yml'), 'utf8');
  const step = workflow.split('      - name: Run lint\n')[1]!.split('      - name:')[0]!;
  assert.match(step, /run: npm run lint\n/); assert.doesNotMatch(step, /continue-on-error: true|\|\| true/);
  assert.match(workflow, /steps\.lint\.outcome != 'skipped'/);
  const upload = workflow.split('      - name: Upload gauntlet report\n')[1]!.split('      - name:')[0]!;
  assert.match(upload, /\.swarm\/lint-report\.json/); assert.match(upload, /include-hidden-files: true/);
  assert.match(upload, /if-no-files-found: error/);
});
