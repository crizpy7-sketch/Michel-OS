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


  /* --------------------------------------- Phase C2: the experience layer */

  /*
   * Every C2 module produces a list somebody reads. A list that reshuffles
   * between two identical loads teaches people to distrust the first row, so
   * each of these is fed the same data twice and then shuffled.
   */

  const personalMod = await tryImport('../../../domains/personal/lists.ts');
  if ('error' in personalMod) {
    missing.push({ module: 'domains/personal/lists.ts', owner: 'personal-organization', reason: personalMod.error });
  } else {
    const groupByStore = personalMod.mod.groupByStore as ((items: unknown[]) => unknown) | undefined;
    if (typeof groupByStore !== 'function') {
      checks.push(check('groupByStore() exported', 'personal-organization', false, 'lists.ts does not export groupByStore()'));
    } else {
      const stores = ['Aldi', 'aldi', 'Hardware Depot', undefined];
      const items = Array.from({ length: 60 }, (_, i) => ({
        id: `si-${i}`,
        householdId: HH,
        listName: 'Household',
        name: `Item ${String(60 - i).padStart(3, '0')}`,
        quantity: (i % 3) + 1,
        status: 'needed',
        ...(stores[i % stores.length] === undefined ? {} : { store: stores[i % stores.length] }),
      }));

      const a = groupByStore(items);
      checks.push(
        check('groupByStore is repeatable', 'personal-organization', stableJson(a) === stableJson(groupByStore(items)), 'two identical calls grouped differently'),
      );
      checks.push(
        check(
          'shopping groups do not depend on list order',
          'personal-organization',
          stableJson(a) === stableJson(groupByStore(shuffle(items))),
          'the same list rendered two different shopping trips depending on row order',
        ),
      );
    }
  }

  const staffingMod = await tryImport('../../../domains/shia-baby/staffing.ts');
  if ('error' in staffingMod) {
    missing.push({ module: 'domains/shia-baby/staffing.ts', owner: 'business-staffing', reason: staffingMod.error });
  } else {
    const analyzeSchedule = staffingMod.mod.analyzeSchedule as ((input: Record<string, unknown>) => { warnings: unknown[] }) | undefined;
    if (typeof analyzeSchedule !== 'function') {
      checks.push(check('analyzeSchedule() exported', 'business-staffing', false, 'staffing.ts does not export analyzeSchedule()'));
    } else {
      const employees = Array.from({ length: 4 }, (_, i) => ({
        id: `emp-${i}`, businessId: 'biz', memberId: null, displayName: `Employee ${i}`, hourlyRate: 18, active: true,
      }));
      const shifts = Array.from({ length: 40 }, (_, i) => {
        const day = 24 + (i % 5);
        const startHour = 8 + (i % 6);
        return {
          id: `s-${i}`,
          businessId: 'biz',
          employeeId: `emp-${i % 4}`,
          startsAt: `2026-08-${day}T${String(startHour).padStart(2, '0')}:00:00.000Z`,
          endsAt: `2026-08-${day}T${String(startHour + 5).padStart(2, '0')}:00:00.000Z`,
          status: 'draft',
        };
      });
      const input = {
        businessId: 'biz',
        employees,
        shifts,
        window: { from: '2026-08-24T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' },
      };

      const a = analyzeSchedule(input);
      checks.push(
        check('analyzeSchedule is repeatable', 'business-staffing', stableJson(a) === stableJson(analyzeSchedule(input)), 'two identical calls warned differently'),
      );
      checks.push(
        check(
          'staffing warnings do not depend on roster order',
          'business-staffing',
          stableJson(a) === stableJson(analyzeSchedule({ ...input, shifts: shuffle(shifts), employees: shuffle(employees, 7) })),
          'shuffling the roster changed which warnings a manager sees',
        ),
      );
      stats.staffingWarnings = a.warnings.length;
    }
  }

  const ledgerMod = await tryImport('../../../domains/shia-baby/ledger.ts');
  if ('error' in ledgerMod) {
    missing.push({ module: 'domains/shia-baby/ledger.ts', owner: 'business-ledger', reason: ledgerMod.error });
  } else {
    const summarizeSales = ledgerMod.mod.summarizeSales as ((input: Record<string, unknown>) => { totalGrossCents: number }) | undefined;
    if (typeof summarizeSales !== 'function') {
      checks.push(check('summarizeSales() exported', 'business-ledger', false, 'ledger.ts does not export summarizeSales()'));
    } else {
      const sales = Array.from({ length: 200 }, (_, i) => ({
        id: `sale-${i}`,
        businessId: 'biz',
        at: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T${String(9 + (i % 8)).padStart(2, '0')}:15:00.000Z`,
        items: [
          { productId: `p-${i % 7}`, quantity: (i % 3) + 1, unitPriceCents: 500 + (i % 5) * 100 },
          { productId: `p-${(i + 3) % 7}`, quantity: 1, unitPriceCents: 1299 },
        ],
      }));
      const input = { businessId: 'biz', sales, period: 'day', timezone: 'America/Chicago' };

      const a = summarizeSales(input);
      checks.push(
        check('summarizeSales is repeatable', 'business-ledger', stableJson(a) === stableJson(summarizeSales(input)), 'two identical calls totalled differently'),
      );
      checks.push(
        check(
          'sales rollups do not depend on row order',
          'business-ledger',
          stableJson(a) === stableJson(summarizeSales({ ...input, sales: shuffle(sales) })),
          'shuffling the sales changed the rankings or the buckets',
        ),
      );
      // Money must survive the round trip as integers; a float total is how a
      // quarter closes a cent out.
      checks.push(
        check(
          'sales totals stay whole cents',
          'business-ledger',
          Number.isInteger(a.totalGrossCents),
          `total was ${a.totalGrossCents}, which is not a whole number of cents`,
        ),
      );
    }
  }

  const searchMod = await tryImport('../../../domains/platform/search.ts');
  if ('error' in searchMod) {
    missing.push({ module: 'domains/platform/search.ts', owner: 'platform', reason: searchMod.error });
  } else {
    const SearchIndex = searchMod.mod.SearchIndex as { build: (docs: unknown[]) => unknown } | undefined;
    const search = searchMod.mod.search as
      | ((index: unknown, q: string, m: unknown, h: string, o?: Record<string, unknown>) => unknown[])
      | undefined;

    if (typeof search !== 'function' || SearchIndex === undefined) {
      checks.push(check('search() exported', 'platform', false, 'search.ts does not export search()/SearchIndex'));
    } else {
      const owner = { id: 'm-1', householdId: HH, userId: null, displayName: 'Owner', role: 'owner', color: 'brand.primary', active: true };
      const docs = Array.from({ length: 120 }, (_, i) => ({
        entity: 'event',
        id: `e-${i}`,
        householdId: HH,
        title: i % 3 === 0 ? 'Soccer practice' : `Event ${i}`,
        body: 'practice at the fields',
        at: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T12:00:00.000Z`,
      }));

      const a = search(SearchIndex.build(docs), 'soccer practice', owner, HH);
      checks.push(
        check(
          'search results do not depend on index order',
          'platform',
          stableJson(a) === stableJson(search(SearchIndex.build(shuffle(docs)), 'soccer practice', owner, HH)),
          'the same query ranked differently depending on the order documents were pushed',
        ),
      );
      stats.searchHits = a.length;
    }
  }

  const inboxMod = await tryImport('../../../domains/ai/inbox.ts');
  if ('error' in inboxMod) {
    missing.push({ module: 'domains/ai/inbox.ts', owner: 'ai-actions', reason: inboxMod.error });
  } else {
    const classifyInboxItem = inboxMod.mod.classifyInboxItem as
      | ((item: unknown, ctx: Record<string, unknown>) => unknown)
      | undefined;

    if (typeof classifyInboxItem !== 'function') {
      checks.push(check('classifyInboxItem() exported', 'ai-actions', false, 'inbox.ts does not export classifyInboxItem()'));
    } else {
      const ctx = {
        householdId: HH,
        now: '2026-08-24T14:00:00.000Z',
        timezone: 'America/Chicago',
        members: [{ id: 'm-leila', displayName: 'Leila' }, { id: 'm-mateo', displayName: 'Mateo' }],
      };
      const texts = [
        'we need milk',
        'Mateo plays Saturday at 4',
        'Leila has practice every Tuesday and Thursday from 6 to 8',
        'remind me to call the school tomorrow at 10am',
      ];

      const classifyAll = (order: string[]): unknown[] =>
        order.map((rawText) =>
          classifyInboxItem(
            { id: `inb-${rawText.length}`, householdId: HH, rawText, capturedBy: 'm-1', capturedAt: ctx.now, status: 'unclassified' },
            ctx,
          ),
        );

      const a = classifyAll(texts);
      checks.push(
        check(
          'inbox classification is repeatable',
          'ai-actions',
          stableJson(a) === stableJson(classifyAll(texts)),
          'the same sentence classified two different ways',
        ),
      );
      // Order-independence matters here because a batch import runs these in
      // whatever order the rows arrive; one item must never influence the next.
      const shuffledOrder = shuffle(texts);
      const byText = new Map(shuffledOrder.map((t, i) => [t, (classifyAll(shuffledOrder) as unknown[])[i]]));
      checks.push(
        check(
          'one inbox item never influences the next',
          'ai-actions',
          texts.every((t, i) => stableJson(byText.get(t)) === stableJson(a[i])),
          'classifying a batch in a different order changed the results',
        ),
      );
    }
  }

  return { checks, missing, stats };
}
