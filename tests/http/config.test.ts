/**
 * Boot configuration (Agent B3).
 *
 * This is the only layer whose input is a person typing into a `.env` file, so
 * it has more ways to be wrong than anything else in the codebase and each one
 * should fail in a hundred milliseconds with a sentence naming the variable —
 * not sixty seconds later as a connection timeout, and never as a login that
 * silently never sticks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigError, normalizeReleaseSha, readConfig } from '../../server/main.ts';

const base = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgres://michel:pw@db:5432/michel',
  BASE_URL: 'https://michel.example.com',
  ...extra,
} as NodeJS.ProcessEnv);

test('a complete configuration reads through', () => {
  const config = readConfig(base({ PORT: '8080' }));
  assert.equal(config.port, 8080);
  assert.equal(config.https, true);
  assert.deepEqual(config.allowedOrigins, ['https://michel.example.com']);
});

test('release provenance accepts only an exact 40-character Git SHA and normalizes case', () => {
  assert.equal(normalizeReleaseSha('ABCDEF0123456789ABCDEF0123456789ABCDEF01'),
    'abcdef0123456789abcdef0123456789abcdef01');
  for (const value of ['', 'main', 'abcdef0', 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)]) {
    assert.equal(normalizeReleaseSha(value), null, `trusted malformed provenance ${JSON.stringify(value)}`);
  }
});

test('the port defaults rather than being required', () => {
  assert.equal(readConfig(base()).port, 3000);
});

test('a missing DATABASE_URL names the variable and the fix', () => {
  assert.throws(() => readConfig({ BASE_URL: 'https://x.example' } as NodeJS.ProcessEnv), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /DATABASE_URL/);
    assert.match(error.message, /\.env/);
    return true;
  });
});

test('a missing BASE_URL is refused', () => {
  assert.throws(
    () => readConfig({ DATABASE_URL: 'postgres://x/y' } as NodeJS.ProcessEnv),
    /BASE_URL/,
  );
});

test('a BASE_URL that is not a URL is refused', () => {
  assert.throws(() => readConfig(base({ BASE_URL: 'michel.example.com' })), /not a valid URL/);
});

test('a non-http scheme is refused', () => {
  assert.throws(() => readConfig(base({ BASE_URL: 'ftp://michel.example.com' })), /http or https/);
});

test('a nonsense PORT is refused rather than silently becoming NaN', () => {
  for (const port of ['', 'eighty', '0', '-1', '70000', '8080.5']) {
    assert.throws(() => readConfig(base({ PORT: port })), /PORT/, `accepted ${JSON.stringify(port)}`);
  }
});

test('an http BASE_URL is refused unless the insecurity is confirmed', () => {
  // http means the session cookie cannot be Secure. That is fine on a laptop
  // and not fine on the internet, and the difference cannot be guessed from
  // the URL — so it has to be stated.
  assert.throws(() => readConfig(base({ BASE_URL: 'http://localhost:3000' })), /ALLOW_INSECURE/);

  const config = readConfig(base({ BASE_URL: 'http://localhost:3000', ALLOW_INSECURE: 'true' }));
  assert.equal(config.https, false);
});

test('extra origins are normalised and de-duplicated', () => {
  const config = readConfig(base({
    EXTRA_ORIGINS: 'https://192.168.1.20:8443/, https://MICHEL.example.com, https://michel.example.com',
  }));
  // Each one through `new URL(...).origin`, so a trailing slash or an uppercase
  // host cannot produce an entry that never matches a real Origin header.
  assert.deepEqual(config.allowedOrigins, ['https://michel.example.com', 'https://192.168.1.20:8443']);
});

test('an empty EXTRA_ORIGINS is not an error', () => {
  assert.deepEqual(readConfig(base({ EXTRA_ORIGINS: '  ,  ' })).allowedOrigins,
    ['https://michel.example.com']);
});

test('a broken EXTRA_ORIGINS entry is named rather than skipped', () => {
  // Skipping it would leave a family who added their LAN address wondering why
  // login works on the domain and nowhere else.
  assert.throws(() => readConfig(base({ EXTRA_ORIGINS: 'https://ok.example, not a url' })),
    /EXTRA_ORIGINS/);
});

test('schema verification is on unless it is explicitly turned off', () => {
  assert.equal(readConfig(base()).verifySchema, true);
  assert.equal(readConfig(base({ SKIP_SCHEMA_VERIFY: 'true' })).verifySchema, false);
  // Anything other than the exact word leaves the check on: a footgun should
  // need the whole word, not a truthy-looking one.
  assert.equal(readConfig(base({ SKIP_SCHEMA_VERIFY: '1' })).verifySchema, true);
});

const releaseSha = 'abcdef0123456789abcdef0123456789abcdef01';
const otherSha = '1111111111111111111111111111111111111111';
const deployLib = resolve('docs/deploy/lib.sh');

function shell(script: string, ...args: string[]) {
  return spawnSync('/bin/sh', ['-c', script, 'test-shell', ...args], { encoding: 'utf8' });
}

test('Docker and both Compose topologies bind OCI and runtime provenance to the supplied candidate', async () => {
  const dockerfile = await readFile(resolve('docs/deploy/Dockerfile'), 'utf8');
  const shared = await readFile(resolve('docs/deploy/compose.shared-vps.yml'), 'utf8');
  const standalone = await readFile(resolve('docs/deploy/compose.yml'), 'utf8');

  assert.match(dockerfile, /ARG RELEASE_SHA/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{RELEASE_SHA\}"/);
  assert.match(dockerfile, /org\.opencontainers\.image\.source="\$\{SOURCE_REPOSITORY\}"/);
  assert.match(dockerfile, /ENV MICHEL_RELEASE_SHA="\$\{RELEASE_SHA\}"/);
  assert.match(dockerfile, /\^\[0-9a-f\]\{40\}\$\/i/);
  for (const compose of [shared, standalone]) {
    assert.match(compose, /RELEASE_SHA: \$\{MICHEL_RELEASE_SHA:\?/);
    assert.match(compose, /SOURCE_REPOSITORY: https:\/\/github\.com\/crizpy7-sketch\/Michel-OS/);
  }
});

test('deployment reconciliation accepts only three matching exact SHAs', () => {
  const valid = shell('. "$1"; michel_reconcile_release "$2" "$3" "$4"', deployLib,
    releaseSha, releaseSha.toUpperCase(), releaseSha);
  assert.equal(valid.status, 0, valid.stderr);

  for (const values of [
    [releaseSha, otherSha, releaseSha],
    [releaseSha, releaseSha, otherSha],
    [releaseSha, 'main', releaseSha],
  ]) {
    const result = shell('. "$1"; michel_reconcile_release "$2" "$3" "$4"', deployLib, ...values);
    assert.notEqual(result.status, 0, `accepted mismatched provenance ${values.join(' / ')}`);
  }
});

test('readiness parser accepts the exact field and rejects malformed or missing provenance', () => {
  const valid = shell('. "$1"; michel_readiness_release_sha "$2"', deployLib,
    JSON.stringify({ ready: true, releaseSha: releaseSha.toUpperCase() }));
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, releaseSha);

  for (const body of [
    JSON.stringify({ ready: true }),
    JSON.stringify({ ready: true, releaseSha: 'main' }),
    JSON.stringify({ ready: false, releaseSha }),
    JSON.stringify({ ready: false, releaseSha: `${releaseSha}extra` }),
  ]) {
    const result = shell('. "$1"; michel_readiness_release_sha "$2"', deployLib, body);
    assert.notEqual(result.status, 0, `accepted malformed readiness provenance ${body}`);
  }
});

test('a provenance mismatch cannot write or replace the deployed-sha stamp', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'michel-release-stamp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stamp = join(directory, 'deployed-sha');
  await writeFile(stamp, `${otherSha}\n`);

  const mismatch = shell('. "$1"; michel_write_deployed_stamp "$2" "$3" "$4" "$5"', deployLib,
    releaseSha, otherSha, releaseSha, stamp);
  assert.notEqual(mismatch.status, 0);
  assert.equal(await readFile(stamp, 'utf8'), `${otherSha}\n`);

  const accepted = shell('. "$1"; michel_write_deployed_stamp "$2" "$3" "$4" "$5"', deployLib,
    releaseSha, releaseSha, releaseSha, stamp);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(await readFile(stamp, 'utf8'), `${releaseSha}\n`);
});

test('auto-deploy reconciles target, readiness and image before its only successful stamp write', async () => {
  const source = await readFile(resolve('docs/deploy/auto-deploy.sh'), 'utf8');
  assert.match(source, /export MICHEL_RELEASE_SHA="\$TARGET"/);
  assert.match(source, /michel_readiness_release_sha "\$READY_BODY"/);
  assert.match(source, /michel_running_image_revision/);
  const reconcile = source.indexOf('michel_reconcile_release "$TARGET"');
  const stamp = source.indexOf('michel_write_deployed_stamp "$TARGET"');
  assert.ok(reconcile >= 0 && stamp > reconcile, 'deployment stamp was not guarded by provenance reconciliation');
  assert.doesNotMatch(source, /printf '%s\\n' "\$TARGET" > "\$STAMP"/);
  assert.match(source, /candidate was not stamped as deployed/);
});

test('deployment approval is exact, one-shot, and precedes every production mutation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'michel-deploy-approval-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const active = join(directory, 'active.json');
  const claimed = join(directory, 'claimed.json');
  const used = join(directory, 'used.json');
  const repository = resolve('.');
  const head = shell('git -C "$1" rev-parse HEAD', repository).stdout.trim().toLowerCase();
  const receipt = (candidateSha: string, state = 'approved') => JSON.stringify({
    schemaVersion: '1.0.0', kind: 'deployment-approval', action: 'deploy', state,
    candidateSha, repository: 'crizpy7-sketch/Michel-OS', approvedBy: 'Cristian',
    approvedAt: '2026-09-01T00:00:00Z', source: 'local-operator-confirmation',
  });

  const validate = () => shell('. "$1"; michel_validate_deploy_approval "$2" "$3" "$4"',
    deployLib, repository, head, active);
  assert.notEqual(validate().status, 0, 'missing approval authorized deployment');
  await writeFile(active, '{malformed');
  assert.notEqual(validate().status, 0, 'malformed approval authorized deployment');
  await writeFile(active, receipt(otherSha));
  assert.notEqual(validate().status, 0, 'approval for another SHA authorized deployment');
  await writeFile(active, receipt(head));
  assert.equal(validate().status, 0, 'exact candidate approval was not callable');

  const claim = shell('. "$1"; michel_claim_deploy_approval "$2" "$3" "$4" "$5"',
    deployLib, repository, head, active, claimed);
  assert.equal(claim.status, 0, claim.stderr);
  await assert.rejects(readFile(active), 'claimed approval remained reusable');
  assert.match(await readFile(claimed, 'utf8'), /"state": "claimed"/);
  assert.notEqual(validate().status, 0, 'failed/claimed approval silently became reusable');

  const consume = shell('. "$1"; michel_consume_deploy_approval "$2" "$3" "$4"',
    deployLib, head, claimed, used);
  assert.equal(consume.status, 0, consume.stderr);
  await assert.rejects(readFile(claimed), 'successful deployment left a claim reusable');
  assert.match(await readFile(used, 'utf8'), /"state": "consumed"/);
  assert.match(await readFile(used, 'utf8'), new RegExp(head));

  const source = await readFile(resolve('docs/deploy/auto-deploy.sh'), 'utf8');
  const approvalGate = source.indexOf('michel_validate_deploy_approval "$REPO_ROOT" "$TARGET"');
  const ciGate = source.indexOf('if [ "${MICHEL_REQUIRE_CI:-true}" = "true" ]');
  const claimGate = source.indexOf('michel_claim_deploy_approval "$REPO_ROOT" "$TARGET"');
  const backup = source.indexOf('sh ./backup.sh');
  const stamp = source.indexOf('michel_write_deployed_stamp "$TARGET"');
  const consumeGate = source.indexOf('michel_consume_deploy_approval "$TARGET"');
  assert.ok(approvalGate >= 0 && ciGate > approvalGate, 'CI was checked before exact human approval');
  assert.ok(claimGate > ciGate && backup > claimGate, 'approval was not claimed before the first mutation');
  assert.ok(consumeGate > stamp, 'approval was consumed before successful deployment stamping');
  assert.match(source, /CI can prove a candidate; it cannot authorize production/);
});

test('operator approval script is explicit, exact-SHA-only and writes ignored non-secret state', async () => {
  const source = await readFile(resolve('docs/deploy/approve-deploy.sh'), 'utf8');
  const ignore = await readFile(resolve('.gitignore'), 'utf8');
  assert.match(source, /michel_require_git_commit/);
  assert.match(source, /APPROVE DEPLOY \$\{TARGET\}/);
  assert.match(source, /approvedBy: 'Cristian'/);
  assert.match(source, /\.swarm\/deploy-approval\.json/);
  assert.doesNotMatch(source, /PASSWORD|TOKEN|SECRET|\.env/);
  assert.match(ignore, /^\.swarm\/$/m);
});

test('bootstrap policy refuses unsafe states and accepts only one exact fully-evidenced target', () => {
  const baseline = releaseSha;
  const target = otherSha;
  const invoke = (values: string[]) => shell('. "$1"; shift; michel_bootstrap_preflight "$@"',
    deployLib, ...values);
  const valid = [baseline, target, target, baseline, baseline,
    'false', 'false', 'false', target, 'pass', 'pass', 'pass'];
  assert.equal(invoke(valid).status, 0, invoke(valid).stderr);

  const mutations: Array<[number, string, string]> = [
    [5, 'true', 'legacy timer active'],
    [6, 'true', 'legacy timer enabled'],
    [7, 'true', 'legacy deployment service active'],
    [3, target, 'wrong live Git baseline'],
    [4, target, 'wrong deployed baseline'],
    [8, baseline, 'approval for another SHA'],
    [8, '', 'missing approval'],
    [9, 'missing', 'missing CI'],
    [10, 'missing', 'missing Quality evidence'],
    [11, 'missing', 'missing restore evidence'],
    [2, baseline, 'target differs from final main SHA'],
  ];
  for (const [index, replacement, description] of mutations) {
    const candidate = [...valid];
    candidate[index] = replacement;
    assert.notEqual(invoke(candidate).status, 0, `accepted ${description}`);
  }
});

test('bootstrap candidate outcome requires backup and exact three-way provenance', () => {
  const result = (backup: string, ready: string, image: string) =>
    shell('. "$1"; michel_bootstrap_candidate_result "$2" "$3" "$4" "$5"',
      deployLib, releaseSha, backup, ready, image);
  assert.equal(result('pass', releaseSha, releaseSha).status, 0);
  assert.notEqual(result('failed', releaseSha, releaseSha).status, 0, 'backup failure was accepted');
  assert.notEqual(result('pass', otherSha, releaseSha).status, 0, 'readiness mismatch was accepted');
  assert.notEqual(result('pass', releaseSha, otherSha).status, 0, 'OCI mismatch was accepted');
});

test('bootstrap evidence admission binds an integrity-checked Quality PASS and real-backup restore', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'michel-bootstrap-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const quality = join(directory, 'quality.json');
  const restore = join(directory, 'restore.json');
  const receiptId = 'a'.repeat(64);
  const scopeBindingId = createHash('sha256')
    .update(`${receiptId}:pre-deployment-release-readiness:${releaseSha}`).digest('hex');
  const preDeploymentReceipt = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: '1.1.0', receiptId, scopeBindingId, receiptStatus: 'current',
    evaluationScope: 'pre-deployment-release-readiness', repository: 'crizpy7-sketch/Michel-OS',
    candidateSha: releaseSha, finalState: 'pass', evaluatedAt: '2026-09-01T16:00:00Z',
    scopeStatus: { productionDeploymentObservation: 'not-evaluated-pre-deployment',
      fullLifecycleEvaluation: 'required-after-production-observation',
      cristianApproval: 'required-separately', deploymentAuthority: 'not-granted' },
    controlPlane: { authority: 'shia-core', qualityGateMayAcceptTask: false,
      gstackMayAcceptTask: false, qualityEvidenceGrantsActionAuthority: false },
    ...overrides,
  });
  await writeFile(quality, JSON.stringify(preDeploymentReceipt()));
  await writeFile(restore, JSON.stringify({
    scope: 'real-production-backup-isolated-restore', productionDatabaseAccessed: false,
    postgresImage: 'postgres:16-alpine', backup: { gzipIntegrity: 'pass' },
    restore: { state: 'pass', queryable: true, migrationRecords: 2, cleanup: 'complete',
      requiredTables: ['app_user', 'household', 'member', 'schedule', 'event'] },
  }));
  const digest = (path: string) => shell('sha256sum "$1" | awk \'{print $1}\'', path).stdout.trim();
  const qualityDigest = digest(quality);
  const restoreDigest = digest(restore);
  const qualityResult = () => shell('. "$1"; michel_validate_quality_receipt "$2" "$3" "$4"',
    deployLib, quality, releaseSha, qualityDigest);
  const restoreResult = () => shell('. "$1"; michel_validate_real_backup_restore_evidence "$2" "$3"',
    deployLib, restore, restoreDigest);
  assert.equal(qualityResult().status, 0, qualityResult().stderr);
  assert.equal(restoreResult().status, 0, restoreResult().stderr);
  assert.notEqual(shell('. "$1"; michel_validate_quality_receipt "$2" "$3" "$4"',
    deployLib, quality, otherSha, qualityDigest).status, 0, 'Quality receipt passed another SHA');

  for (const [description, overrides] of [
    ['full lifecycle blocked receipt', { evaluationScope: 'full-lifecycle', finalState: 'blocked' }],
    ['wrong scope', { evaluationScope: 'full-lifecycle', finalState: 'pass' }],
    ['stale receipt', { receiptStatus: 'superseded' }],
    ['false production observation claim', { scopeStatus: { ...preDeploymentReceipt().scopeStatus,
      productionDeploymentObservation: 'pass' } }],
    ['Quality deployment authority claim', { controlPlane: { ...preDeploymentReceipt().controlPlane,
      qualityEvidenceGrantsActionAuthority: true } }],
    ['missing separate Cristian approval boundary', { scopeStatus: { ...preDeploymentReceipt().scopeStatus,
      cristianApproval: 'satisfied-by-quality' } }],
  ] as Array<[string, Record<string, unknown>]>) {
    await writeFile(quality, JSON.stringify(preDeploymentReceipt(overrides)));
    const changedDigest = digest(quality);
    const result = shell('. "$1"; michel_validate_quality_receipt "$2" "$3" "$4"',
      deployLib, quality, releaseSha, changedDigest);
    assert.notEqual(result.status, 0, `${description} satisfied bootstrap`);
  }

  await writeFile(quality, JSON.stringify(preDeploymentReceipt()));
  assert.notEqual(shell('. "$1"; michel_validate_quality_receipt "$2" "$3" "$4"',
    deployLib, quality, releaseSha, otherSha.padEnd(64, '1')).status, 0, 'digest mismatch passed');
  await writeFile(restore, '{}');
  assert.notEqual(restoreResult().status, 0, 'modified restore evidence passed its old digest');
});

test('pre-deployment readiness and full lifecycle Quality receipts remain separate evaluations', async () => {
  const validator = await readFile(deployLib, 'utf8');
  const bootstrap = await readFile(resolve('docs/deploy/bootstrap-gated-release.sh'), 'utf8');
  const documentation = await readFile(resolve('docs/deploy/README.md'), 'utf8');
  assert.match(validator, /pre-deployment-release-readiness/);
  assert.match(validator, /not-evaluated-pre-deployment/);
  assert.match(validator, /required-after-production-observation/);
  assert.match(validator, /qualityEvidenceGrantsActionAuthority !== false/);
  assert.match(bootstrap, /pre-deployment release-readiness Quality PASS/);
  assert.match(documentation, /these are separate receipts/i);
  assert.match(documentation, /\*\*Full lifecycle\*\*/i);
  assert.match(documentation, /post-deployment.*Quality/i);
});

