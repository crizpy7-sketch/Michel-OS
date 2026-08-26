/**
 * Unit tests for the Morning Brief (Agent H, domains/ai/brief.ts).
 *
 * The brief is an assembler, so the tests check what it selects, what it caps,
 * what it refuses to show, and that it never leaks another household's row onto
 * the most-read screen in the product.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BRIEF_LIMITS, buildMorningBrief, summarizeBrief } from '../../domains/ai/brief.ts';
import type {
  Conflict,
  Errand,
  Occurrence,
  Reminder,
  ShoppingItem,
  UUID,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------- fixtures */

const H1: UUID = 'hh-michel';
const H2: UUID = 'hh-other';
const ZONE = 'America/Chicago';

/** Monday 2026-08-24, 07:30 local (12:30 UTC). */
const NOW = '2026-08-24T12:30:00.000Z';

function occ(patch: Partial<Occurrence> & Pick<Occurrence, 'eventId' | 'occurrenceStart'>): Occurrence {
  return {
    seriesId: null,
    occurrenceEnd: patch.occurrenceStart,
    title: patch.eventId,
    domain: 'general',
    status: 'confirmed',
    participantIds: [],
    isOverride: false,
    ...patch,
  };
}

function conflict(patch: Partial<Conflict> & Pick<Conflict, 'id'>): Conflict {
  return {
    householdId: H1,
    kind: 'overlap',
    severity: 'warning',
    memberIds: [],
    occurrenceRefs: [],
    window: { startsAt: NOW, endsAt: NOW },
    explanation: 'Something overlaps.',
    ...patch,
  };
}

function reminder(patch: Partial<Reminder> & Pick<Reminder, 'id'>): Reminder {
  return {
    householdId: H1,
    title: patch.id,
    dueAt: '2026-08-24T14:00:00.000Z',
    status: 'pending',
    ...patch,
  };
}

function errand(patch: Partial<Errand> & Pick<Errand, 'id'>): Errand {
  return { householdId: H1, title: patch.id, status: 'open', ...patch };
}

function shopping(patch: Partial<ShoppingItem> & Pick<ShoppingItem, 'id'>): ShoppingItem {
  return {
    householdId: H1,
    listName: 'Household',
    name: patch.id,
    quantity: 1,
    status: 'needed',
    ...patch,
  };
}

const base = { householdId: H1, now: NOW, timezone: ZONE };

/* --------------------------------------------------------- day selection */

test('today and tomorrow are split by the household’s local calendar', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [
      occ({ eventId: 'today-early', occurrenceStart: '2026-08-24T13:00:00.000Z' }),   // 08:00 local Mon
      occ({ eventId: 'today-late', occurrenceStart: '2026-08-25T02:00:00.000Z' }),    // 21:00 local Mon
      occ({ eventId: 'tomorrow', occurrenceStart: '2026-08-25T14:00:00.000Z' }),      // 09:00 local Tue
      occ({ eventId: 'thursday', occurrenceStart: '2026-08-27T14:00:00.000Z' }),
    ],
  });
  assert.equal(brief.date, '2026-08-24');
  assert.deepEqual(brief.today.map((o) => o.eventId), ['today-early', 'today-late']);
  assert.deepEqual(brief.tomorrow.map((o) => o.eventId), ['tomorrow']);
});

test('an event already finished this morning still appears — the brief is the whole day', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [occ({ eventId: 'school-run', occurrenceStart: '2026-08-24T12:00:00.000Z' })],
  });
  assert.deepEqual(brief.today.map((o) => o.eventId), ['school-run']);
});

test('cancelled occurrences never reach the brief', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [
      occ({ eventId: 'off', occurrenceStart: '2026-08-24T13:00:00.000Z', status: 'cancelled' }),
      occ({ eventId: 'on', occurrenceStart: '2026-08-24T13:00:00.000Z' }),
    ],
  });
  assert.deepEqual(brief.today.map((o) => o.eventId), ['on']);
});

