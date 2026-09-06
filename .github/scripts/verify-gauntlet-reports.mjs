// CI artifact preflight only: this does not admit evidence or certify Quality.
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const reports = ['.swarm/gauntlet-report.json', '.swarm/receipt-consumer-integration.json'];
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
    files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  console.log(JSON.stringify({ candidateSha, purpose: 'artifact-retention-only', files }));
} catch (error) {
  // Do not print report contents or operational environment values on failure.
  console.error(`[gauntlet-report-retention] ${error.code === 'ENOENT' ? 'Required report or report directory is missing' : error.message}`);
  process.exitCode = 1;
}
