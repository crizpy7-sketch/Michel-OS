/**
 * Unit tests for the universal recurrence engine (domains/scheduling/recurrence.ts).
 *
 * Anchor dates used throughout: 2026-01-05 is a MONDAY, so a weekly rule that
 * inherits its weekday from the series start lands on Mondays.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_OCCURRENCES,
  expandOccurrences,
  occurrencesOverlap,
} from '../../domains/scheduling/recurrence.ts';
import type { EventRecord, Occurrence, RecurrenceRule } from '../../lib/contracts/index.ts';

/* --------------------------------------------------------------- fixtures */

const BASE: EventRecord = {
  id: 'evt-soccer',
  householdId: 'hh-1',
  scheduleId: 'sch-practice',
  domain: 'practice',
  title: 'Soccer practice',
  startsAt: '2026-01-05T17:00:00.000Z', // Monday
  endsAt: '2026-01-05T18:00:00.000Z',
  allDay: false,
  timezone: 'UTC',
  status: 'confirmed',
  createdBy: 'mem-parent',
};

function makeEvent(patch: Partial<EventRecord> = {}): EventRecord {
  return { ...BASE, ...patch };
}

function makeRecurring(rule: RecurrenceRule, patch: Partial<EventRecord> = {}): EventRecord {
  return makeEvent({ recurrence: rule, ...patch });
}

const startsOf = (occurrences: Occurrence[]): string[] =>
  occurrences.map((o) => o.occurrenceStart);

const WINDOW_JAN = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };

function occ(start: string, end: string, patch: Partial<Occurrence> = {}): Occurrence {
  return {
    eventId: 'x',
    seriesId: null,
    occurrenceStart: start,
    occurrenceEnd: end,
    title: 't',
    domain: 'general',
    status: 'confirmed',
    participantIds: [],
    isOverride: false,
    ...patch,
  };
}

/* --------------------------------------------------- 1. non-recurring events */

test('non-recurring event inside the window yields exactly one occurrence', () => {
  const result = expandOccurrences(makeEvent(), WINDOW_JAN);
  assert.equal(result.length, 1);
  const first = result[0];
  assert.ok(first);
  assert.equal(first.eventId, 'evt-soccer');
  assert.equal(first.seriesId, null, 'a one-off event has no series');
  assert.equal(first.occurrenceStart, '2026-01-05T17:00:00.000Z');
  assert.equal(first.occurrenceEnd, '2026-01-05T18:00:00.000Z');
  assert.equal(first.title, 'Soccer practice');
  assert.equal(first.domain, 'practice');
  assert.equal(first.status, 'confirmed');
  assert.equal(first.isOverride, false);
  assert.deepEqual(first.participantIds, []);
});

test('non-recurring event outside the window yields nothing', () => {
  const result = expandOccurrences(makeEvent(), {
    from: '2026-03-01T00:00:00.000Z',
    to: '2026-04-01T00:00:00.000Z',
  });
  assert.deepEqual(result, []);
});

test('non-recurring event straddling the window start is included', () => {
  const result = expandOccurrences(makeEvent(), {
    from: '2026-01-05T17:30:00.000Z',
    to: '2026-01-06T00:00:00.000Z',
  });
  assert.equal(result.length, 1);
});

test('half-open window: an event ending exactly at window.from is excluded', () => {
  const result = expandOccurrences(makeEvent(), {
    from: '2026-01-05T18:00:00.000Z',
    to: '2026-01-06T00:00:00.000Z',
  });
  assert.deepEqual(result, []);
});

test('half-open window: an event starting exactly at window.to is excluded', () => {
  const result = expandOccurrences(makeEvent(), {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-05T17:00:00.000Z',
  });
  assert.deepEqual(result, []);
});

test('participantIds supplied by the caller are stamped on every occurrence', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1, count: 3 });
  const result = expandOccurrences(event, WINDOW_JAN, {
    participantIds: ['mem-kid', 'mem-parent'],
  });
  assert.equal(result.length, 3);
  for (const occurrence of result) {
    assert.deepEqual(occurrence.participantIds, ['mem-kid', 'mem-parent']);
  }
});

