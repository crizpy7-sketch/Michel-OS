/** Shared shape for runtime probes. A probe exercises real agent code and
 *  reports discrete pass/fail checks; the gauntlet turns those into findings. */

export interface ProbeCheck {
  name: string;
  passed: boolean;
  /** Agent id responsible when this check fails. */
  owner: string;
  detail: string;
}

export interface ProbeOutcome {
  checks: ProbeCheck[];
  stats?: Record<string, string | number>;
  /** Set when a module under probe is missing entirely (agent has not delivered). */
  missing?: Array<{ module: string; owner: string; reason: string }>;
}

/** Import an agent module without exploding when the agent has not shipped it yet. */
export async function tryImport(spec: string): Promise<{ mod: Record<string, unknown> } | { error: string }> {
  try {
    const mod = (await import(spec)) as Record<string, unknown>;
    return { mod };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function check(name: string, owner: string, passed: boolean, detail: string): ProbeCheck {
  return { name, owner, passed, detail };
}

/** Assert-style helper that converts a thrown error into a failed check. */
export function guarded(name: string, owner: string, fn: () => string): ProbeCheck {
  try {
    const detail = fn();
    return check(name, owner, true, detail);
  } catch (e) {
    return check(name, owner, false, e instanceof Error ? `${e.message}` : String(e));
  }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return v;
  });
}
