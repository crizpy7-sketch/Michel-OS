/**
 * THE GAUNTLET — adversarial challengers.
 *
 * SWARM_ORCHESTRATION.md Phase E is "Adversarial Review": QA, security,
 * accessibility, performance. These challengers are that phase, mechanised.
 * Each one is trying to prove the swarm's output is broken. A challenger that
 * cannot fail is not a challenger, so every check here either runs real code
 * or reads real compiler/test output — none of them are self-reported status.
 *
 * Findings are routed to the OWNING agent (registry.ts) so Phase F repair
 * loops land on the agent that actually caused them.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { sh } from './exec.ts';
import type { ChallengeContext, ChallengeResult, Challenger, Finding } from './types.ts';
import type { ProbeOutcome } from './probes/kit.ts';

const now = () => performance.now();

function result(
  challenger: string,
  started: number,
  findings: Finding[],
  stats?: Record<string, string | number>,
  errored = false,
): ChallengeResult {
  return {
    challenger,
    passed: findings.every((f) => f.severity !== 'blocking'),
    durationMs: Math.round(now() - started),
    findings,
    stats,
    errored,
  };
}

async function walk(dir: string, root: string, out: string[] = []): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.swarm') continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) await walk(full, root, out);
    else out.push(relative(root, full));
  }
  return out;
}

/* ------------------------------------------------------------------ 1 */

/**
 * Contracts are frozen (ARCHITECTURE.md §5). An agent that quietly edits them
 * to make its own module compile breaks every sibling at once, and the break
 * shows up somewhere else entirely. Hash-pin them.
 */
export const contractIntegrity: Challenger = {
  name: 'contract-integrity',
  hunts: 'a swarm agent rewriting the frozen shared contracts to make its own code compile',
  async run(ctx: ChallengeContext): Promise<ChallengeResult> {
    const started = now();
    const findings: Finding[] = [];
    const contractPath = join(ctx.repoRoot, 'lib/contracts/index.ts');
    const lockPath = join(ctx.repoRoot, 'tools/swarm/contract.lock');

    let source: string;
    try {
      source = await readFile(contractPath, 'utf8');
    } catch {
      findings.push({
        challenger: 'contract-integrity',
        severity: 'blocking',
        owner: 'orchestrator',
        file: 'lib/contracts/index.ts',
        message: 'the frozen contract file is missing entirely',
      });
      return result('contract-integrity', started, findings);
    }

    const hash = createHash('sha256').update(source).digest('hex');
    let locked: string | null = null;
    try {
      locked = JSON.parse(await readFile(lockPath, 'utf8')).sha256 as string;
    } catch {
      locked = null;
    }

    if (locked === null) {
      findings.push({
        challenger: 'contract-integrity',
        severity: 'warning',
        owner: 'orchestrator',
        file: 'tools/swarm/contract.lock',
        message: 'no contract lock recorded; run `npm run swarm -- --freeze` to pin the contracts',
      });
    } else if (locked !== hash) {
      findings.push({
        challenger: 'contract-integrity',
        severity: 'blocking',
        owner: 'orchestrator',
        file: 'lib/contracts/index.ts',
        message: 'frozen contracts were modified after the freeze — every parallel agent built against the old shape',
        evidence: `locked sha256 ${locked.slice(0, 12)}… but file hashes to ${hash.slice(0, 12)}…`,
      });
    }

    return result('contract-integrity', started, findings, { sha256: hash.slice(0, 12), locked: locked ? locked.slice(0, 12) : 'none' });
  },
};

/* ------------------------------------------------------------------ 2 */

/**
 * SWARM_ORCHESTRATION.md §3: agents may work in parallel only when "they own
 * disjoint files/modules". Enforce it against the actual tree instead of
 * trusting each agent's report.
 */
export const ownership: Challenger = {
  name: 'ownership',
  hunts: 'files written by nobody, or claimed by two agents at once',
  async run(ctx: ChallengeContext): Promise<ChallengeResult> {
    const started = now();
    const findings: Finding[] = [];
    const sourceDirs = ['domains', 'lib', 'tools', 'tests'];
    const files: string[] = [];
    for (const d of sourceDirs) files.push(...(await walk(join(ctx.repoRoot, d), ctx.repoRoot)));

    let unowned = 0;
    let contested = 0;
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const owner = ctx.ownerOf(file);
      if (owner === 'unowned') {
        unowned++;
        findings.push({
          challenger: 'ownership',
          severity: 'warning',
          owner: 'orchestrator',
          file,
          message: 'file belongs to no agent in the registry — nobody is accountable for it at the merge gate',
        });
      } else if (owner === 'contested') {
        contested++;
        findings.push({
          challenger: 'ownership',
          severity: 'blocking',
          owner: 'orchestrator',
          file,
          message: 'two or more agents claim this file; parallel edits will collide',
        });
      }
    }

    return result('ownership', started, findings, { filesScanned: files.length, unowned, contested });
  },
};