test('an event whose whole series is cancelled yields nothing', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1, count: 5 }, { status: 'cancelled' });
  assert.deepEqual(expandOccurrences(event, WINDOW_JAN), []);
});

/* ---------------------------------------------------------------- 2. DAILY */

test('DAILY every 3 days honours interval and count', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 3, count: 4 });
  assert.deepEqual(startsOf(expandOccurrences(event, WINDOW_JAN)), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-08T17:00:00.000Z',
    '2026-01-11T17:00:00.000Z',
    '2026-01-14T17:00:00.000Z',
  ]);
});

test('DAILY every day is contiguous and every occurrence carries the series id', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1, count: 3 });
  const result = expandOccurrences(event, WINDOW_JAN);
  assert.deepEqual(startsOf(result), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-06T17:00:00.000Z',
    '2026-01-07T17:00:00.000Z',
  ]);
  for (const occurrence of result) {
    assert.equal(occurrence.seriesId, 'evt-soccer');
    assert.equal(occurrence.isOverride, false);
  }
});

/* --------------------------------------------------------------- 3. WEEKLY */

test('WEEKLY byWeekday expands Mon/Wed/Fri', () => {
  const event = makeRecurring({ freq: 'WEEKLY', interval: 1, byWeekday: ['MO', 'WE', 'FR'] });
  const result = expandOccurrences(event, {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-17T00:00:00.000Z',
  });
  assert.deepEqual(startsOf(result), [
    '2026-01-05T17:00:00.000Z', // Mon
    '2026-01-07T17:00:00.000Z', // Wed
    '2026-01-09T17:00:00.000Z', // Fri
    '2026-01-12T17:00:00.000Z',
    '2026-01-14T17:00:00.000Z',
    '2026-01-16T17:00:00.000Z',
  ]);
});

test('WEEKLY every 2 weeks skips the intervening week', () => {
  const event = makeRecurring({ freq: 'WEEKLY', interval: 2, byWeekday: ['MO', 'FR'] });
  assert.deepEqual(startsOf(expandOccurrences(event, WINDOW_JAN)), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-09T17:00:00.000Z',
    '2026-01-19T17:00:00.000Z',
    '2026-01-23T17:00:00.000Z',
  ]);
});

test('WEEKLY without byWeekday inherits the weekday of the series start', () => {
  const event = makeRecurring({ freq: 'WEEKLY', interval: 1 });
  assert.deepEqual(startsOf(expandOccurrences(event, WINDOW_JAN)), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-12T17:00:00.000Z',
    '2026-01-19T17:00:00.000Z',
    '2026-01-26T17:00:00.000Z',
  ]);
});

test('WEEKLY byWeekday does not emit selected days that fall before the series start', () => {
  // Series starts Wednesday 2026-01-07; the Monday of that same week is skipped.
  const event = makeRecurring(
    { freq: 'WEEKLY', interval: 1, byWeekday: ['MO', 'WE'] },
    { startsAt: '2026-01-07T17:00:00.000Z', endsAt: '2026-01-07T18:00:00.000Z' },
  );
  assert.deepEqual(startsOf(expandOccurrences(event, WINDOW_JAN)), [
    '2026-01-07T17:00:00.000Z',
    '2026-01-12T17:00:00.000Z',
    '2026-01-14T17:00:00.000Z',
    '2026-01-19T17:00:00.000Z',
    '2026-01-21T17:00:00.000Z',
    '2026-01-26T17:00:00.000Z',
    '2026-01-28T17:00:00.000Z',
  ]);
});

/* -------------------------------------------------------------- 4. MONTHLY */

