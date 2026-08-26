#!/usr/bin/env node
/**
 * THE GAUNTLET LOOP — SWARM_ORCHESTRATION.md Phases E and F, mechanised.
 *
 *   Phase E (Adversarial Review): run every challenger against the tree.
 *   Phase F (Repair Loops): route each finding to the agent that owns the
 *                           file, emit a repair ticket, re-run.
 *
 * The loop keeps going until the swarm's work survives a full round with no
 * blocking findings, or the iteration budget is spent. "Exhausted" is a real
 * outcome and is reported as such — a gauntlet that always eventually passes
 * is just a slow rubber stamp.
 *
 * Usage:
 *   npm run gauntlet                    # one full loop, ticket-only repairs
 *   npm run gauntlet -- --rounds 3      # allow 3 adversarial rounds
 *   npm run gauntlet -- --freeze        # re-pin the contract hash, then run
 *   npm run gauntlet -- --json          # machine-readable report on stdout
 *   npm run gauntlet -- --repair-cmd "<cmd>"   # shell out to fix each ticket
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_CHALLENGERS } from './challengers.ts';
import { AGENTS, agentById, ownerOf } from './registry.ts';
import { sh } from './exec.ts';
import { bar, banner, c, GLYPH, kv, pad, rule } from './ui.ts';
import type { ChallengeContext, ChallengeResult, Finding, GauntletReport, RoundReport } from './types.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SWARM_DIR = join(REPO_ROOT, '.swarm');

interface Options {
  rounds: number;
  freeze: boolean;
  json: boolean;
  repairCmd: string | null;
  only: string[] | null;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { rounds: 1, freeze: false, json: false, repairCmd: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rounds') opts.rounds = Math.max(1, Number(argv[++i] ?? 1));
    else if (a === '--freeze') opts.freeze = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--repair-cmd') opts.repairCmd = argv[++i] ?? null;
    else if (a === '--only') opts.only = (argv[++i] ?? '').split(',').filter(Boolean);
  }
  return opts;
}

async function freezeContracts(): Promise<string> {
  const src = await readFile(join(REPO_ROOT, 'lib/contracts/index.ts'), 'utf8');
  const sha256 = createHash('sha256').update(src).digest('hex');
  // Record the version the hash belongs to. The integrity challenger only reads
  // `sha256`, but a lock that says which freeze it pins makes a re-freeze
  // legible in the diff instead of looking like a tampered hash.
  const version = /CONTRACT_VERSION = '([^']+)'/.exec(src)?.[1] ?? 'unknown';
  await writeFile(
    join(REPO_ROOT, 'tools/swarm/contract.lock'),
    JSON.stringify(
      { file: 'lib/contracts/index.ts', version, sha256, frozenAt: new Date().toISOString() },
      null,
      2,
    ) + '\n',
  );
  return sha256;
}

/** Phase F: one markdown ticket per agent, carrying only that agent's findings. */
async function writeTickets(round: number, tickets: Record<string, Finding[]>): Promise<string[]> {
  const dir = join(SWARM_DIR, 'tickets', `round-${round}`);
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];

  for (const [agentId, findings] of Object.entries(tickets)) {
    const agent = agentById(agentId);
    const blocking = findings.filter((f) => f.severity === 'blocking');
    const warnings = findings.filter((f) => f.severity === 'warning');
    const lines = [
      `# Repair ticket — round ${round}`,
      '',
      `**Agent:** ${agent ? `${agent.name} (${agent.letter})` : agentId}`,
      `**Owns:** ${agent ? agent.owns.join(', ') : 'n/a'}`,
      `**Blocking:** ${blocking.length}   **Warnings:** ${warnings.length}`,
      '',
      'The shared contracts remain frozen. Fix these inside the files you own; ',
      'if a finding can only be fixed by changing a contract, raise it as a blocker instead.',
      '',
    ];
    for (const group of [
      { label: 'Blocking', items: blocking },
      { label: 'Warnings', items: warnings },
    ]) {
      if (group.items.length === 0) continue;
      lines.push(`## ${group.label}`, '');
      for (const f of group.items) {
        const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '(no file)';
        lines.push(`- **[${f.challenger}]** ${where} — ${f.message}`);
        if (f.evidence) lines.push(`  > ${f.evidence.replace(/\n/g, '\n  > ').slice(0, 900)}`);
      }
      lines.push('');
    }
    const p = join(dir, `${agentId}.md`);
    await writeFile(p, lines.join('\n'));
    paths.push(p);
  }
  return paths;
}

