import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { consumeStoredFactoryReceipt, loadPinnedFactory, FACTORY_SHA, FACTORY_TREE,
  type PinnedFactory, type QualityGateReceipt } from '../../docs/deploy/factory-quality-consumer.ts';
import { fixture } from './factory-quality-fixture.ts';

let factory: PinnedFactory;
before(async () => { factory = await loadPinnedFactory(); });
after(async () => { await factory?.close(); });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('actual pinned Factory evaluator, stored re-admission/resolver and Michel consumer interoperate', async () => {
  const f = await fixture(factory);
  assert.equal(factory.candidateSha, FACTORY_SHA);
  const pin = JSON.parse(await readFile(resolve('docs/deploy/factory-quality-pin.json'), 'utf8'));
  assert.equal(pin.candidateSha, FACTORY_SHA); assert.equal(pin.treeSha, FACTORY_TREE);
  const original = f.mint();
  assert.equal(original.schemaVersion, '1.2.0'); assert.equal(original.finalState, 'pass');
  assert.equal(original.scopeStatus.productionDeploymentObservation, 'not-evaluated-pre-deployment');
  // A serialized receipt has lost its in-memory trust and must be regenerated, not merely hashed.
  const stored = copy(original);
  assert.throws(() => factory.quality.createQualityGateReceiptRecord(stored, stored.receiptId, 'caller', stored.evaluatedAt));
  const result = consumeStoredFactoryReceipt(factory, stored, f.input.candidateSha, f.context);
  assert.equal(result.state, 'pass', result.reason);
  assert.equal(result.qualityEvidenceGrantsActionAuthority, false);
  assert.equal(result.cristianDeploymentApproval, 'required-separately');
  await mkdir(resolve('.swarm'), { recursive: true });
  await writeFile(resolve('.swarm/receipt-consumer-integration.json'), JSON.stringify({
    schemaVersion: '1.0.0', evidenceScope: 'deterministic-integration-fixture-only',
    michelCandidateSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    factoryCandidateSha: FACTORY_SHA, factoryTreeSha: FACTORY_TREE, canonicalSchema: original.schemaVersion,
    fixtureReceiptId: original.receiptId, fixtureCandidateSha: original.candidateSha,
    actualPinnedEvaluatorAndResolverInvoked: true, serializedReceiptReadmittedAndReevaluated: true,
    fixtureConsumptionState: result.state, applicationCertification: false, productionObservation: false,
    qualityEvidenceGrantsActionAuthority: false,
  }, null, 2) + '\n');
});

test('fabricated schema/digest-valid PASS without verified execution cannot satisfy Michel', async () => {
  const f = await fixture(factory); const receipt = copy(f.mint());
  assert.deepEqual(factory.quality.validateCanonicalQualityGateReceipt(receipt), []);
  assert.equal(consumeStoredFactoryReceipt(factory, receipt, f.input.candidateSha, null).state, 'needs-evidence');
  assert.equal(consumeStoredFactoryReceipt(factory, receipt, f.input.candidateSha,
    { input: f.input, dependencies: { evidenceAdapters: [] } }).state, 'needs-evidence');
  f.records.clear();
  assert.equal(consumeStoredFactoryReceipt(factory, receipt, f.input.candidateSha, f.context).state, 'needs-evidence');
});

for (const field of ['repository', 'taskId', 'projectId', 'candidateSha', 'branch', 'scope'] as const) {
  test(`canonical receipt for incorrect ${field} cannot be substituted`, async () => {
    const expected = await fixture(factory); const wrong = await fixture(factory);
    if (field === 'repository') wrong.input.repository = 'attacker/alternate';
    if (field === 'taskId') { wrong.input.taskId = 'another-task'; wrong.input.taskContract.id = 'another-task'; }
    if (field === 'projectId') { wrong.input.projectId = 'another-project'; wrong.input.taskContract.projectId = 'another-project'; }
    if (field === 'candidateSha') { wrong.input.candidateSha = 'b'.repeat(40); wrong.input.taskContract.repository.commit = 'b'.repeat(40); }
    if (field === 'branch') { wrong.input.branch = 'another-branch'; wrong.input.taskContract.repository.branch = 'another-branch'; }
    if (field === 'scope') wrong.input.evaluationScope = 'full-lifecycle';
    assert.notEqual(consumeStoredFactoryReceipt(factory, copy(wrong.mint()), expected.input.candidateSha, expected.context).state, 'pass');
  });
}