test('MONTHLY byMonthDay 31 SKIPS months without a 31st (Feb-31 is never clamped)', () => {
  const event = makeRecurring({ freq: 'MONTHLY', interval: 1, byMonthDay: [31] });
  const result = expandOccurrences(event, {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-07-01T00:00:00.000Z',
  });
  assert.deepEqual(startsOf(result), [
    '2026-01-31T17:00:00.000Z',
    '2026-03-31T17:00:00.000Z',
    '2026-05-31T17:00:00.000Z',
  ]);
  // Explicitly: no February occurrence at all, clamped or rolled over.
  assert.equal(
    result.some((o) => o.occurrenceStart.startsWith('2026-02')),
    false,
  );
  assert.equal(
    result.some((o) => o.occurrenceStart.startsWith('2026-03-03')),
    false,
  );
});

test('MONTHLY without byMonthDay inherits the start day and skips short months', () => {
  const event = makeRecurring(
    { freq: 'MONTHLY', interval: 1 },
    { startsAt: '2026-01-31T17:00:00.000Z', endsAt: '2026-01-31T18:00:00.000Z' },
  );
  assert.deepEqual(
    startsOf(
      expandOccurrences(event, {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      }),
    ),
    ['2026-01-31T17:00:00.000Z', '2026-03-31T17:00:00.000Z', '2026-05-31T17:00:00.000Z'],
  );
});

test('MONTHLY every 2 months with several byMonthDay values stays ordered', () => {
  const event = makeRecurring({ freq: 'MONTHLY', interval: 2, byMonthDay: [15, 1] });
  assert.deepEqual(
    startsOf(
      expandOccurrences(event, {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      }),
    ),
    [
      // Jan 1 precedes the series start (Jan 5) and is not emitted.
      '2026-01-15T17:00:00.000Z',
      '2026-03-01T17:00:00.000Z',
      '2026-03-15T17:00:00.000Z',
      '2026-05-01T17:00:00.000Z',
      '2026-05-15T17:00:00.000Z',
    ],
  );
});

test('MONTHLY day 30 is skipped in February', () => {
  const event = makeRecurring({ freq: 'MONTHLY', interval: 1, byMonthDay: [30] });
  const result = expandOccurrences(event, {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-04-01T00:00:00.000Z',
  });
  assert.deepEqual(startsOf(result), ['2026-01-30T17:00:00.000Z', '2026-03-30T17:00:00.000Z']);
});

/* ------------------------------------------------------- 5. until and count */

test('until is inclusive of its own date', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1, until: '2026-01-08' });
  assert.deepEqual(startsOf(expandOccurrences(event, WINDOW_JAN)), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-06T17:00:00.000Z',
    '2026-01-07T17:00:00.000Z',
    '2026-01-08T17:00:00.000Z',
  ]);
});

test('until on the series start date yields exactly one occurrence', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1, until: '2026-01-05' });
  assert.equal(expandOccurrences(event, WINDOW_JAN).length, 1);
});

test('count is measured from the series start, NOT from the query window', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1, count: 5 });
  // Full view: Jan 5..Jan 9.
  assert.equal(expandOccurrences(event, WINDOW_JAN).length, 5);
  // A later window must NOT restart the count — only occurrences 3,4,5 remain.
  assert.deepEqual(
    startsOf(
      expandOccurrences(event, {
        from: '2026-01-07T00:00:00.000Z',
        to: '2026-01-20T00:00:00.000Z',
      }),
    ),
    ['2026-01-07T17:00:00.000Z', '2026-01-08T17:00:00.000Z', '2026-01-09T17:00:00.000Z'],
  );
});

test('count still holds when the series began long before the window', () => {
  const event = makeRecurring(
    { freq: 'DAILY', interval: 1 },
    { startsAt: '2020-01-05T17:00:00.000Z', endsAt: '2020-01-05T18:00:00.000Z' },
  );
  const result = expandOccurrences(event, {
    from: '2026-01-05T00:00:00.000Z',
    to: '2026-01-12T00:00:00.000Z',
  });
  assert.equal(result.length, 7, 'a six-year-old daily series still expands into a 2026 week');
  assert.equal(result[0]?.occurrenceStart, '2026-01-05T17:00:00.000Z');
});