test('occurrences come back in time order however they arrived', () => {
  const list = [
    occ({ eventId: 'c', occurrenceStart: '2026-08-24T20:00:00.000Z' }),
    occ({ eventId: 'a', occurrenceStart: '2026-08-24T13:00:00.000Z' }),
    occ({ eventId: 'b', occurrenceStart: '2026-08-24T16:00:00.000Z' }),
  ];
  const forward = buildMorningBrief({ ...base, occurrences: list });
  const backward = buildMorningBrief({ ...base, occurrences: [...list].reverse() });
  assert.deepEqual(forward.today.map((o) => o.eventId), ['a', 'b', 'c']);
  assert.deepEqual(forward, backward);
});

/* --------------------------------------------------------------- triage */

test('conflicts lead with the blocking ones, and info conflicts are not shown at all', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [],
    conflicts: [
      conflict({ id: 'c-info', severity: 'info' }),
      conflict({ id: 'c-warn', severity: 'warning' }),
      conflict({ id: 'c-block', severity: 'blocking' }),
    ],
  });
  assert.deepEqual(brief.conflicts.map((c) => c.id), ['c-block', 'c-warn']);
});

test('a resolved conflict is finished business and is left out', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [],
    conflicts: [
      conflict({ id: 'c-done', resolution: { resolvedBy: 'm-mom', resolvedAt: NOW } }),
      conflict({ id: 'c-open' }),
    ],
  });
  assert.deepEqual(brief.conflicts.map((c) => c.id), ['c-open']);
});

test('reminders show what is overdue or due today, not next week', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [],
    reminders: [
      reminder({ id: 'overdue', dueAt: '2026-08-20T14:00:00.000Z' }),
      reminder({ id: 'today', dueAt: '2026-08-25T02:00:00.000Z' }), // 21:00 local today
      reminder({ id: 'next-week', dueAt: '2026-08-31T14:00:00.000Z' }),
      reminder({ id: 'done', dueAt: '2026-08-20T14:00:00.000Z', status: 'completed' }),
    ],
  });
  assert.deepEqual(brief.reminders.map((r) => r.id), ['overdue', 'today']);
});

test('a snoozed reminder is judged by its snooze, so snoozing actually silences it', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [],
    reminders: [
      reminder({ id: 'snoozed-away', dueAt: '2026-08-20T14:00:00.000Z', status: 'snoozed', snoozedUntil: '2026-09-01T14:00:00.000Z' }),
      reminder({ id: 'snoozed-back', dueAt: '2026-08-20T14:00:00.000Z', status: 'snoozed', snoozedUntil: '2026-08-24T13:00:00.000Z' }),
    ],
  });
  assert.deepEqual(brief.reminders.map((r) => r.id), ['snoozed-back']);
});

test('errands show the open ones, dated first and undated after', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [],
    errands: [
      errand({ id: 'someday' }),
      errand({ id: 'later', dueAt: '2026-08-26T14:00:00.000Z' }),
      errand({ id: 'soon', dueAt: '2026-08-24T18:00:00.000Z' }),
      errand({ id: 'finished', status: 'done' }),
    ],
  });
  assert.deepEqual(brief.errands.map((e) => e.id), ['soon', 'later', 'someday']);
});

test('the shopping count counts only what is still needed', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [],
    shoppingItems: [
      shopping({ id: 'a' }),
      shopping({ id: 'b' }),
      shopping({ id: 'c', status: 'purchased' }),
      shopping({ id: 'd', status: 'removed' }),
    ],
  });
  assert.equal(brief.shoppingCount, 2);
});

test('staffing warnings are passed through verbatim, never recomputed', () => {
  const warnings = ['Nobody is scheduled to close on 2026-08-24.'];
  const brief = buildMorningBrief({ ...base, occurrences: [], staffingWarnings: warnings });
  assert.deepEqual(brief.staffingWarnings, warnings);
});

/* -------------------------------------------------------------- headline */

test('the headline is the next game or competition inside the horizon', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [
      occ({ eventId: 'dentist', occurrenceStart: '2026-08-24T15:00:00.000Z', domain: 'appointments' }),
      occ({ eventId: 'game', occurrenceStart: '2026-08-29T21:00:00.000Z', domain: 'games', title: 'Valley Cats vs Ravens' }),
      occ({ eventId: 'meet', occurrenceStart: '2026-09-20T21:00:00.000Z', domain: 'competition' }),
    ],
  });
  assert.equal(brief.headline?.title, 'Valley Cats vs Ravens');
  assert.equal(brief.headline?.domain, 'games');
});

