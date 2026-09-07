/** Michel adapter only. All evidence admission, evaluation and receipt minting remain in Factory. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { QualityGateInput, QualityGateReceipt } from '../../.swarm/factory-types/src/quality/quality-gate.js';
import type { EvidenceAdmissionDependencies } from '../../.swarm/factory-types/src/quality/evidence-admission.js';

export type { QualityGateInput, QualityGateReceipt, EvidenceAdmissionDependencies };
export const MICHEL_REPOSITORY = 'crizpy7-sketch/Michel-OS';
export const FACTORY_SHA = 'd380dfbd4cc65466f6757c680e654a967d2749e0';
export const FACTORY_TREE = '6c01a39ded60161082084e7d4b50546eb36b1021';
export const MICHEL_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const loadedFactories = new WeakSet<object>();

/** Compile the exact clean pin into an owned disposable directory; never trust an existing dist/. */
export async function loadPinnedFactory() {
  const root = await realpath(join(MICHEL_ROOT, '.swarm/factory-source'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const verify = () => {
    if (git('rev-parse', 'HEAD') !== FACTORY_SHA || git('rev-parse', 'HEAD^{tree}') !== FACTORY_TREE
      || git('status', '--porcelain', '--untracked-files=no')) throw new Error('Factory checkout does not match the clean approved pin');
  };
  verify();
  const directory = await mkdtemp(join(tmpdir(), 'michel-factory-runtime-'));
  try {
    await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
    execFileSync(process.execPath, [join(root, 'boris/node_modules/typescript/bin/tsc'),
      '-p', join(root, 'boris/tsconfig.json'), '--outDir', join(directory, 'dist')], { stdio: 'pipe', timeout: 60000 });
    verify();
    const quality = await import(pathToFileURL(join(directory, 'dist/src/quality/quality-gate.js')).href) as typeof import('../../.swarm/factory-types/src/quality/quality-gate.js');
    const admission = await import(pathToFileURL(join(directory, 'dist/src/quality/evidence-admission.js')).href) as typeof import('../../.swarm/factory-types/src/quality/evidence-admission.js');
    const orchestrator = await import(pathToFileURL(join(directory, 'dist/src/factory/orchestrator-core.js')).href) as typeof import('../../.swarm/factory-types/src/factory/orchestrator-core.js');
    const factory = Object.freeze({ quality, admission, orchestrator, root, candidateSha: FACTORY_SHA,
      close: () => rm(directory, { recursive: true, force: true }) });
    loadedFactories.add(factory);
    return factory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
export type PinnedFactory = Awaited<ReturnType<typeof loadPinnedFactory>>;

export interface TrustedMichelQualityContext {
  // These values are supplied by Shia Core's trusted control plane, NEVER copied from the submitted receipt.
  input: QualityGateInput;
  dependencies: EvidenceAdmissionDependencies;
}

export interface ConsumptionResult {
  state: 'pass' | 'blocked' | 'needs-evidence';
  reason: string;
  factorySha: string;
  candidateSha: string;
  receiptId: string | null;
  qualityFinalState: string | null;
  qualityEvidenceGrantsActionAuthority: false;
  cristianDeploymentApproval: 'required-separately';
}

export function consumeStoredFactoryReceipt(
  factory: PinnedFactory, stored: unknown, targetSha: string, context: TrustedMichelQualityContext | null,
  now = new Date(),
): ConsumptionResult {
  const result = (state: ConsumptionResult['state'], reason: string, receipt?: QualityGateReceipt): ConsumptionResult => ({
    state, reason, factorySha: FACTORY_SHA, candidateSha: targetSha, receiptId: receipt?.receiptId ?? null,
    qualityFinalState: receipt?.finalState ?? null, qualityEvidenceGrantsActionAuthority: false,
    cristianDeploymentApproval: 'required-separately',
  });
  if (!loadedFactories.has(factory)) return result('blocked', 'Untrusted Factory implementation');
  if (!/^[0-9a-f]{40}$/.test(targetSha)) return result('blocked', 'Exact normalized target SHA is required');
  if (!context) return result('needs-evidence', 'Trusted Shia Core task/evidence context is unavailable');
  try {
    const input = context.input;
    // Application release-policy floor, not another Quality evaluator. Full expected policy is re-evaluated below.
    if (input.repository !== MICHEL_REPOSITORY || input.projectId !== 'michel-os'
      || !input.taskId || input.taskContract.id !== input.taskId || input.candidateSha !== targetSha
      || input.taskContract.repository.commit !== targetSha || input.taskContract.repository.branch !== input.branch
      || input.riskTier !== 'T3' || input.taskContract.risk.tier !== 'T3'
      || input.evaluationScope !== 'pre-deployment-release-readiness' || input.productionObservationRequirement !== 'required'
      || !input.taskContract.approvalGates.includes('independent-review')
      || !input.requiredEvidence.includes('security') || !input.requiredEvidence.includes('review')) {
      return result('blocked', 'Trusted context does not meet Michel exact-target release policy');
    }
    const age = now.getTime() - Date.parse(input.evaluatedAt);
    if (!Number.isFinite(age) || age < -300000 || age > 86400000) return result('blocked', 'Stale or future-dated task evidence snapshot');
    if (factory.quality.validateCanonicalQualityGateReceipt(stored).length) return result('blocked', 'Malformed, stale, wrong-scope or integrity-invalid canonical receipt');
    // Serialized provenance is not proof. Re-admit against authorized sources and regenerate the entire expected receipt.
    const admitted = factory.admission.admitQualityGateInput(input, context.dependencies);
    const record = factory.quality.revalidateStoredQualityGateReceipt(stored as QualityGateReceipt, admitted,
      'michel-canonical-consumer:trusted-control-plane');
    const resolver = factory.quality.createTrustedQualityGateReceiptResolver('michel-stored-receipt',
      `${MICHEL_REPOSITORY}@${targetSha};Factory@${FACTORY_SHA}`, (id) => id === record.sourceId ? record : null);
    const resolution = resolver.resolve(record.sourceId);
    if (!resolution || !factory.quality.isVerifiedQualityGateReceiptResolution(resolution)) {
      return result('needs-evidence', 'Permanent Factory resolver did not verify the receipt');
    }
    const receipt = resolution.receipt;
    return receipt.finalState === 'pass' ? result('pass', 'Canonical pre-deployment Quality readiness verified; deployment approval remains separate', receipt)
      : result(receipt.finalState === 'needs-evidence' ? 'needs-evidence' : 'blocked', 'Permanent Quality Gate did not pass this exact task/evidence snapshot', receipt);
  } catch {
    return result('needs-evidence', 'Stored receipt cannot be reproduced from independently supplied task policy and re-admitted evidence');
  }
}

/** Utility for trusted collectors/tests. No raw caller claim becomes admitted here. */
export async function readMichelProfile(factory: PinnedFactory): Promise<string> {
  return readFile(resolve(factory.root, 'docs/pilots/michel-os/APP_PROFILE.yaml'), 'utf8');
}