function renderRoster(): void {
  console.log(rule('SWARM ROSTER'));
  for (const a of AGENTS) {
    console.log(
      `  ${c.grey(a.letter)} ${pad(c.bold(a.name), 42)} ${c.grey(a.phase)}  ${c.grey(a.owns.slice(0, 2).join(' '))}`,
    );
  }
  console.log('');
}

function renderResult(res: ChallengeResult): void {
  const glyph = res.errored ? c.red('✗') : res.passed ? GLYPH.pass : GLYPH.fail;
  const blocking = res.findings.filter((f) => f.severity === 'blocking').length;
  const warnings = res.findings.filter((f) => f.severity === 'warning').length;
  const tally =
    blocking > 0
      ? c.red(`${blocking} blocking`)
      : warnings > 0
        ? c.yellow(`${warnings} warning${warnings === 1 ? '' : 's'}`)
        : c.green('clean');
  console.log(`  ${glyph} ${pad(c.bold(res.challenger), 24)} ${pad(tally, 24)} ${c.grey(`${res.durationMs}ms`)}`);
  const stats = kv(res.stats);
  if (stats) console.log(`      ${stats}`);
  for (const f of res.findings.slice(0, 6)) {
    const mark = f.severity === 'blocking' ? c.red('•') : c.yellow('•');
    const where = f.file ? c.cyan(`${f.file}${f.line ? `:${f.line}` : ''}`) : c.grey('—');
    console.log(`      ${mark} ${where} ${f.message}`);
    if (f.evidence && f.severity === 'blocking') console.log(`        ${c.grey(f.evidence.split('\n')[0]!.slice(0, 120))}`);
  }
  if (res.findings.length > 6) console.log(`      ${c.grey(`… ${res.findings.length - 6} more`)}`);
}

function renderScoreboard(round: RoundReport): void {
  console.log('');
  console.log(rule('AGENT SCOREBOARD'));
  const byAgent = new Map<string, Finding[]>();
  for (const a of AGENTS) byAgent.set(a.id, []);
  for (const r of round.results) for (const f of r.findings) byAgent.get(f.owner)?.push(f) ?? byAgent.set(f.owner, [f]);

  for (const [agentId, findings] of byAgent) {
    const agent = agentById(agentId);
    const blocking = findings.filter((f) => f.severity === 'blocking').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const status =
      blocking > 0 ? c.red('BLOCKED  ') : warnings > 0 ? c.yellow('WARNINGS ') : c.green('CLEARED  ');
    const name = agent ? `${agent.letter} ${agent.name}` : agentId;
    console.log(
      `  ${status} ${pad(name, 44)} ${c.grey(`${blocking} blocking / ${warnings} warning`)}`,
    );
  }
  console.log('');
}

