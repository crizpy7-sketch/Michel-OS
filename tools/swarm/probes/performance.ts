/**
 * PERFORMANCE PROBE — Agent N (Performance/Accessibility) in probe form.
 *
 * A family calendar with several kids, a business, and multi-year recurring
 * series produces tens of thousands of occurrences. A naive O(n²) conflict
 * sweep passes every unit test on 6 events and melts on a real household.
 * This probe runs the real engines at scale against a wall-clock budget, and
 * checks the growth curve rather than a single absolute number.
 */
import { type ProbeOutcome, type ProbeCheck, check, tryImport } from './kit.ts';
import type { EventRecord, Occurrence } from '../../../lib/contracts/index.ts';

const HH = '11111111-1111-4111-8111-111111111111';
const CONFLICT_BUDGET_MS = 1500;
const RECURRENCE_BUDGET_MS = 750;

function syntheticLoad(n: number): {
  occurrences: Occurrence[];
  participants: Array<{ eventId: string; memberId: string; role: 'attendee' | 'responsible' | 'optional' }>;
} {
  const occurrences: Occurrence[] = [];
  const participants: Array<{ eventId: string; memberId: string; role: 'attendee' | 'responsible' | 'optional' }> = [];
  const members = 6;
  for (let i = 0; i < n; i++) {
    const dayOffset = Math.floor(i / 8);
    const start = new Date(Date.UTC(2026, 0, 1, 8, 0, 0) + dayOffset * 86_400_000 + (i % 8) * 3_600_000);
    const end = new Date(start.getTime() + 90 * 60_000); // 90 min → deliberate overlaps
    const memberId = `m-${i % members}`;
    occurrences.push({
      eventId: `e-${i}`,
      seriesId: null,
      occurrenceStart: start.toISOString(),
      occurrenceEnd: end.toISOString(),
      title: `Load ${i}`,
      domain: 'general',
      status: 'confirmed',
      participantIds: [memberId],
      isOverride: false,
    });
    participants.push({ eventId: `e-${i}`, memberId, role: i % 5 === 0 ? 'responsible' : 'attendee' });
  }
  return { occurrences, participants };
}

export async function run(): Promise<ProbeOutcome> {
  const checks: ProbeCheck[] = [];
  const missing: ProbeOutcome['missing'] = [];
  const stats: Record<string, string | number> = {};

  const conMod = await tryImport('../../../domains/scheduling/conflicts.ts');
  if ('error' in conMod) {
    missing.push({ module: 'domains/scheduling/conflicts.ts', owner: 'conflict-engine', reason: conMod.error });
  } else {
    const detect = conMod.mod.detectConflicts as ((i: Record<string, unknown>) => unknown[]) | undefined;
    if (typeof detect === 'function') {
      const big = syntheticLoad(5000);
      const t0 = performance.now();
      const found = detect({ householdId: HH, occurrences: big.occurrences, participants: big.participants });
      const elapsed = performance.now() - t0;
      stats.conflictSweepMs = Math.round(elapsed);
      stats.conflictLoad = 5000;
      stats.conflictsFound = Array.isArray(found) ? found.length : 0;
      checks.push(
        check(
          'conflict sweep handles 5k occurrences within budget',
          'conflict-engine',
          elapsed < CONFLICT_BUDGET_MS,
          `took ${Math.round(elapsed)}ms, budget ${CONFLICT_BUDGET_MS}ms`,
        ),
      );

      // Growth check: 4x the input should not cost ~16x the time.
      const small = syntheticLoad(1250);
      const t1 = performance.now();
      detect({ householdId: HH, occurrences: small.occurrences, participants: small.participants });
      const smallMs = Math.max(performance.now() - t1, 0.5);
      const ratio = elapsed / smallMs;
      stats.growthRatio4x = Number(ratio.toFixed(2));
      checks.push(
        check(
          'conflict sweep is better than quadratic',
          'conflict-engine',
          ratio < 10,
          `4x input cost ${ratio.toFixed(1)}x time (quadratic would be ~16x); ${Math.round(smallMs)}ms -> ${Math.round(elapsed)}ms`,
        ),
      );
    }
  }

  const recMod = await tryImport('../../../domains/scheduling/recurrence.ts');
  if ('error' in recMod) {
    missing.push({ module: 'domains/scheduling/recurrence.ts', owner: 'core-scheduling', reason: recMod.error });
  } else {
    const expand = recMod.mod.expandOccurrences as
      | ((e: EventRecord, w: { from: string; to: string }, o?: Record<string, unknown>) => Occurrence[])
      | undefined;
    if (typeof expand === 'function') {
      // An unbounded daily rule over a decade must be capped, not enumerated forever.
      const unbounded: EventRecord = {
        id: 'e-unbounded',
        householdId: HH,
        scheduleId: 's-1',
        domain: 'general',
        title: 'Forever',
        startsAt: '2026-01-01T09:00:00.000Z',
        endsAt: '2026-01-01T10:00:00.000Z',
        allDay: false,
        timezone: 'UTC',
        status: 'confirmed',
        createdBy: 'm-1',
        recurrence: { freq: 'DAILY', interval: 1 },
      };
      const t0 = performance.now();
      const out = expand(unbounded, { from: '2026-01-01T00:00:00.000Z', to: '2036-01-01T00:00:00.000Z' });
      const elapsed = performance.now() - t0;
      stats.recurrenceExpandMs = Math.round(elapsed);
      stats.recurrenceCapped = out.length;
      checks.push(
        check(
          'unbounded recurrence is capped and fast',
          'core-scheduling',
          elapsed < RECURRENCE_BUDGET_MS && out.length <= 1000,
          `10-year unbounded daily rule produced ${out.length} occurrences in ${Math.round(elapsed)}ms (cap 1000, budget ${RECURRENCE_BUDGET_MS}ms)`,
        ),
      );
    }
  }

  return { checks, missing, stats };
}
