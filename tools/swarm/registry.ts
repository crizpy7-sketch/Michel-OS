/**
 * The swarm roster and its file-ownership contract.
 * Derived from docs/handoff/SWARM_ORCHESTRATION.md §1.
 *
 * `owns` is the merge gate: SWARM_ORCHESTRATION.md §3 says agents may work in
 * parallel only when "they own disjoint files/modules". The Ownership
 * challenger enforces that mechanically rather than on the honour system.
 */
import type { SwarmAgent } from './types.ts';

export const AGENTS: SwarmAgent[] = [
  {
    id: 'orchestrator',
    letter: 'A',
    name: 'Lead Orchestrator / Superintendent',
    owns: [
      'lib/contracts/**',
      'tools/swarm/**',
      'docs/**',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      '.gitignore',
      'README.md',
      'LICENSE',
      'tests/integration/**',
      'public/**',
      'art/**',
    ],
    dependsOn: [],
    phase: 'A-contracts',
  },
  {
    id: 'household-auth',
    letter: 'E',
    name: 'Household/Auth Agent',
    owns: ['domains/household/**', 'tests/unit/permissions.test.ts'],
    dependsOn: ['orchestrator'],
    phase: 'B-foundations',
  },
  {
    id: 'core-scheduling',
    letter: 'F',
    name: 'Core Scheduling Agent',
    owns: ['domains/scheduling/recurrence.ts', 'tests/unit/recurrence.test.ts'],
    dependsOn: ['orchestrator'],
    phase: 'C-domains',
  },
  {
    id: 'conflict-engine',
    letter: 'G',
    name: 'Conflict Engine Agent',
    owns: ['domains/scheduling/conflicts.ts', 'tests/unit/conflicts.test.ts'],
    dependsOn: ['orchestrator'],
    phase: 'C-domains',
  },
  {
    id: 'ai-actions',
    letter: 'H',
    name: 'AI Scheduling Agent',
    owns: ['domains/ai/**', 'tests/unit/ai-validator.test.ts'],
    dependsOn: ['orchestrator'],
    phase: 'C-domains',
  },
];

/** Minimal glob matcher: supports a trailing `/**` and exact paths. */
export function matchesGlob(pattern: string, file: string): boolean {
  if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
  return pattern === file;
}

export function ownersOf(file: string, agents: SwarmAgent[] = AGENTS): string[] {
  return agents.filter((a) => a.owns.some((p) => matchesGlob(p, file))).map((a) => a.id);
}

/** 'unowned' and 'contested' are themselves merge-gate failures, not fallbacks. */
export function ownerOf(file: string, agents: SwarmAgent[] = AGENTS): string {
  const owners = ownersOf(file, agents);
  if (owners.length === 1) return owners[0]!;
  return owners.length === 0 ? 'unowned' : 'contested';
}

export function agentById(id: string, agents: SwarmAgent[] = AGENTS): SwarmAgent | undefined {
  return agents.find((a) => a.id === id);
}
