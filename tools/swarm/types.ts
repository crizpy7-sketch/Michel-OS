/** Michel-OS swarm harness — shared types. Owner: Lead Orchestrator. */

export type Phase =
  | 'A-contracts'
  | 'B-foundations'
  | 'C-domains'
  | 'C2-experiences'
  | 'D-integration'
  | 'E-gauntlet'
  | 'F-repair';

export interface SwarmAgent {
  id: string;
  name: string;
  /** SWARM_ORCHESTRATION.md hierarchy letter. */
  letter: string;
  /** Files this agent exclusively owns. Overlap between agents is a merge-gate failure. */
  owns: string[];
  /** Agent ids that must be complete before this one may start. */
  dependsOn: string[];
  phase: Phase;
}

export type ChallengeSeverity = 'blocking' | 'warning' | 'info';

export interface Finding {
  challenger: string;
  severity: ChallengeSeverity;
  /** Agent id held responsible, or 'orchestrator' when ownership is unclear. */
  owner: string;
  file?: string;
  line?: number;
  message: string;
  /** Raw evidence (compiler output, assertion text) — kept for the repair ticket. */
  evidence?: string;
}

export interface ChallengeResult {
  challenger: string;
  passed: boolean;
  durationMs: number;
  findings: Finding[];
  /** Free-form metrics surfaced on the dashboard, e.g. tests passed, ms elapsed. */
  stats?: Record<string, string | number>;
  /** True when the challenger could not run at all (missing module, crash). */
  errored?: boolean;
}

export interface ChallengeContext {
  repoRoot: string;
  agents: SwarmAgent[];
  round: number;
  /** Resolve which agent owns a repo-relative path. */
  ownerOf(file: string): string;
}

export interface Challenger {
  name: string;
  /** What this challenger is adversarially trying to prove is broken. */
  hunts: string;
  run(ctx: ChallengeContext): Promise<ChallengeResult>;
}

export interface RoundReport {
  round: number;
  startedAt: string;
  durationMs: number;
  results: ChallengeResult[];
  blockingCount: number;
  warningCount: number;
  /** agent id -> findings routed to it for repair (Phase F). */
  tickets: Record<string, Finding[]>;
}

export interface GauntletReport {
  startedAt: string;
  finishedAt: string;
  rounds: RoundReport[];
  verdict: 'PASSED' | 'FAILED' | 'EXHAUSTED';
  unresolved: Finding[];
}