/* ------------------------------------------------------------ 6. exceptions */

test('exceptions remove the cancelled dates outright', () => {
  const event = makeRecurring({
    freq: 'DAILY',
    interval: 1,
    count: 5,
    exceptions: ['2026-01-07', '2026-01-08'],
  });
  assert.deepEqual(startsOf(expandOccurrences(event, WINDOW_JAN)), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-06T17:00:00.000Z',
    '2026-01-09T17:00:00.000Z',
  ]);
});

test('an exception consumes a count slot (expand, then subtract)', () => {
  const event = makeRecurring({
    freq: 'DAILY',
    interval: 1,
    count: 3,
    exceptions: ['2026-01-06'],
  });
  assert.deepEqual(startsOf(expandOccurrences(event, WINDOW_JAN)), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-07T17:00:00.000Z',
  ]);
});

/* ------------------------------------------------------------- 7. overrides */

const overrideOf = (patch: Partial<EventRecord>): EventRecord =>
  makeEvent({
    id: 'evt-soccer-override',
    seriesId: 'evt-soccer',
    ...patch,
  });

test('an override REPLACES its occurrence in place', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1, count: 3 });
  const override = overrideOf({
    recurrenceId: '2026-01-06T17:00:00.000Z',
    startsAt: '2026-01-06T19:00:00.000Z',
    endsAt: '2026-01-06T20:30:00.000Z',
    title: 'Soccer practice (moved to the late field)',
  });
  const result = expandOccurrences(event, WINDOW_JAN, { overrides: [override] });
  assert.deepEqual(startsOf(result), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-06T19:00:00.000Z',
    '2026-01-07T17:00:00.000Z',
  ]);
  const moved = result[1];
  assert.ok(moved);
  assert.equal(moved.isOverride, true);
  assert.equal(moved.eventId, 'evt-soccer-override');
  assert.equal(moved.seriesId, 'evt-soccer');
  assert.equal(moved.occurrenceEnd, '2026-01-06T20:30:00.000Z');
  assert.equal(moved.title, 'Soccer practice (moved to the late field)');
  assert.equal(result[0]?.isOverride, false);
});

test('a cancelled override deletes its occurrence', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1, count: 3 });
  const override = overrideOf({
    recurrenceId: '2026-01-06T17:00:00.000Z',
    status: 'cancelled',
  });
  assert.deepEqual(startsOf(expandOccurrences(event, WINDOW_JAN, { overrides: [override] })), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-07T17:00:00.000Z',
  ]);
});

test('an override that moves an occurrence OUT of the window makes it disappear', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1, count: 5 });
  const override = overrideOf({
    recurrenceId: '2026-01-07T17:00:00.000Z',
    startsAt: '2026-02-20T17:00:00.000Z',
    endsAt: '2026-02-20T18:00:00.000Z',
  });
  assert.deepEqual(startsOf(expandOccurrences(event, WINDOW_JAN, { overrides: [override] })), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-06T17:00:00.000Z',
    '2026-01-08T17:00:00.000Z',
    '2026-01-09T17:00:00.000Z',
  ]);
});

test('an override that moves an occurrence INTO the window makes it appear', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1, count: 5 });
  const override = overrideOf({
    recurrenceId: '2026-01-07T17:00:00.000Z',
    startsAt: '2026-02-20T17:00:00.000Z',
    endsAt: '2026-02-20T18:00:00.000Z',
  });
  const result = expandOccurrences(
    event,
    { from: '2026-02-15T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
    { overrides: [override] },
  );
  assert.deepEqual(startsOf(result), ['2026-02-20T17:00:00.000Z']);
  assert.equal(result[0]?.isOverride, true);
});

