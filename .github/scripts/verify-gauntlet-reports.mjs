// CI artifact preflight only: this does not admit evidence or certify Quality.
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const reports = ['.swarm/gauntlet-report.json', '.swarm/receipt-consumer-integration.json', '.swarm/lint-report.json'];
try {
  const candidateSha = process.env.MICHEL_CANDIDATE_SHA;
  if (!/^[0-9a-f]{40}$/.test(candidateSha ?? '')) throw Error('Exact CI candidate SHA is required');
  const directory = await lstat('.swarm');
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('Unsafe report directory');
  const files = [];
  for (const path of reports) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Unsafe required report: ${path}`);
    const bytes = await readFile(path);
    let report;
    try { report = JSON.parse(bytes.toString('utf8')); }
    catch { throw Error(`Invalid required JSON report: ${path}`); }
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw Error(`Invalid required report: ${path}`);
    if (path.endsWith('/receipt-consumer-integration.json') && report.michelCandidateSha !== candidateSha) {
      throw Error('Receipt-consumer integration report does not match the exact CI candidate');
    }
    if (path.endsWith('/lint-report.json')) {
      // Retain failures too. Artifact retention never overrides the lint step verdict.
      if (report.kind !== 'lint-execution' || report.candidateSha !== candidateSha || report.exactCandidate !== true ||
          report.command !== 'npm run lint' || ![0, 1, 2].includes(report.exitCode) ||
          !Array.isArray(report.checkedFiles) || report.checkedFiles.length === 0 ||
          !Array.isArray(report.diagnostics) || !Array.isArray(report.configuration) || report.configuration.length === 0 ||
          report.evidenceState !== 'raw-unverified' || report.qualityEvidenceGrantsActionAuthority !== false) {
        throw Error('Required lint execution report is missing coverage or exact candidate binding');
      }
    }
    files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  console.log(JSON.stringify({ candidateSha, purpose: 'artifact-retention-only', files }));
} catch (error) {
  // Do not print report contents or operational environment values on failure.
  console.error(`[gauntlet-report-retention] ${error.code === 'ENOENT' ? 'Required report or report directory is missing' : error.message}`);
  process.exitCode = 1;
}
