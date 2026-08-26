#!/usr/bin/env node
/**
 * ORCHESTRATOR CONSOLE.
 *
 * CODEX_START_PROMPT.md requires a checkpoint report of: overall %, phase %,
 * active agents, completed work, tests passing/failing, blockers, and the next
 * critical milestone. This computes all of that from the real tree and the
 * last gauntlet report rather than from anyone's self-assessment.
 *
 * Usage:
 *   npm run swarm             # full checkpoint report
 *   npm run swarm -- --graph  # dependency graph only
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './registry.ts';
import { bar, banner, c, GLYPH, pad, rule } from './ui.ts';
import type { GauntletReport, Phase, SwarmAgent } from './types.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const PHASE_ORDER: Phase[] = [
  'A-contracts',
  'B-foundations',
  'C-domains',
  'C2-experiences',
  'D-integration',
  'E-gauntlet',
  'F-repair',
];

async function exists(rel: string): Promise<boolean> {
  try {
    await stat(join(REPO_ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

/** An agent is "delivered" when every concrete file it owns exists on disk. */
async function deliveryOf(agent: SwarmAgent): Promise<{ delivered: number; expected: number }> {
  const concrete = agent.owns.filter((p) => !p.endsWith('/**'));
  let delivered = 0;
  for (const f of concrete) if (await exists(f)) delivered++;
  // Glob-owned areas count as one unit each, satisfied if the directory exists.
  const globs = agent.owns.filter((p) => p.endsWith('/**'));
  for (const g of globs) if (await exists(g.slice(0, -3))) delivered++;
  return { delivered, expected: concrete.length + globs.length };
}

async function loadReport(): Promise<GauntletReport | null> {
  try {
    return JSON.parse(await readFile(join(REPO_ROOT, '.swarm/gauntlet-report.json'), 'utf8')) as GauntletReport;
  } catch {
    return null;
  }
}

function renderGraph(): void {
  console.log(rule('DEPENDENCY GRAPH'));
  console.log(c.grey('  parallelism is gated by these edges — SWARM_ORCHESTRATION.md §3'));
  console.log('');
  for (const phase of PHASE_ORDER) {
    const inPhase = AGENTS.filter((a) => a.phase === phase);
    if (inPhase.length === 0) continue;
    console.log(`  ${c.bold(c.blue(phase))}`);
    for (const a of inPhase) {
      const deps = a.dependsOn.length > 0 ? c.grey(`after ${a.dependsOn.join(', ')}`) : c.grey('no upstream');
      console.log(`    ${c.grey(a.letter)} ${pad(a.name, 40)} ${deps}`);
    }
  }
  console.log('');
  console.log(c.grey('  Agents inside one phase run concurrently because their `owns` sets are disjoint;'));
  console.log(c.grey('  the ownership challenger fails the build if that ever stops being true.'));
  console.log('');
}

async function main(): Promise<void> {
  const graphOnly = process.argv.includes('--graph');
  console.log(banner('MICHEL-OS  ·  ORCHESTRATOR CHECKPOINT', 'Family Scheduling OS — swarm status computed from the real tree'));

  renderGraph();
  if (graphOnly) return;

  /* ------------------------------------------------------- delivery */

  console.log(rule('DELIVERY'));
  let totalDelivered = 0;
  let totalExpected = 0;
  for (const agent of AGENTS) {
    const { delivered, expected } = await deliveryOf(agent);
    totalDelivered += delivered;
    totalExpected += expected;
    const pct = expected === 0 ? 100 : Math.round((delivered / expected) * 100);
    const glyph = pct === 100 ? GLYPH.pass : pct > 0 ? GLYPH.warn : GLYPH.bullet;
    console.log(`  ${glyph} ${pad(agent.name, 40)} ${bar(delivered, expected, 16)} ${c.grey(`${delivered}/${expected} files`)}`);
  }
  const overall = totalExpected === 0 ? 0 : Math.round((totalDelivered / totalExpected) * 100);
  console.log('');
  console.log(`  ${c.bold('Overall delivery')} ${bar(totalDelivered, totalExpected)} ${c.bold(`${overall}%`)}`);
  console.log('');

  /* -------------------------------------------------- gauntlet state */

  const report = await loadReport();
  console.log(rule('LAST GAUNTLET'));
  if (!report) {
    console.log(`  ${c.grey('never run — `npm run gauntlet` to start Phase E')}\n`);
    return;
  }

  const last = report.rounds[report.rounds.length - 1];
  const verdictColor = report.verdict === 'PASSED' ? c.green : report.verdict === 'EXHAUSTED' ? c.yellow : c.red;
  console.log(`  verdict      ${verdictColor(c.bold(report.verdict))}   ${c.grey(`${report.rounds.length} round(s), finished ${report.finishedAt}`)}`);

  if (last) {
    const tests = last.results.find((r) => r.challenger === 'unit-tests');
    const passCount = Number(tests?.stats?.pass ?? 0);
    const failCount = Number(tests?.stats?.fail ?? 0);
    console.log(`  tests        ${failCount === 0 ? c.green(`${passCount} passing`) : c.red(`${passCount} passing / ${failCount} failing`)}`);
    console.log(`  challengers  ${last.results.filter((r) => r.passed).length}/${last.results.length} clean`);
    console.log(`  findings     ${last.blockingCount === 0 ? c.green('0 blocking') : c.red(`${last.blockingCount} blocking`)} ${c.grey(`/ ${last.warningCount} warning`)}`);

    const blockedAgents = Object.entries(last.tickets)
      .filter(([, fs]) => fs.some((f) => f.severity === 'blocking'))
      .map(([id]) => id);
    console.log(`  blocked      ${blockedAgents.length === 0 ? c.green('none') : c.red(blockedAgents.join(', '))}`);
    console.log('');

    if (report.unresolved.length > 0) {
      console.log(rule('NEXT CRITICAL MILESTONE'));
      const first = report.unresolved[0]!;
      console.log(`  ${c.red('→')} ${first.owner}: ${first.message}`);
      if (first.file) console.log(`    ${c.cyan(first.file)}`);
      console.log(`  ${c.grey(`${report.unresolved.length} blocking finding(s) route to .swarm/tickets/round-${last.round}/`)}`);
      console.log('');
    }
  }
}

main().catch((e: unknown) => {
  console.error(c.red('orchestrator console crashed:'), e);
  process.exit(2);
});