test('an override anchored AFTER the window can still be pulled into it', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1 });
  const override = overrideOf({
    recurrenceId: '2026-01-20T17:00:00.000Z', // well past window.to
    startsAt: '2026-01-08T12:00:00.000Z',
    endsAt: '2026-01-08T13:00:00.000Z',
  });
  const result = expandOccurrences(
    event,
    { from: '2026-01-01T00:00:00.000Z', to: '2026-01-10T00:00:00.000Z' },
    { overrides: [override] },
  );
  assert.deepEqual(startsOf(result), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-06T17:00:00.000Z',
    '2026-01-07T17:00:00.000Z',
    '2026-01-08T12:00:00.000Z', // sorted into place ahead of the 17:00 instance
    '2026-01-08T17:00:00.000Z',
    '2026-01-09T17:00:00.000Z',
  ]);
});

test('overrides belonging to another series are ignored', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1, count: 2 });
  const foreign = overrideOf({
    seriesId: 'evt-someone-else',
    recurrenceId: '2026-01-06T17:00:00.000Z',
    status: 'cancelled',
  });
  assert.equal(expandOccurrences(event, WINDOW_JAN, { overrides: [foreign] }).length, 2);
});

test('an exception beats an override for the same date', () => {
  const event = makeRecurring({
    freq: 'DAILY',
    interval: 1,
    count: 3,
    exceptions: ['2026-01-06'],
  });
  const override = overrideOf({
    recurrenceId: '2026-01-06T17:00:00.000Z',
    startsAt: '2026-01-06T19:00:00.000Z',
    endsAt: '2026-01-06T20:00:00.000Z',
  });
  assert.deepEqual(startsOf(expandOccurrences(event, WINDOW_JAN, { overrides: [override] })), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-07T17:00:00.000Z',
  ]);
});

test('a one-off event can be overridden through its own start instant', () => {
  const override = overrideOf({
    recurrenceId: '2026-01-05T17:00:00.000Z',
    startsAt: '2026-01-05T20:00:00.000Z',
    endsAt: '2026-01-05T21:00:00.000Z',
  });
  const result = expandOccurrences(makeEvent(), WINDOW_JAN, { overrides: [override] });
  assert.deepEqual(startsOf(result), ['2026-01-05T20:00:00.000Z']);
  assert.equal(result[0]?.isOverride, true);
});

/* --------------------------------------------- 8. duration + 9. determinism */

test('duration is preserved from the base event across every occurrence', () => {
  const event = makeRecurring(
    { freq: 'WEEKLY', interval: 1, byWeekday: ['MO', 'TH'] },
    { endsAt: '2026-01-05T18:30:00.000Z' }, // 90 minutes
  );
  const result = expandOccurrences(event, WINDOW_JAN);
  assert.ok(result.length >= 4);
  for (const occurrence of result) {
    const span =
      Date.parse(occurrence.occurrenceEnd) - Date.parse(occurrence.occurrenceStart);
    assert.equal(span, 90 * 60 * 1000);
  }
});

test('results are sorted ascending by occurrenceStart', () => {
  const event = makeRecurring({ freq: 'WEEKLY', interval: 1, byWeekday: ['FR', 'MO', 'WE'] });
  const result = expandOccurrences(event, WINDOW_JAN);
  for (let i = 1; i < result.length; i += 1) {
    const previous = result[i - 1];
    const current = result[i];
    assert.ok(previous && current);
    assert.ok(Date.parse(previous.occurrenceStart) < Date.parse(current.occurrenceStart));
  }
});

test('expansion is deterministic — identical inputs give a deeply equal array', () => {
  const event = makeRecurring({
    freq: 'WEEKLY',
    interval: 2,
    byWeekday: ['MO', 'WE', 'FR'],
    exceptions: ['2026-01-09'],
  });
  const override = overrideOf({
    recurrenceId: '2026-01-07T17:00:00.000Z',
    startsAt: '2026-01-07T19:00:00.000Z',
    endsAt: '2026-01-07T20:00:00.000Z',
  });
  const options = { participantIds: ['mem-kid'], overrides: [override] };
  const first = expandOccurrences(event, WINDOW_JAN, options);
  const second = expandOccurrences(event, WINDOW_JAN, options);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
});

