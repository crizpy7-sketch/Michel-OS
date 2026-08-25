/**
 * DETERMINISM PROBE.
 *
 * ARCHITECTURE.md §2: "Deterministic database mutations". The frozen Conflict
 * contract requires a deterministic id ("same inputs must yield same id").
 * Unit tests written by the owning agent can pass while the module is still
 * order-sensitive, because the agent tends to feed it already-sorted data.
 * This probe feeds the same data twice and then shuffled, and demands the
 * output be byte-identical both times.
 */
import { type ProbeOutcome, type ProbeCheck, check, tryImport, stableJson } from './kit.ts';
import type { EventRecord, Occurrence } from '../../../lib/contracts/index.ts';

const HH = '11111111-1111-4111-8111-111111111111';

function baseEvent(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'e-1',
    householdId: HH,
    scheduleId: 's-1',
    domain: 'practice',
    title: 'Soccer practice',
    startsAt: '2026-09-01T16:00:00.000Z',
    endsAt: '2026-09-01T17:00:00.000Z',
    allDay: false,
    timezone: 'America/Chicago',
    status: 'confirmed',
    createdBy: 'm-1',
    ...over,
  };
}

/** Deterministic shuffle (seeded), so the probe itself is reproducible. */
function shuffle<T>(items: T[], seed = 1337): T[] {
  const out = items.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    const j = s % (i + 1);
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export async function run(): Promise<ProbeOutcome> {
  const checks: ProbeCheck[] = [];
  const missing: ProbeOutcome['missing'] = [];
  const stats: Record<string, string | number> = {};

  /* ------------------------------------------------- recurrence engine */

  const recMod = await tryImport('../../../domains/scheduling/recurrence.ts');
  if ('error' in recMod) {
    missing.push({ module: 'domains/scheduling/recurrence.ts', owner: 'core-scheduling', reason: recMod.error });
  } else {
    const expand = recMod.mod.expandOccurrences as
      | ((e: EventRecord, w: { from: string; to: string }, o?: Record<string, unknown>) => Occurrence[])
      | undefined;

    if (typeof expand !== 'function') {
      checks.push(check('expandOccurrences() exported', 'core-scheduling', false, 'recurrence.ts does not export expandOccurrences()'));
    } else {
      const weekly = baseEvent({ recurrence: { freq: 'WEEKLY', interval: 1, byWeekday: ['MO', 'WE', 'FR'] } });
      const window = { from: '2026-09-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' };

      const first = expand(weekly, window);
      const second = expand(weekly, window);
      checks.push(
        check(
          'expandOccurrences is repeatable',
          'core-scheduling',
          stableJson(first) === stableJson(second),
          'two identical calls produced different occurrence arrays',
        ),
      );
      stats.recurrenceOccurrences = first.length;

      const sorted = first.every((o, i) => i === 0 || o.occurrenceStart >= first[i - 1]!.occurrenceStart);
      checks.push(check('occurrences are sorted ascending', 'core-scheduling', sorted, 'occurrenceStart is not monotonically non-decreasing'));

      // `count` must be measured from the series start, not from the query window.
      const counted = baseEvent({ id: 'e-count', recurrence: { freq: 'DAILY', interval: 1, count: 5 } });
      const wide = expand(counted, { from: '2026-08-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' });
      const narrow = expand(counted, { from: '2026-09-03T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' });
      const narrowStarts = new Set(narrow.map((o) => o.occurrenceStart));
      const consistent = wide.length === 5 && [...narrowStarts].every((s) => wide.some((o) => o.occurrenceStart === s));
      checks.push(
        check(
          'count is anchored to the series, not the query window',
          'core-scheduling',
          consistent,
          `wide window yielded ${wide.length} (expected 5) and the narrow window is not a subset`,
        ),
      );
    }
  }

  /* -------------------------------------------------- conflict engine */

  const conMod = await tryImport('../../../domains/scheduling/conflicts.ts');
  if ('error' in conMod) {
    missing.push({ module: 'domains/scheduling/conflicts.ts', owner: 'conflict-engine', reason: conMod.error });
  } else {
    const detect = conMod.mod.detectConflicts as ((i: Record<string, unknown>) => Array<{ id: string }>) | undefined;

    if (typeof detect !== 'function') {
      checks.push(check('detectConflicts() exported', 'conflict-engine', false, 'conflicts.ts does not export detectConflicts()'));
    } else {
      const occurrences: Occurrence[] = [];
      const participants: Array<{ eventId: string; memberId: string; role: 'attendee' | 'responsible' | 'optional' }> = [];
      for (let i = 0; i < 40; i++) {
        const day = 1 + (i % 10);
        const hour = 9 + (i % 6);
        occurrences.push({
          eventId: `e-${i}`,
          seriesId: null,
          occurrenceStart: `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`,
          occurrenceEnd: `2026-09-${String(day).padStart(2, '0')}T${String(hour + 1).padStart(2, '0')}:30:00.000Z`,
          title: `Event ${i}`,
          domain: 'general',
          status: 'confirmed',
          participantIds: [`m-${i % 3}`],
          isOverride: false,
        });
        participants.push({ eventId: `e-${i}`, memberId: `m-${i % 3}`, role: i % 4 === 0 ? 'responsible' : 'attendee' });
      }

      const input = { householdId: HH, occurrences, participants };
      const a = detect(input);
      const b = detect(input);
      checks.push(
        check('detectConflicts is repeatable', 'conflict-engine', stableJson(a) === stableJson(b), 'two identical calls produced different conflicts'),
      );

      const shuffled = detect({ householdId: HH, occurrences: shuffle(occurrences), participants: shuffle(participants, 99) });
      checks.push(
        check(
          'conflict output is independent of input order',
          'conflict-engine',
          stableJson(a) === stableJson(shuffled),
          `shuffling the input changed the result: ${a.length} conflicts vs ${shuffled.length}, ids ${a.map((c) => c.id.slice(0, 6)).join(',')} vs ${shuffled.map((c) => c.id.slice(0, 6)).join(',')}`,
        ),
      );
      stats.conflictsDetected = a.length;
    }
  }

  return { checks, missing, stats };
}