test('bootstrap state machine freezes before merge and enables automation only after observation', async () => {
  const source = await readFile(resolve('docs/deploy/bootstrap-gated-release.sh'), 'utf8');
  const frozen = source.indexOf('timer_frozen || fail');
  const mainBinding = source.indexOf('[ "$MAIN_SHA" = "$TARGET" ]');
  const approval = source.indexOf('michel_validate_bootstrap_approval');
  const ci = source.indexOf('michel_check_ci');
  const claim = source.indexOf('michel_claim_deploy_approval');
  const backup = source.indexOf('sh ./backup.sh');
  const checkout = source.indexOf('checkout --quiet --detach "$TARGET"');
  const reconcile = source.indexOf('michel_bootstrap_candidate_result');
  const observation = source.indexOf('while [ "$elapsed" -lt "$OBSERVATION_SECONDS" ]');
  const stamp = source.indexOf('michel_write_deployed_stamp');
  const consume = source.indexOf('michel_consume_deploy_approval');
  const enable = source.indexOf('systemctl enable --now "$TIMER"');
  assert.ok(frozen >= 0 && mainBinding > frozen && approval > mainBinding && ci > approval);
  assert.ok(claim > ci && backup > claim && checkout > backup, 'mutation preceded claim/backup');
  assert.ok(reconcile > checkout && observation > reconcile && stamp > observation,
    'candidate was stamped before reconciliation/observation');
  assert.ok(consume > stamp && enable > consume, 'approval/timer order is unsafe');
  assert.match(source, /merge SHA substitution requires new evidence and approval/);
  assert.match(source, /rollback_baseline/);
  assert.match(source, /timer remains disabled and approval remains non-reusable/);
});