/* --------------------------------------------------------- 10. guardrails */

test('an unbounded rule over a huge window is capped at maxOccurrences', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1 });
  const result = expandOccurrences(
    event,
    { from: '2026-01-01T00:00:00.000Z', to: '2031-01-01T00:00:00.000Z' },
    { maxOccurrences: 10 },
  );
  assert.equal(result.length, 10);
  assert.equal(result[0]?.occurrenceStart, '2026-01-05T17:00:00.000Z');
  assert.equal(result[9]?.occurrenceStart, '2026-01-14T17:00:00.000Z');
});

test('the default cap is 1000 and an unbounded decade-wide query returns promptly', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1 });
  const result = expandOccurrences(event, {
    from: '2026-01-01T00:00:00.000Z',
    to: '2036-01-01T00:00:00.000Z',
  });
  assert.equal(DEFAULT_MAX_OCCURRENCES, 1000);
  assert.equal(result.length, 1000);
});

test('bad rule data is skipped, never thrown: interval < 1 degrades to a single occurrence', () => {
  const zero = makeRecurring({ freq: 'DAILY', interval: 0 });
  assert.equal(expandOccurrences(zero, WINDOW_JAN).length, 1);
  const negative = makeRecurring({ freq: 'WEEKLY', interval: -3 });
  assert.equal(expandOccurrences(negative, WINDOW_JAN).length, 1);
  const fractional = makeRecurring({ freq: 'DAILY', interval: 1.5 });
  assert.equal(expandOccurrences(fractional, WINDOW_JAN).length, 1);
  assert.equal(expandOccurrences(zero, WINDOW_JAN)[0]?.seriesId, null);
});

test('bad rule data is skipped: an unknown freq degrades to a single occurrence', () => {
  const event = makeRecurring({ freq: 'YEARLY' as RecurrenceRule['freq'], interval: 1 });
  assert.equal(expandOccurrences(event, WINDOW_JAN).length, 1);
});

test('byWeekday on a MONTHLY rule is ignored rather than poisoning the rule', () => {
  const event = makeRecurring({
    freq: 'MONTHLY',
    interval: 1,
    byWeekday: ['MO', 'FR'],
    byMonthDay: [10],
  });
  assert.deepEqual(
    startsOf(
      expandOccurrences(event, {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-04-01T00:00:00.000Z',
      }),
    ),
    ['2026-01-10T17:00:00.000Z', '2026-02-10T17:00:00.000Z', '2026-03-10T17:00:00.000Z'],
  );
});

test('byMonthDay on a WEEKLY rule is ignored, and unknown weekday codes are dropped', () => {
  const event = makeRecurring({
    freq: 'WEEKLY',
    interval: 1,
    // 'XX' is dirty data from the DB, not a valid Weekday — it must be dropped.
    byWeekday: ['MO', 'XX'] as unknown as RecurrenceRule['byWeekday'],
    byMonthDay: [17],
  });
  assert.deepEqual(startsOf(expandOccurrences(event, WINDOW_JAN)), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-12T17:00:00.000Z',
    '2026-01-19T17:00:00.000Z',
    '2026-01-26T17:00:00.000Z',
  ]);
});

test('out-of-range byMonthDay values are dropped and an emptied list falls back to the start day', () => {
  const event = makeRecurring({ freq: 'MONTHLY', interval: 1, byMonthDay: [0, 32, -1] });
  assert.deepEqual(
    startsOf(
      expandOccurrences(event, {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-04-01T00:00:00.000Z',
      }),
    ),
    ['2026-01-05T17:00:00.000Z', '2026-02-05T17:00:00.000Z', '2026-03-05T17:00:00.000Z'],
  );
});

