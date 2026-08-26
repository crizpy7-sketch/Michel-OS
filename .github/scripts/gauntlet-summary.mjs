/**
 * Render `.swarm/gauntlet-report.json` as a GitHub step summary.
 *
 * The point is that a reviewer can see WHICH challenger objected and WHICH
 * agent owns the finding without opening the run log. A CI check that only
 * says "failed" makes someone go read 400 lines of output to learn what the
 * scoreboard already knew.
 *
 * This script never fails the job: the gauntlet's own exit code decides that.
 * A summary that could itself go red would turn a formatting bug into a
 * blocked pull request.
 */
import { readFile } from 'node:fs/promises';

const REPORT = '.swarm/gauntlet-report.json';

const VERDICT_ICON = { PASSED: '🟢', FAILED: '🔴', EXHAUSTED: '🟠' };
const SEVERITY_ICON = { blocking: '🔴', warning: '🟡', info: '🔵' };

function escapePipes(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const out = [];

try {
  const report = JSON.parse(await readFile(REPORT, 'utf8'));
  const round = report.rounds?.[report.rounds.length - 1];

  if (round === undefined) {
    out.push('## Gauntlet', '', 'The report contains no rounds.');
  } else {
    const clean = round.results.filter((r) => r.passed).length;
    const total = round.results.length;

    out.push(
      `## ${VERDICT_ICON[report.verdict] ?? '⚪'} Gauntlet ${report.verdict}`,
      '',
      `**${clean}/${total} challengers clean** · ` +
        `${round.blockingCount} blocking · ${round.warningCount} warning · ` +
        `${report.rounds.length} round(s)`,
      '',
      '| | Challenger | Took | What it measured |',
      '| --- | --- | --- | --- |',
    );

    for (const result of round.results) {
      const icon = result.errored ? '💥' : result.passed ? '✅' : '❌';
      const stats = Object.entries(result.stats ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join(' · ');
      out.push(
        `| ${icon} | \`${result.challenger}\` | ${result.durationMs}ms | ` +
          `${escapePipes(truncate(stats, 300)) || '—'} |`,
      );
    }

    const findings = round.results.flatMap((r) => r.findings ?? []);
    if (findings.length > 0) {
      out.push(
        '',
        '### Findings',
        '',
        'Routed to the agent that owns the file — that routing is the whole point of the registry.',
        '',
        '| | Owner | File | Finding |',
        '| --- | --- | --- | --- |',
      );
      for (const finding of findings.slice(0, 50)) {
        const where = finding.file
          ? `\`${escapePipes(finding.file)}${finding.line ? `:${finding.line}` : ''}\``
          : '—';
        out.push(
          `| ${SEVERITY_ICON[finding.severity] ?? '⚪'} | \`${escapePipes(finding.owner)}\` | ${where} | ` +
            `${escapePipes(truncate(finding.message, 200))} |`,
        );
      }
      if (findings.length > 50) {
        out.push('', `_…and ${findings.length - 50} more. Full report in the \`gauntlet-report\` artifact._`);
      }
    }

    if (report.verdict === 'EXHAUSTED') {
      out.push(
        '',
        '> `EXHAUSTED` means the repair loop ran out of budget with blockers still standing.',
        '> It is a real verdict, not a near-miss: the loop reports what is unresolved rather',
        '> than lowering the bar to reach green.',
      );
    }
  }
} catch (error) {
  // No report usually means the gauntlet crashed before writing one (exit 2),
  // or install failed. Say so plainly instead of rendering an empty scoreboard.
  out.push(
    '## Gauntlet',
    '',
    `No report at \`${REPORT}\` — the run did not get far enough to write one.`,
    '',
    `<sub>${escapePipes(error?.message ?? error)}</sub>`,
  );
}

process.stdout.write(`${out.join('\n')}\n`);