test('evaluator-minted weaker-policy PASS cannot replace the independently expected policy', async () => {
  const f = await fixture(factory); const expected = copy(f.input);
  f.input.riskTier = 'T1'; f.input.taskContract.risk.tier = 'T1';
  f.input.taskContract.approvalGates = [];
  f.input.acceptanceCriteria = [f.input.acceptanceCriteria[0]!];
  f.input.taskContract.acceptanceCriteria = f.input.acceptanceCriteria;
  f.input.requiredEvidence = ['unit']; f.input.taskContract.requiredEvidence = ['unit'];
  f.input.changeSignals.performanceSurfaces = []; f.input.changeSignals.performanceFailureMaterial = false;
  const weak = f.mint(); assert.equal(weak.finalState, 'pass');
  assert.notEqual(consumeStoredFactoryReceipt(factory, weak, expected.candidateSha,
    { input: expected, dependencies: f.context.dependencies }).state, 'pass');
  assert.equal(consumeStoredFactoryReceipt(factory, weak, expected.candidateSha, f.context).state, 'blocked', 'weak trusted-context floor accepted');
});

test('changed criteria or required evidence cannot be substituted even at the same risk', async () => {
  const f = await fixture(factory); const expected = copy(f.input);
  f.input.acceptanceCriteria[0]!.statement = 'different requirement';
  assert.notEqual(consumeStoredFactoryReceipt(factory, f.mint(), expected.candidateSha,
    { input: expected, dependencies: f.context.dependencies }).state, 'pass');
});

test('stale exact-candidate records and stale receipts cannot certify readiness', async () => {
  const f = await fixture(factory); const good = copy(f.mint());
  const record = f.records.get('test-fixture:unit')!;
  const { integrityDigest: _, ...rest } = record;
  const stale = { ...rest, candidateSha: 'b'.repeat(40) };
  f.records.set(record.sourceId, { ...stale, integrityDigest: factory.admission.trustedRecordDigest(stale) });
  assert.notEqual(consumeStoredFactoryReceipt(factory, good, f.input.candidateSha, f.context).state, 'pass');
  assert.equal(consumeStoredFactoryReceipt(factory, good, f.input.candidateSha, f.context,
    new Date(Date.parse(f.input.evaluatedAt) + 86400001)).state, 'blocked');
});

test('digest tampering, malformed SHA and authority-granting receipts fail closed', async () => {
  const f = await fixture(factory); const good = copy(f.mint());
  const tampered = { ...good, receiptId: 'f'.repeat(64) };
  assert.equal(consumeStoredFactoryReceipt(factory, tampered, f.input.candidateSha, f.context).state, 'blocked');
  assert.equal(consumeStoredFactoryReceipt(factory, good, 'main', f.context).state, 'blocked');
  const altered = copy(good) as unknown as { controlPlane: { qualityEvidenceGrantsActionAuthority: boolean } };
  altered.controlPlane.qualityEvidenceGrantsActionAuthority = true;
  const forged = altered as unknown as QualityGateReceipt;
  forged.receiptId = factory.quality.qualityGateReceiptDigest(forged);
  assert.equal(consumeStoredFactoryReceipt(factory, forged, f.input.candidateSha, f.context).state, 'blocked');
});