test('a malformed until or non-positive count is ignored, not fatal', () => {
  const event = makeRecurring({
    freq: 'DAILY',
    interval: 1,
    until: 'last tuesday',
    count: 0,
    exceptions: ['not-a-date'],
  });
  const result = expandOccurrences(event, {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-09T00:00:00.000Z',
  });
  assert.deepEqual(startsOf(result), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-06T17:00:00.000Z',
    '2026-01-07T17:00:00.000Z',
    '2026-01-08T17:00:00.000Z',
  ]);
});

test('an unparseable event start is data, not a crash: it returns nothing', () => {
  const event = makeEvent({ startsAt: 'tomorrow-ish' });
  assert.deepEqual(expandOccurrences(event, WINDOW_JAN), []);
});

test('an unknown IANA timezone falls back to UTC instead of throwing', () => {
  const event = makeRecurring({ freq: 'DAILY', interval: 1, count: 2 }, { timezone: 'Mars/Olympus' });
  assert.deepEqual(startsOf(expandOccurrences(event, WINDOW_JAN)), [
    '2026-01-05T17:00:00.000Z',
    '2026-01-06T17:00:00.000Z',
  ]);
});

test('programmer errors throw: an inverted, empty or malformed window', () => {
  const event = makeEvent();
  assert.throws(
    () => expandOccurrences(event, { from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }),
    /must be strictly after/,
  );
  assert.throws(
    () => expandOccurrences(event, { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }),
    /must be strictly after/,
  );
  assert.throws(
    () => expandOccurrences(event, { from: 'nonsense', to: '2026-01-01T00:00:00.000Z' }),
    /window\.from is not a valid ISO instant/,
  );
  assert.throws(
    () => expandOccurrences(event, { from: '2026-01-01T00:00:00.000Z', to: 'nonsense' }),
    /window\.to is not a valid ISO instant/,
  );
});

test('programmer errors throw: a nonsensical maxOccurrences', () => {
  const event = makeEvent();
  assert.throws(() => expandOccurrences(event, WINDOW_JAN, { maxOccurrences: 0 }), /maxOccurrences/);
  assert.throws(() => expandOccurrences(event, WINDOW_JAN, { maxOccurrences: -5 }), /maxOccurrences/);
  assert.throws(() => expandOccurrences(event, WINDOW_JAN, { maxOccurrences: 2.5 }), /maxOccurrences/);
});

/* ------------------------------------------------------------ 11. timezone */

test('a zoned daily series keeps its local wall-clock time across a DST transition', () => {
  // 09:00 America/Chicago. US DST starts 2026-03-08, so the UTC instant shifts.
  const event = makeRecurring(
    { freq: 'DAILY', interval: 1, count: 4 },
    {
      startsAt: '2026-03-06T15:00:00.000Z',
      endsAt: '2026-03-06T16:00:00.000Z',
      timezone: 'America/Chicago',
    },
  );
  const result = expandOccurrences(event, {
    from: '2026-03-01T00:00:00.000Z',
    to: '2026-03-15T00:00:00.000Z',
  });
  assert.deepEqual(startsOf(result), [
    '2026-03-06T15:00:00.000Z', // 09:00 CST
    '2026-03-07T15:00:00.000Z', // 09:00 CST
    '2026-03-08T14:00:00.000Z', // 09:00 CDT — one hour earlier in UTC
    '2026-03-09T14:00:00.000Z', // 09:00 CDT
  ]);
  const localHours = result.map((o) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(o.occurrenceStart)),
  );
  assert.deepEqual(localHours, ['09:00', '09:00', '09:00', '09:00']);
});

