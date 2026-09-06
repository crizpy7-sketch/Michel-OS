// Execute the real locked ESLint CLI and retain raw execution evidence, not a Quality receipt.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

const root = process.cwd();
const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const outputDirectory = join(root, '.swarm');
const report = {
  schemaVersion: '1.0.0', kind: 'lint-execution', command: 'npm run lint',
  evidenceState: 'raw-unverified', qualityEvidenceGrantsActionAuthority: false,
  startedAt: new Date().toISOString(), candidateSha: null, treeSha: null,
  exactCandidate: false, configuration: [], versions: {}, checkedFiles: [], excludedFiles: [],
  diagnostics: [], eslintExitCode: null, exitCode: 2, state: 'error',
};
let temporary;
try {
  // Resolve only the repository's installed CLI; never npx/download or shell interpolation.
  if (process.argv.length !== 2) throw Error('npm run lint does not accept subset or rule override arguments');
  if (git('rev-parse', '--show-toplevel') !== root) throw Error('Run lint from the repository root');
  report.candidateSha = git('rev-parse', 'HEAD');
  report.treeSha = git('rev-parse', 'HEAD^{tree}');
  if (!/^[0-9a-f]{40}$/.test(report.candidateSha)) throw Error('Exact Git candidate is required');
  if (process.env.MICHEL_CANDIDATE_SHA && process.env.MICHEL_CANDIDATE_SHA !== report.candidateSha) {
    throw Error('CI candidate does not match the checked out HEAD');
  }
  report.exactCandidate = git('status', '--porcelain', '--untracked-files=all') === '';
  if (process.env.CI === 'true' && !report.exactCandidate) throw Error('CI lint requires a clean exact candidate');
  const inventory = git('ls-files', '-c', '-o', '--exclude-standard', '--deduplicate', '-z').split('\0').filter(Boolean).sort();
  const files = [];
  for (const path of inventory) {
    if (/^(?:node_modules|\.git|\.swarm)\//.test(path)) {
      report.excludedFiles.push({ path, reason: 'Dependency or private operational state; not maintained application source' });
    } else if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) {
      report.excludedFiles.push({ path, reason: 'Not a standalone JavaScript/TypeScript source file' });
    } else {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Source inventory contains a non-regular file');
      files.push(path);
      report.checkedFiles.push({ path, sha256: hash(readFileSync(path)) });
    }
  }
  if (files.length === 0) throw Error('Lint cannot succeed with zero source files');
  for (const path of ['eslint.config.mjs', 'tools/lint/run.mjs', 'package.json', 'package-lock.json']) {
    report.configuration.push({ path, sha256: hash(readFileSync(path)) });
  }
  for (const name of ['eslint', '@eslint/js', 'typescript-eslint', 'globals', 'typescript']) {
    report.versions[name] = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version;
  }
  mkdirSync(outputDirectory, { recursive: true });
  if (lstatSync(outputDirectory).isSymbolicLink()) throw Error('Unsafe evidence directory');
  temporary = mkdtempSync(join(outputDirectory, 'lint-run-'));
  const rawPath = join(temporary, 'eslint.json');
  const cli = join(dirname(require.resolve('eslint/package.json')), 'bin/eslint.js');
  const args = ['--no-config-lookup', '--config', 'eslint.config.mjs', '--no-inline-config',
    '--max-warnings', '0', '--format', 'json', '--output-file', rawPath, ...files];
  report.arguments = args.map(arg => arg === rawPath ? '<owned-temporary-eslint-json>' : arg);
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  report.eslintExitCode = result.status;
  report.eslintStderr = result.stderr ?? '';
  if (result.error || result.signal || ![0, 1].includes(result.status)) throw Error('ESLint execution failed; see recorded exit status/diagnostics');
  const results = JSON.parse(readFileSync(rawPath, 'utf8'));
  const actualFiles = results.map(item => relative(root, item.filePath)).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(files)) throw Error('ESLint did not check the entire source inventory');
  report.errorCount = results.reduce((total, item) => total + item.errorCount, 0);
  report.warningCount = results.reduce((total, item) => total + item.warningCount, 0);
  for (const item of results) for (const message of item.messages) {
    // Retain actual diagnostics without ESLint's source text or suggested replacement code.
    report.diagnostics.push({ path: relative(root, item.filePath), ruleId: message.ruleId,
      severity: message.severity, message: message.message, line: message.line, column: message.column,
      endLine: message.endLine, endColumn: message.endColumn, fatal: message.fatal === true });
  }
  // A disposable stdin control proves this exact installed configuration rejects
  // a known defect. It never changes repository source or certifies application code.
  const controlSource = 'debugger;\nexport const lintControl: number = 1;\n';
  const controlArgs = ['--no-config-lookup', '--config', 'eslint.config.mjs', '--no-inline-config',
    '--format', 'json', '--stdin', '--stdin-filename', 'server/lint-negative-control.ts'];
  const control = spawnSync(process.execPath, [cli, ...controlArgs], { cwd: root, input: controlSource,
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  const controlResults = JSON.parse(control.stdout || '[]');
  const violationRejected = control.status === 1 && controlResults.some(item => item.messages.some(message => message.ruleId === 'no-debugger' && message.severity === 2));
  report.negativeControl = { arguments: controlArgs, sourceSha256: hash(controlSource),
    eslintExitCode: control.status, expectedRule: 'no-debugger', violationRejected };
  if (!violationRejected) throw Error('Controlled lint violation was not rejected');
  for (const file of report.checkedFiles) if (hash(readFileSync(file.path)) !== file.sha256) throw Error('Source changed during lint');
  for (const file of report.configuration) if (hash(readFileSync(file.path)) !== file.sha256) throw Error('Configuration changed during lint');
  report.exitCode = result.status;
  report.state = result.status === 0 ? 'pass' : 'fail';
} catch (error) {
  report.failure = error.message;
}
{
  report.finishedAt = new Date().toISOString();
  mkdirSync(outputDirectory, { recursive: true });
  if (lstatSync(outputDirectory).isSymbolicLink()) throw Error('Unsafe evidence directory');
  temporary ??= mkdtempSync(join(outputDirectory, 'lint-run-'));
  const serialized = JSON.stringify(report, null, 2) + '\n';
  const staged = join(temporary, 'report.json');
  writeFileSync(staged, serialized, { flag: 'wx', mode: 0o600 });
  renameSync(staged, join(outputDirectory, 'lint-report.json'));
  rmSync(temporary, { recursive: true, force: true });
  for (const message of report.diagnostics) console.error(`${message.path}:${message.line}:${message.column} ${message.ruleId ?? 'parse'} ${message.message}`);
  console.log(JSON.stringify({ state: report.state, exitCode: report.exitCode, eslintExitCode: report.eslintExitCode,
    candidateSha: report.candidateSha, exactCandidate: report.exactCandidate, checkedFiles: report.checkedFiles.length,
    errorCount: report.errorCount, warningCount: report.warningCount, report: '.swarm/lint-report.json', sha256: hash(serialized), failure: report.failure }));
  process.exitCode = report.exitCode;
}