test('nothing important coming up means no headline key at all', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [occ({ eventId: 'dentist', occurrenceStart: '2026-08-24T15:00:00.000Z', domain: 'appointments' })],
  });
  assert.equal(Object.hasOwn(brief, 'headline'), false, 'an undefined key breaks deep equality');
});

test('a game in the past is not the headline', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [occ({ eventId: 'last-week', occurrenceStart: '2026-08-15T21:00:00.000Z', domain: 'games' })],
  });
  assert.equal(brief.headline, undefined);
});

/* ------------------------------------------------------- tenancy + bounds */

test('another household’s rows never reach the brief', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [],
    conflicts: [conflict({ id: 'c-foreign', householdId: H2, severity: 'blocking' })],
    reminders: [reminder({ id: 'r-foreign', householdId: H2 })],
    errands: [errand({ id: 'e-foreign', householdId: H2 })],
    shoppingItems: [shopping({ id: 's-foreign', householdId: H2 })],
  });
  assert.deepEqual(brief.conflicts, []);
  assert.deepEqual(brief.reminders, []);
  assert.deepEqual(brief.errands, []);
  assert.equal(brief.shoppingCount, 0);
});

test('every list is capped, and the cap is configurable', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    occ({ eventId: `e${String(i).padStart(2, '0')}`, occurrenceStart: `2026-08-24T${String(12 + (i % 10)).padStart(2, '0')}:00:00.000Z` }),
  );
  const brief = buildMorningBrief({ ...base, occurrences: many });
  assert.equal(brief.today.length, BRIEF_LIMITS.today);

  const tighter = buildMorningBrief({ ...base, occurrences: many, limits: { today: 3 } });
  assert.equal(tighter.today.length, 3);
  assert.deepEqual(tighter.today, brief.today.slice(0, 3), 'a tighter cap is a prefix, not a resample');
});

/* -------------------------------------------------------------- greeting */

test('the greeting follows the reader’s local hour', () => {
  const morning = buildMorningBrief({ ...base, occurrences: [], memberName: 'Elena' });
  assert.equal(morning.greeting, 'Good morning, Elena.');

  const evening = buildMorningBrief({ ...base, now: '2026-08-25T02:00:00.000Z', occurrences: [] });
  assert.equal(evening.greeting, 'Good evening.', '21:00 local is not the morning');
});

test('an unusable now yields an empty brief rather than a wrong one', () => {
  const brief = buildMorningBrief({ ...base, now: 'this morning', occurrences: [occ({ eventId: 'e', occurrenceStart: NOW })] });
  assert.equal(brief.date, '');
  assert.deepEqual(brief.today, []);
  assert.equal(brief.greeting, 'Hello.');
});

/* ------------------------------------------------------------- summarize */

test('summarizeBrief reads as a sentence and says the quiet case plainly', () => {
  const empty = buildMorningBrief({ ...base, occurrences: [] });
  assert.equal(summarizeBrief(empty), 'Nothing scheduled today.');

  const busy = buildMorningBrief({
    ...base,
    occurrences: [occ({ eventId: 'a', occurrenceStart: '2026-08-24T13:00:00.000Z' })],
    conflicts: [conflict({ id: 'c', severity: 'blocking' })],
    shoppingItems: [shopping({ id: 's' })],
  });
  assert.equal(summarizeBrief(busy), '1 event today, 1 conflict to sort out and 1 thing to buy.');
});

test('summarizeBrief pluralises and does not restate the headline', () => {
  const brief = buildMorningBrief({
    ...base,
    occurrences: [
      occ({ eventId: 'a', occurrenceStart: '2026-08-24T13:00:00.000Z' }),
      occ({ eventId: 'b', occurrenceStart: '2026-08-24T16:00:00.000Z' }),
      occ({ eventId: 'game', occurrenceStart: '2026-08-29T21:00:00.000Z', domain: 'games', title: 'Valley Cats vs Ravens' }),
    ],
  });
  assert.equal(summarizeBrief(brief), '2 events today.');
  assert.equal(brief.headline?.title, 'Valley Cats vs Ravens', 'the headline is on the screen, not in the notification');
});