test('the existing gauntlet runs exact-candidate Docker and ephemeral-runtime provenance checks', async () => {
  const workflow = await readFile(resolve('.github/workflows/gauntlet.yml'), 'utf8');
  const verifier = await readFile(resolve('docs/deploy/verify-release-provenance-ci.sh'), 'utf8');
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(workflow, /MICHEL_CANDIDATE_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(workflow, /sh docs\/deploy\/verify-release-provenance-ci\.sh/);
  assert.match(workflow, /release-provenance-ci\.json/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /restore-drill-ci\.json/);
  assert.match(workflow, /rollback-simulation-ci\.json/);
  assert.match(workflow, /performance-smoke-ci\.json/);
  assert.match(verifier, /docker build/);
  assert.match(verifier, /postgres:16-alpine/);
  assert.match(verifier, /\/api\/ready/);
  assert.match(verifier, /michel_reconcile_release "\$CANDIDATE" "\$READY_RELEASE_SHA" "\$RUNNING_OCI_REVISION"/);
  assert.match(verifier, /negative reconciliation accepted an intentionally mismatched SHA/);
  assert.match(verifier, /productionDeploymentObservation/);
});

test('rollback identity requires an exact commit that exists in Git', () => {
  const head = shell('git -C "$1" rev-parse HEAD', resolve('.'));
  assert.equal(head.status, 0, head.stderr);
  const accepted = shell('. "$1"; michel_require_git_commit "$2" "$3"', deployLib, resolve('.'), head.stdout);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, head.stdout.trim().toLowerCase());
  const blob = shell('git -C "$1" hash-object package.json', resolve('.'));
  assert.equal(blob.status, 0, blob.stderr);
  for (const invalid of ['main', head.stdout.slice(0, 12), blob.stdout.trim()]) {
    const rejected = shell('. "$1"; michel_require_git_commit "$2" "$3"', deployLib, resolve('.'), invalid);
    assert.notEqual(rejected.status, 0, `accepted unavailable rollback identity ${invalid}`);
  }
});