test('full lifecycle is a separate evaluator result and cannot pass before observation/approval', async () => {
  const f = await fixture(factory); const pre = f.mint(); f.input.evaluationScope = 'full-lifecycle';
  const post = f.mint(); assert.notEqual(post.finalState, 'pass');
  assert.equal(post.scopeStatus.productionDeploymentObservation, 'needs-evidence');
  assert.notEqual(pre.receiptId, post.receiptId); assert.notEqual(pre.scopeBindingId, post.scopeBindingId);
  assert.equal(post.controlPlane.qualityEvidenceGrantsActionAuthority, false);
});

test('valid pre-deployment Quality readiness cannot satisfy absent or wrong deployment authorization', async (t) => {
  const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const f = await fixture(factory, actualHead);
  assert.equal(consumeStoredFactoryReceipt(factory, f.mint(), f.input.candidateSha, f.context).state, 'pass');
  const dir = await mkdtemp(join(tmpdir(), 'michel-consumer-approval-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const shell = (approval: string) => spawnSync('sh', ['-c', '. "$1"; michel_validate_bootstrap_approval "$2" "$3" "$4" "$5" "$5"',
    'test', resolve('docs/deploy/lib.sh'), process.cwd(), f.input.candidateSha, approval, 'f'.repeat(64)], { encoding: 'utf8' });
  assert.notEqual(shell(join(dir, 'absent.json')).status, 0);
  const approval = join(dir, 'wrong.json');
  await writeFile(approval, JSON.stringify({ approvedBy: 'Cristian', state: 'approved', candidateSha: 'b'.repeat(40) }));
  assert.notEqual(shell(approval).status, 0);
});

test('actual shell consumer rejects JSON-only input when trusted operational context is absent', async (t) => {
  const f = await fixture(factory); const dir = await mkdtemp(join(tmpdir(), 'michel-consumer-shell-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = JSON.stringify(f.mint()); const receipt = join(dir, 'receipt.json'); await writeFile(receipt, bytes);
  const result = spawnSync('sh', ['-c', '. "$1"; michel_validate_quality_receipt "$2" "$3" "$4" "$5" "$6"', 'test',
    resolve('docs/deploy/lib.sh'), receipt, f.input.candidateSha, createHash('sha256').update(bytes).digest('hex'), process.cwd(), dir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.equal(JSON.parse(result.stdout).state, 'needs-evidence');
});

test('actual shell adapter revalidates a stored evaluator receipt in a new process through trusted fixture context', async (t) => {
  const f = await fixture(factory); const directory = await mkdtemp(join(tmpdir(), 'michel-trusted-context-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contextDirectory = join(directory, '.swarm/quality-governance'); await mkdir(contextDirectory, { recursive: true, mode: 0o700 });
  // Explicit operator-owned TEST context, no production endpoint or credential and no hand-authored receipt.
  const bundle = { input: f.input, records: [...f.records] };
  const module = `export async function createContext(factory) {
    const fixture = ${JSON.stringify(bundle)};
    const records = new Map(fixture.records);
    return {input: fixture.input, dependencies: {evidenceAdapters: [
      factory.admission.createTrustedExecutionEvidenceAdapter('test-fixture-only',
        ['boris-test-run','security-runner','performance-runner','independent-reviewer'], id => records.get(id) ?? null)
    ]}};
  }`;
  await writeFile(join(contextDirectory, 'context.mjs'), module, { mode: 0o600 });
  const bytes = JSON.stringify(f.mint()); const receipt = join(directory, 'receipt.json'); await writeFile(receipt, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const run = (hash: string) => spawnSync('sh', ['-c', '. "$1"; michel_validate_quality_receipt "$2" "$3" "$4" "$5" "$6"', 'test',
    resolve('docs/deploy/lib.sh'), receipt, f.input.candidateSha, hash, process.cwd(), directory], { encoding: 'utf8', timeout: 60000 });
  const passed = run(digest); assert.equal(passed.status, 0, passed.stderr + passed.stdout);
  assert.equal(JSON.parse(passed.stdout).state, 'pass');
  assert.equal(JSON.parse(passed.stdout).qualityEvidenceGrantsActionAuthority, false);
  assert.notEqual(run('f'.repeat(64)).status, 0, 'digest mismatch passed the real shell adapter');
});