test('exceptions and until are matched against the LOCAL date in the event timezone', () => {
  // The series runs at 20:00 America/Chicago, so every occurrence's UTC instant
  // lands on the FOLLOWING UTC date: local 2026-01-05 is 2026-01-06T02:00Z, local
  // 2026-01-06 is 2026-01-07T02:00Z. An exception of '2026-01-06' must therefore
  // drop the 2026-01-07T02:00Z instant; matching on the UTC date would wrongly
  // have dropped the first occurrence instead.
  const event = makeRecurring(
    { freq: 'DAILY', interval: 1, count: 3, exceptions: ['2026-01-06'] },
    {
      startsAt: '2026-01-06T02:00:00.000Z', // Mon 2026-01-05 20:00 CST
      endsAt: '2026-01-06T03:00:00.000Z',
      timezone: 'America/Chicago',
    },
  );
  const result = expandOccurrences(event, WINDOW_JAN);
  assert.deepEqual(startsOf(result), [
    '2026-01-06T02:00:00.000Z', // local 2026-01-05 — kept
    // local 2026-01-06 (2026-01-07T02:00Z) — excluded
    '2026-01-08T02:00:00.000Z', // local 2026-01-07 — kept
  ]);
});

/* --------------------------------------------------- 12. overlap helper */

test('occurrencesOverlap: touching endpoints do NOT overlap', () => {
  const a = occ('2026-01-05T15:00:00.000Z', '2026-01-05T16:00:00.000Z');
  const b = occ('2026-01-05T16:00:00.000Z', '2026-01-05T17:00:00.000Z');
  assert.equal(occurrencesOverlap(a, b), false);
  assert.equal(occurrencesOverlap(b, a), false, 'and it is symmetric');
});

test('occurrencesOverlap: genuine overlap, containment, and disjoint ranges', () => {
  const a = occ('2026-01-05T15:00:00.000Z', '2026-01-05T17:00:00.000Z');
  const partial = occ('2026-01-05T16:30:00.000Z', '2026-01-05T18:00:00.000Z');
  const contained = occ('2026-01-05T15:30:00.000Z', '2026-01-05T16:00:00.000Z');
  const disjoint = occ('2026-01-06T15:00:00.000Z', '2026-01-06T17:00:00.000Z');
  assert.equal(occurrencesOverlap(a, partial), true);
  assert.equal(occurrencesOverlap(partial, a), true);
  assert.equal(occurrencesOverlap(a, contained), true);
  assert.equal(occurrencesOverlap(contained, a), true);
  assert.equal(occurrencesOverlap(a, disjoint), false);
  assert.equal(occurrencesOverlap(a, a), true, 'an occurrence overlaps itself');
});

test('occurrencesOverlap: empty (zero-length or inverted) and unparseable ranges never overlap', () => {
  const a = occ('2026-01-05T15:00:00.000Z', '2026-01-05T17:00:00.000Z');
  const zeroLength = occ('2026-01-05T16:00:00.000Z', '2026-01-05T16:00:00.000Z');
  const inverted = occ('2026-01-05T17:00:00.000Z', '2026-01-05T15:00:00.000Z');
  const garbage = occ('not-a-date', 'also-not-a-date');
  assert.equal(occurrencesOverlap(a, zeroLength), false);
  assert.equal(occurrencesOverlap(a, inverted), false);
  assert.equal(occurrencesOverlap(a, garbage), false);
  assert.equal(occurrencesOverlap(garbage, a), false);
});

test('occurrencesOverlap composes with expandOccurrences output', () => {
  const morning = makeRecurring({ freq: 'DAILY', interval: 1, count: 2 });
  const clash = makeEvent({
    id: 'evt-dentist',
    title: 'Dentist',
    domain: 'appointments',
    startsAt: '2026-01-06T17:30:00.000Z',
    endsAt: '2026-01-06T18:30:00.000Z',
  });
  const series = expandOccurrences(morning, WINDOW_JAN);
  const single = expandOccurrences(clash, WINDOW_JAN);
  const first = series[0];
  const second = series[1];
  const dentist = single[0];
  assert.ok(first && second && dentist);
  assert.equal(occurrencesOverlap(second, dentist), true, 'Jan 6 practice clashes with the dentist');
  assert.equal(occurrencesOverlap(first, dentist), false, 'Jan 5 practice does not');
});