async function runRound(round: number, opts: Options): Promise<RoundReport> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const ctx: ChallengeContext = {
    repoRoot: REPO_ROOT,
    agents: AGENTS,
    round,
    ownerOf: (file: string) => ownerOf(file.replace(/^\.\//, '')),
  };

  console.log(rule(`ROUND ${round} — PHASE E: ADVERSARIAL REVIEW`));
  console.log('');

  const results: ChallengeResult[] = [];
  const challengers = opts.only ? ALL_CHALLENGERS.filter((ch) => opts.only!.includes(ch.name)) : ALL_CHALLENGERS;

  for (const challenger of challengers) {
    process.stdout.write(`  ${GLYPH.running} ${c.bold(challenger.name)} ${c.grey(`— hunting: ${challenger.hunts}`)}\n`);
    const res = await challenger.run(ctx);
    // Redraw the line now that we have a verdict.
    process.stdout.write('\u001b[1A\u001b[2K');
    renderResult(res);
    results.push(res);
  }

  const all = results.flatMap((r) => r.findings);
  const tickets: Record<string, Finding[]> = {};
  for (const f of all) (tickets[f.owner] ??= []).push(f);

  return {
    round,
    startedAt,
    durationMs: Math.round(performance.now() - t0),
    results,
    blockingCount: all.filter((f) => f.severity === 'blocking').length,
    warningCount: all.filter((f) => f.severity === 'warning').length,
    tickets,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  if (!opts.json) {
    console.log(
      banner(
        'MICHEL-OS  ·  SWARM GAUNTLET',
        'Phase E adversarial review + Phase F repair loop — docs/handoff/SWARM_ORCHESTRATION.md',
      ),
    );
    renderRoster();
  }

  if (opts.freeze) {
    const sha = await freezeContracts();
    if (!opts.json) console.log(`  ${GLYPH.pass} contracts frozen at ${c.cyan(sha.slice(0, 12))}\n`);
  }

  const rounds: RoundReport[] = [];
  let verdict: GauntletReport['verdict'] = 'FAILED';

  for (let round = 1; round <= opts.rounds; round++) {
    const report = await runRound(round, opts);
    rounds.push(report);
    if (!opts.json) renderScoreboard(report);

    if (report.blockingCount === 0) {
      verdict = 'PASSED';
      if (!opts.json) {
        const totalChecks = report.results.length;
        const cleanChecks = report.results.filter((r) => r.passed).length;
        console.log(rule('VERDICT'));
        console.log(`  ${bar(cleanChecks, totalChecks)}  ${c.green(c.bold('GAUNTLET PASSED'))}`);
        console.log(
          `  ${c.grey(`${cleanChecks}/${totalChecks} challengers clean, ${report.warningCount} non-blocking warning(s) remain`)}\n`,
        );
      }
      break;
    }

    // ---- Phase F: route failures back to the agents that caused them ----
    if (!opts.json) {
      console.log(rule(`ROUND ${round} — PHASE F: REPAIR ROUTING`));
      console.log('');
    }
    const ticketPaths = await writeTickets(round, report.tickets);
    if (!opts.json) {
      for (const p of ticketPaths) {
        const agentId = p.split('/').pop()!.replace('.md', '');
        const count = report.tickets[agentId]?.length ?? 0;
        console.log(`  ${c.yellow('→')} ${pad(agentId, 20)} ${c.grey(`${count} finding(s)`)}  ${c.grey(p.replace(REPO_ROOT + '/', ''))}`);
      }
      console.log('');
    }

    if (opts.repairCmd) {
      for (const p of ticketPaths) {
        const agentId = p.split('/').pop()!.replace('.md', '');
        if (!opts.json) console.log(`  ${GLYPH.running} dispatching repair for ${c.bold(agentId)}…`);
        const res = await sh('sh', ['-c', opts.repairCmd], {
          cwd: REPO_ROOT,
          timeoutMs: 900_000,
          env: { GAUNTLET_TICKET: p, GAUNTLET_AGENT: agentId, GAUNTLET_ROUND: String(round) },
        });
        if (!opts.json) {
          console.log(
            res.code === 0
              ? `  ${GLYPH.pass} repair command finished for ${agentId} ${c.grey(`(${res.durationMs}ms)`)}`
              : `  ${GLYPH.fail} repair command failed for ${agentId} ${c.grey(`exit ${res.code}`)}`,
          );
        }
      }
      console.log('');
    } else if (round === opts.rounds) {
      verdict = 'EXHAUSTED';
    } else if (!opts.json) {
      console.log(
        `  ${c.grey('no --repair-cmd configured; the orchestrator dispatches these tickets to the owning agents, then re-runs.')}\n`,
      );
      verdict = 'EXHAUSTED';
      break;
    }
  }

  const last = rounds[rounds.length - 1]!;
  if (verdict !== 'PASSED') verdict = last.blockingCount === 0 ? 'PASSED' : opts.rounds > 1 ? 'EXHAUSTED' : 'FAILED';

  const report: GauntletReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    rounds,
    verdict,
    unresolved: last.results.flatMap((r) => r.findings).filter((f) => f.severity === 'blocking'),
  };

  await mkdir(SWARM_DIR, { recursive: true });
  await writeFile(join(SWARM_DIR, 'gauntlet-report.json'), JSON.stringify(report, null, 2) + '\n');

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (verdict !== 'PASSED') {
    console.log(rule('VERDICT'));
    console.log(`  ${c.red(c.bold(verdict === 'EXHAUSTED' ? 'GAUNTLET EXHAUSTED' : 'GAUNTLET FAILED'))}`);
    console.log(`  ${c.grey(`${report.unresolved.length} blocking finding(s) unresolved after ${rounds.length} round(s)`)}`);
    console.log(`  ${c.grey('report: .swarm/gauntlet-report.json   tickets: .swarm/tickets/')}\n`);
  }

  process.exit(verdict === 'PASSED' ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(c.red('gauntlet crashed:'), e);
  process.exit(2);
});