/* ------------------------------------------------------------------ 3 */

export const typecheck: Challenger = {
  name: 'typecheck',
  hunts: 'type errors, including ones an agent left in a sibling module it did not own',
  async run(ctx: ChallengeContext): Promise<ChallengeResult> {
    const started = now();
    const findings: Finding[] = [];
    const res = await sh('npx', ['tsc', '--noEmit', '--pretty', 'false'], { cwd: ctx.repoRoot, timeoutMs: 240_000 });
    const lines = (res.stdout + res.stderr).split('\n').filter((l) => l.includes('error TS'));

    for (const line of lines) {
      const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(line.trim());
      if (m) {
        const file = m[1]!;
        findings.push({
          challenger: 'typecheck',
          severity: 'blocking',
          owner: ctx.ownerOf(file),
          file,
          line: Number(m[2]),
          message: `${m[4]}: ${m[5]}`,
          evidence: line.trim(),
        });
      } else {
        findings.push({
          challenger: 'typecheck',
          severity: 'blocking',
          owner: 'orchestrator',
          message: line.trim(),
          evidence: line.trim(),
        });
      }
    }

    return result('typecheck', started, findings, { errors: lines.length, exitCode: res.code });
  },
};

/* ------------------------------------------------------------------ 4 */

export const unitTests: Challenger = {
  name: 'unit-tests',
  hunts: 'failing or missing unit tests across every agent module',
  async run(ctx: ChallengeContext): Promise<ChallengeResult> {
    const started = now();
    const findings: Finding[] = [];
    // A bare directory is resolved as a *module* by the runner, not walked —
    // that silently reports one synthetic failure and zero passes. Glob.
    const res = await sh(
      'node',
      ['--test', '--experimental-strip-types', '--test-reporter=tap', 'tests/**/*.test.ts'],
      { cwd: ctx.repoRoot, timeoutMs: 240_000 },
    );
    const out = res.stdout + res.stderr;

    const num = (key: string): number => {
      const m = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(out);
      return m ? Number(m[1]) : 0;
    };
    const pass = num('pass');
    const fail = num('fail');

    if (fail > 0) {
      // Each TAP failure is `not ok N - <name>` followed by a YAML block whose
      // `location:` names the source file. Attribute by that, not by guesswork.
      const blocks = [...out.matchAll(/^\s*not ok \d+ - (.+?)$([\s\S]*?)(?=^\s*(?:not )?ok \d+ - |^1\.\.|\Z)/gm)];
      for (const b of blocks.slice(0, 40)) {
        const name = b[1]!.trim();
        const body = b[2] ?? '';
        const loc = /location: '([^']+)'/.exec(body)?.[1] ?? '';
        const rel = loc.replace(ctx.repoRoot + '/', '').replace(/:\d+:\d+$/, '');
        const failureLine = /error: '([^']*)'/.exec(body)?.[1];
        const file = rel.endsWith('.ts') ? rel : undefined;
        findings.push({
          challenger: 'unit-tests',
          severity: 'blocking',
          owner: file ? ctx.ownerOf(file) : 'orchestrator',
          file,
          message: `failing test: ${name}`,
          evidence: failureLine ?? body.trim().slice(0, 400),
        });
      }
      if (findings.length === 0) {
        findings.push({
          challenger: 'unit-tests',
          severity: 'blocking',
          owner: 'orchestrator',
          message: `${fail} test(s) failed but no TAP failure block could be parsed`,
          evidence: out.slice(-2000),
        });
      }
    }

    // A module with no test file at all is a Definition-of-Done failure (§7).
    const testFiles = await walk(join(ctx.repoRoot, 'tests/unit'), ctx.repoRoot);
    if (testFiles.length === 0) {
      findings.push({
        challenger: 'unit-tests',
        severity: 'blocking',
        owner: 'orchestrator',
        message: 'no unit tests exist at all',
      });
    }

    return result('unit-tests', started, findings, { pass, fail, files: testFiles.length, exitCode: res.code });
  },
};

