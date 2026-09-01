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