test('restore drill is isolated, fail-closed and emits bounded evidence', async () => {
  const source = await readFile(resolve('docs/deploy/restore-drill.sh'), 'utf8');
  const integrity = source.indexOf('gzip -t "$BACKUP"');
  const dockerCreate = source.indexOf('docker network create');
  assert.ok(integrity >= 0 && dockerCreate > integrity, 'Docker was touched before gzip integrity passed');
  assert.match(source, /postgres:16-alpine/);
  assert.match(source, /until docker exec "\$CONTAINER" psql/);
  assert.match(source, /schema_migration/);
  assert.match(source, /productionDatabaseAccessed:false/);
  assert.match(source, /docker volume rm -f/);
  assert.doesNotMatch(source, /michel_load_env|michel_compose/);
});

test('manual rollback backs up and reconciles before the guarded deployment stamp', async () => {
  const source = await readFile(resolve('docs/deploy/manual-rollback.sh'), 'utf8');
  const backup = source.indexOf('sh ./backup.sh');
  const checkout = source.indexOf('checkout --quiet --detach "$ROLLBACK"');
  const reconcile = source.indexOf('michel_reconcile_release "$ROLLBACK"');
  const stamp = source.indexOf('michel_write_deployed_stamp "$ROLLBACK"');
  assert.ok(backup >= 0 && checkout > backup, 'rollback checkout preceded its backup');
  assert.ok(reconcile > checkout && stamp > reconcile, 'rollback stamp was not provenance-gated');
  assert.match(source, /MICHEL_ROLLBACK_CONFIRM/);
  assert.match(source, /without stamping/);
});

test('CI proves restore rejection, rollback stamp safety and bounded performance', async () => {
  const source = await readFile(resolve('docs/deploy/verify-release-provenance-ci.sh'), 'utf8');
  assert.match(source, /pg_dump --clean --if-exists/);
  assert.match(source, /restore-drill\.sh/);
  assert.match(source, /corrupt backup was accepted/);
  assert.match(source, /failed rollback changed the previous stamp/);
  assert.match(source, /git archive "\$BASELINE"/);
  assert.match(source, /candidate median <= max\(baseline median \* 5, baseline median \+ 25ms\)/);
  assert.match(source, /productionRollback:false/);
});