/* ------------------------------------------------------------------ 5 */

/**
 * Domain modules must be pure: no clock, no randomness, no environment, no I/O.
 * A `Date.now()` buried in the conflict engine makes conflict ids unstable and
 * turns every audit log into a lie. Static scan, because a runtime probe only
 * catches it on the code path it happens to exercise.
 */
const IMPURITIES: Array<{ rx: RegExp; message: string; severity: 'blocking' | 'warning' }> = [
  { rx: /\bDate\.now\s*\(/, message: 'Date.now() in a domain module — inject `now` instead so results stay reproducible', severity: 'blocking' },
  { rx: /\bnew Date\s*\(\s*\)/, message: 'new Date() with no argument reads the wall clock — inject the instant', severity: 'blocking' },
  { rx: /\bMath\.random\s*\(/, message: 'Math.random() destroys determinism — derive ids from a hash of the inputs', severity: 'blocking' },
  { rx: /\bprocess\.env\b/, message: 'process.env in a domain module — configuration belongs at the edge', severity: 'warning' },
  { rx: /\bconsole\.(log|debug)\s*\(/, message: 'stray console logging left in a domain module', severity: 'warning' },
  { rx: /\bas any\b/, message: '`as any` defeats the contract types this swarm is built on', severity: 'warning' },
  { rx: /\b(TODO|FIXME|XXX)\b/, message: 'unfinished marker left in shipped code', severity: 'warning' },
  { rx: /throw new Error\(\s*['"`]not implemented/i, message: 'stub left behind — Definition of Done requires working code', severity: 'blocking' },
];

export const purity: Challenger = {
  name: 'purity',
  hunts: 'hidden clocks, randomness, stubs and escape hatches inside domain logic',
  async run(ctx: ChallengeContext): Promise<ChallengeResult> {
    const started = now();
    const findings: Finding[] = [];
    const files = (await walk(join(ctx.repoRoot, 'domains'), ctx.repoRoot)).filter((f) => f.endsWith('.ts'));
    let scannedLines = 0;

    for (const file of files) {
      const src = await readFile(join(ctx.repoRoot, file), 'utf8');
      const lines = src.split('\n');
      scannedLines += lines.length;
      lines.forEach((text, i) => {
        const code = text.replace(/\/\/.*$/, '');
        if (/^\s*\*/.test(text)) return; // inside a block comment
        for (const rule of IMPURITIES) {
          if (rule.rx.test(code)) {
            findings.push({
              challenger: 'purity',
              severity: rule.severity,
              owner: ctx.ownerOf(file),
              file,
              line: i + 1,
              message: rule.message,
              evidence: text.trim().slice(0, 160),
            });
          }
        }
      });
    }

    return result('purity', started, findings, { filesScanned: files.length, linesScanned: scannedLines });
  },
};

/* ------------------------------------------------------------------ 6 */

/**
 * SWARM_ORCHESTRATION.md §7: "A feature is not done merely because UI renders."
 * Every delivered domain module must export something, be covered by a test
 * file, and not be a placeholder.
 */
export const definitionOfDone: Challenger = {
  name: 'definition-of-done',
  hunts: 'modules that exist but are empty, untested, or export nothing',
  async run(ctx: ChallengeContext): Promise<ChallengeResult> {
    const started = now();
    const findings: Finding[] = [];
    // Delivery is judged by what an agent OWNS, wherever that lives. This used
    // to scan only `domains/`, which was right when every agent's work sat
    // there and became wrong the moment runtime-tier agents owned `server/`
    // and `db/` instead — they read as having delivered nothing at all.
    const sourceRoots = ['domains', 'server', 'lib', 'db'];
    const domainFiles: string[] = [];
    for (const root of sourceRoots) {
      domainFiles.push(
        ...(await walk(join(ctx.repoRoot, root), ctx.repoRoot)).filter(
          (f) => f.endsWith('.ts') || f.endsWith('.sql'),
        ),
      );
    }
    const testFiles = (await walk(join(ctx.repoRoot, 'tests'), ctx.repoRoot)).filter((f) => f.endsWith('.test.ts'));
    const testCorpus = (
      await Promise.all(testFiles.map((f) => readFile(join(ctx.repoRoot, f), 'utf8').catch(() => '')))
    ).join('\n');

    for (const agent of ctx.agents) {
      if (agent.id === 'orchestrator') continue;
      const delivered = domainFiles.filter((f) => agent.owns.some((p) => (p.endsWith('/**') ? f.startsWith(p.slice(0, -2)) : p === f)));
      if (delivered.length === 0) {
        findings.push({
          challenger: 'definition-of-done',
          severity: 'blocking',
          owner: agent.id,
          message: `${agent.name} has delivered no domain module yet`,
        });
        continue;
      }
      for (const file of delivered) {
        const src = await readFile(join(ctx.repoRoot, file), 'utf8');
        if (file.endsWith('.sql')) {
          // A migration exports nothing and has no test named after it; what it
          // must not be is empty. Its real verification is the schema suite,
          // which executes it against a live Postgres.
          if (src.trim().length < 200) {
            findings.push({
              challenger: 'definition-of-done',
              severity: 'warning',
              owner: agent.id,
              file,
              message: `migration is only ${src.trim().length} bytes — looks like a placeholder`,
            });
          }
          continue;
        }
        if (!/^export /m.test(src)) {
          findings.push({
            challenger: 'definition-of-done',
            severity: 'blocking',
            owner: agent.id,
            file,
            message: 'module exports nothing — no sibling can consume it',
          });
        }
        if (src.trim().length < 400) {
          findings.push({
            challenger: 'definition-of-done',
            severity: 'warning',
            owner: agent.id,
            file,
            message: `module is only ${src.trim().length} bytes — looks like a placeholder`,
          });
        }
        const base = file.split('/').pop()!.replace('.ts', '');
        if (!testCorpus.includes(base) && !testFiles.some((t) => t.includes(base))) {
          findings.push({
            challenger: 'definition-of-done',
            severity: 'blocking',
            owner: agent.id,
            file,
            message: `no test file references ${base} — untested code is not done`,
          });
        }
      }
    }

    return result('definition-of-done', started, findings, { sourceModules: domainFiles.length, testFiles: testFiles.length });
  },
};

/* -------------------------------------------------------------- 7,8,9 */

/** Wrap a runtime probe module as a challenger. */
function probeChallenger(name: string, hunts: string, spec: string, severity: 'blocking' | 'warning'): Challenger {
  return {
    name,
    hunts,
    async run(ctx: ChallengeContext): Promise<ChallengeResult> {
      const started = now();
      const findings: Finding[] = [];
      let outcome: ProbeOutcome;
      try {
        const mod = (await import(spec)) as { run: () => Promise<ProbeOutcome> };
        outcome = await mod.run();
      } catch (e) {
        return result(
          name,
          started,
          [
            {
              challenger: name,
              severity: 'blocking',
              owner: 'orchestrator',
              message: `probe crashed: ${e instanceof Error ? e.message : String(e)}`,
              evidence: e instanceof Error ? (e.stack ?? '') : '',
            },
          ],
          undefined,
          true,
        );
      }

      for (const m of outcome.missing ?? []) {
        findings.push({
          challenger: name,
          severity: 'blocking',
          owner: m.owner,
          file: m.module,
          message: 'module has not been delivered, so it could not be probed',
          evidence: m.reason,
        });
      }
      for (const c of outcome.checks) {
        if (!c.passed) {
          findings.push({
            challenger: name,
            severity,
            owner: c.owner,
            message: c.name,
            evidence: c.detail,
          });
        }
      }

      const passedCount = outcome.checks.filter((c) => c.passed).length;
      return result(name, started, findings, {
        ...(outcome.stats ?? {}),
        checksPassed: passedCount,
        checksTotal: outcome.checks.length,
      });
    },
  };
}

export const determinism = probeChallenger(
  'determinism',
  'engines whose output depends on input order, the clock, or call count',
  './probes/determinism.ts',
  'blocking',
);

export const adversarialSecurity = probeChallenger(
  'adversarial-security',
  'cross-tenant escapes, privilege escalation and prototype pollution through model output',
  './probes/security.ts',
  'blocking',
);

export const performance_ = probeChallenger(
  'performance',
  'algorithms that pass on six events and melt on a real household',
  './probes/performance.ts',
  'warning',
);

export const ALL_CHALLENGERS: Challenger[] = [
  contractIntegrity,
  ownership,
  typecheck,
  unitTests,
  purity,
  definitionOfDone,
  determinism,
  adversarialSecurity,
  performance_,
];
