/** Explicit deterministic TEST fixtures, never application CI or production evidence. Receipts are always evaluator-minted. */
import type { PinnedFactory, QualityGateInput, TrustedMichelQualityContext } from '../../docs/deploy/factory-quality-consumer.ts';
import { readMichelProfile } from '../../docs/deploy/factory-quality-consumer.ts';
import type { TrustedExecutionRecord } from '../../.swarm/factory-types/src/quality/evidence-admission.js';

export async function fixture(factory: PinnedFactory, candidateSha = 'a'.repeat(40)) {
  const at = new Date().toISOString();
  const { contract } = await factory.orchestrator.orchestrate(factory.root, await readMichelProfile(factory), {
    taskId: 'michel-receipt-consumer-test-fixture', objective: 'Verify bounded release security in an isolated deterministic fixture.',
    outcome: 'Exercise actual Factory evaluator/resolver and Michel consumer, not a production certification.',
    repository: { commit: candidateSha, branch: 'pilot/phase7-release-provenance' },
    requestedCapabilities: ['quality-receipt', 'security-review'], requestedActions: ['inspect', 'plan', 'build', 'test'],
    changedPaths: ['docs/deploy/lib.sh'], now: at,
    acceptanceCriteria: [
      { id: 'fixture-code', statement: 'Fixture code and runtime pass', evidence: ['unit', 'integration', 'runtime', 'security', 'review'] },
      { id: 'fixture-observation', statement: 'Production observation and authorization remain separate', evidence: ['production-observation', 'human_approval'] },
    ],
  });
  // Explicit application contract requirements tighten the orchestrated task; they never weaken Factory policy.
  contract.approvalGates = ['Cristian', 'independent-review'];
  const input: QualityGateInput = {
    taskId: contract.id, projectId: 'michel-os', repository: 'crizpy7-sketch/Michel-OS', candidateSha,
    branch: contract.repository.branch, riskTier: 'T3', taskContract: contract,
    acceptanceCriteria: contract.acceptanceCriteria, requiredEvidence: contract.requiredEvidence,
    changedPaths: ['docs/deploy/lib.sh'], changeSignals: { userFacing: false, securitySurfaces: ['deployment'],
      performanceSurfaces: ['api-backend'], performanceFailureMaterial: true, subjectRoles: [] },
    dangerousActions: [], approvalReferences: [],
    reviewer: { id: 'fixture-reviewer', source: 'test-fixture:independent-review', independent: true },
    repair: { attempt: 0, maxAttempts: 0 }, evaluatedAt: at,
    evaluationScope: 'pre-deployment-release-readiness', productionObservationRequirement: 'required', actualEvidence: [],
  };
  const records = new Map<string, TrustedExecutionRecord>();
  const kinds = ['typecheck', 'lint', 'unit', 'integration', 'e2e', 'security', 'adversarial', 'performance', 'independent-review'] as const;
  for (const kind of kinds) {
    const sourceType = kind === 'security' || kind === 'adversarial' ? 'security-runner'
      : kind === 'performance' ? 'performance-runner' : kind === 'independent-review' ? 'independent-reviewer' : 'boris-test-run';
    const sourceId = `test-fixture:${kind}`;
    const record: Omit<TrustedExecutionRecord, 'integrityDigest'> = { kind, candidateSha, taskId: input.taskId, repository: input.repository, sourceType, sourceId,
      collector: 'deterministic-test-fixture-only', status: 'pass' as const, source: sourceId,
      summary: 'Synthetic fixture evidence; not a claim about Michel application or production execution',
      criterionIds: ['fixture-code'], observedAt: at, method: 'automated-tool' as const,
      ...(kind === 'performance' ? { thresholds: [{ metric: 'fixture', comparator: 'lte' as const, value: 2, unit: 'ms' }],
        measurements: [{ metric: 'fixture', value: 1, unit: 'ms' }] } : {}),
    };
    records.set(sourceId, { ...record, integrityDigest: factory.admission.trustedRecordDigest(record) });
    input.actualEvidence.push({ id: sourceId, kind, candidateSha, status: 'pass', source: sourceId, summary: record.summary,
      criterionIds: ['fixture-code'], observedAt: at, provenance: { sourceId, sourceType } });
  }
  const adapter = factory.admission.createTrustedExecutionEvidenceAdapter('fixture-only-adapter',
    ['boris-test-run', 'security-runner', 'performance-runner', 'independent-reviewer'], (id) => records.get(id) ?? null);
  const context: TrustedMichelQualityContext = { input, dependencies: { evidenceAdapters: [adapter] } };
  const mint = () => factory.quality.evaluateQualityGate(factory.admission.admitQualityGateInput(input, context.dependencies));
  return { input, context, records, mint };
}
