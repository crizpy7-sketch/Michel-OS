/**
 * Unit tests for the deterministic conflict engine (Agent G).
 * Run: node --test --experimental-strip-types "tests/unit/conflicts.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TRAVEL_GAP_MINUTES,
  detectConflicts,
  explainConflict,
  isResolved,
} from '../../domains/scheduling/conflicts.ts';
import type { Conflict, Occurrence, ParticipantRole, Shift, UUID } from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------- fixtures */

const MINUTE_IN_MS = 60_000;

const HOUSEHOLD: UUID = 'hh-michel';
const MOM: UUID = 'm-mom';
const DAD: UUID = 'm-dad';
const ANA: UUID = 'm-ana';
const LEO: UUID = 'm-leo';

const NAMES: Record<UUID, string> = {
  [MOM]: 'Mom',
  [DAD]: 'Dad',
  [ANA]: 'Ana',
  [LEO]: 'Leo',
};

function occ(
  eventId: UUID,
  title: string,
  start: string,
  end: string,
  participantIds: UUID[] = [],
  status: Occurrence['status'] = 'confirmed',
): Occurrence {
  return {
    eventId,
    seriesId: null,
    occurrenceStart: start,
    occurrenceEnd: end,
    title,
    domain: 'general',
    status,
    participantIds,
    isOverride: false,
  };
}

function part(eventId: UUID, memberId: UUID, role: ParticipantRole) {
  return { eventId, memberId, role };
}

function shift(
  id: UUID,
  employeeId: UUID | null,
  start: string,
  end: string,
  status: Shift['status'] = 'published',
  role?: string,
): Shift {
  return { id, businessId: 'biz-shia', employeeId, startsAt: start, endsAt: end, status, ...(role ? { role } : {}) };
}

type Input = Parameters<typeof detectConflicts>[0];

function run(overrides: Partial<Input> = {}): Conflict[] {
  return detectConflicts({
    householdId: HOUSEHOLD,
    occurrences: [],
    participants: [],
    memberNames: NAMES,
    ...overrides,
  });
}

function kinds(list: Conflict[]): string[] {
  return list.map((c) => c.kind);
}

/* -------------------------------------------------------------- 1. overlap */

test('overlap: same member on two intersecting occurrences yields one warning', () => {
  const found = run({
    occurrences: [
      occ('e1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e2', 'Dentist', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z'),
    ],
    participants: [part('e1', ANA, 'attendee'), part('e2', ANA, 'attendee')],
  });

  assert.equal(found.length, 1, 'exactly one conflict');
  const c = found[0];
  assert.ok(c);
  assert.equal(c.kind, 'overlap');
  assert.equal(c.severity, 'warning');
  assert.deepEqual(c.memberIds, [ANA]);
  assert.equal(c.householdId, HOUSEHOLD);
  assert.equal(c.window.startsAt, '2026-08-24T16:30:00.000Z', 'window is the intersection start');
  assert.equal(c.window.endsAt, '2026-08-24T17:00:00.000Z', 'window is the intersection end');
  assert.equal(c.occurrenceRefs.length, 2);
  assert.ok(c.explanation.includes('Ana is double-booked'), c.explanation);
  assert.ok(c.explanation.includes('Soccer practice') && c.explanation.includes('Dentist'), c.explanation);
});

test('overlap: half-open intervals — touching endpoints do NOT conflict', () => {
  const found = run({
    occurrences: [
      occ('e1', 'School', '2026-08-24T14:00:00.000Z', '2026-08-24T15:00:00.000Z'),
      occ('e2', 'Piano', '2026-08-24T15:00:00.000Z', '2026-08-24T16:00:00.000Z'),
    ],
    participants: [part('e1', ANA, 'attendee'), part('e2', ANA, 'attendee')],
    travelGapMinutes: 0, // suppress the travel signal so only overlap logic is under test
  });
  assert.deepEqual(found, [], 'back-to-back events do not overlap');
});

test('overlap: different members overlapping their own events is not a conflict', () => {
  const found = run({
    occurrences: [
      occ('e1', 'Ana ballet', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e2', 'Leo swim', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
    ],
    participants: [part('e1', ANA, 'attendee'), part('e2', LEO, 'attendee')],
  });
  assert.deepEqual(found, []);
});

test('overlap: an optional participant is not double-booked', () => {
  const found = run({
    occurrences: [
      occ('e1', 'Book club', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e2', 'Gym', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z'),
    ],
    participants: [part('e1', DAD, 'optional'), part('e2', DAD, 'attendee')],
  });
  assert.deepEqual(found, []);
});

test('overlap: cancelled occurrences are ignored entirely', () => {
  const found = run({
    occurrences: [
      occ('e1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e2', 'Dentist', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z', [], 'cancelled'),
    ],
    participants: [part('e1', ANA, 'attendee'), part('e2', ANA, 'attendee')],
  });
  assert.deepEqual(found, []);
});

test('overlap: bare participantIds on the occurrence count as attendees', () => {
  const found = run({
    occurrences: [
      occ('e1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z', [ANA]),
      occ('e2', 'Dentist', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z', [ANA]),
    ],
    participants: [],
  });
  assert.deepEqual(kinds(found), ['overlap']);
});

/* ------------------------------------------------------- 2. responsibility */

test('responsibility: a minor with nobody responsible is blocking', () => {
  const found = run({
    occurrences: [occ('e1', 'Swim meet', '2026-08-24T16:00:00.000Z', '2026-08-24T18:00:00.000Z')],
    participants: [part('e1', ANA, 'attendee')],
    minorMemberIds: [ANA],
  });

  assert.equal(found.length, 1);
  const c = found[0];
  assert.ok(c);
  assert.equal(c.kind, 'responsibility');
  assert.equal(c.severity, 'blocking');
  assert.deepEqual(c.memberIds, [ANA]);
  assert.ok(/no one is marked as responsible/i.test(c.explanation), c.explanation);
  assert.ok(c.explanation.includes('Ana'), c.explanation);
});

test('responsibility: a responsible adult on the occurrence clears the minor conflict', () => {
  const found = run({
    occurrences: [occ('e1', 'Swim meet', '2026-08-24T16:00:00.000Z', '2026-08-24T18:00:00.000Z')],
    participants: [part('e1', ANA, 'attendee'), part('e1', MOM, 'responsible')],
    minorMemberIds: [ANA],
  });
  assert.deepEqual(found, []);
});

test('responsibility: two minors unsupervised are grouped into one blocking conflict', () => {
  const found = run({
    occurrences: [occ('e1', 'Park', '2026-08-24T16:00:00.000Z', '2026-08-24T18:00:00.000Z', [ANA, LEO])],
    participants: [],
    minorMemberIds: [ANA, LEO],
  });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]?.memberIds, [ANA, LEO].sort());
  assert.ok(found[0]?.explanation.includes('Ana') && found[0]?.explanation.includes('Leo'));
});

test('responsibility: responsible adult double-booked is blocking and replaces plain overlap', () => {
  const found = run({
    occurrences: [
      occ('e1', 'Ana ballet', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e2', 'Leo swim', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z'),
    ],
    participants: [part('e1', MOM, 'responsible'), part('e2', MOM, 'responsible')],
  });

  assert.deepEqual(kinds(found), ['responsibility'], 'no duplicate overlap conflict for the same pair');
  assert.equal(found[0]?.severity, 'blocking');
  assert.ok(/two places at once/i.test(found[0]?.explanation ?? ''), found[0]?.explanation ?? '');
});

test('responsibility: responsible on one and attendee on the other is a plain overlap warning', () => {
  const found = run({
    occurrences: [
      occ('e1', 'Ana ballet', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e2', 'Dad gym', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z'),
    ],
    participants: [part('e1', DAD, 'responsible'), part('e2', DAD, 'attendee')],
  });
  assert.deepEqual(kinds(found), ['overlap']);
  assert.equal(found[0]?.severity, 'warning');
});

/* --------------------------------------------------------------- 3. work */

test('work: published shift colliding with a family event is a warning', () => {
  const found = run({
    occurrences: [occ('e1', 'Parent-teacher night', '2026-08-24T17:00:00.000Z', '2026-08-24T19:00:00.000Z')],
    participants: [part('e1', MOM, 'attendee')],
    shifts: [shift('s1', 'emp-1', '2026-08-24T16:00:00.000Z', '2026-08-24T22:00:00.000Z', 'published', 'Closer')],
    employeeMemberIds: { 'emp-1': MOM },
  });

  assert.equal(found.length, 1);
  const c = found[0];
  assert.ok(c);
  assert.equal(c.kind, 'work');
  assert.equal(c.severity, 'warning');
  assert.deepEqual(c.memberIds, [MOM]);
  assert.equal(c.window.startsAt, '2026-08-24T17:00:00.000Z');
  assert.equal(c.window.endsAt, '2026-08-24T19:00:00.000Z');
  assert.ok(c.explanation.includes('Closer'), c.explanation);
  assert.equal(c.occurrenceRefs.length, 2, 'the shift is carried as a ref alongside the occurrence');
});

test('work: a DRAFT shift collision is only info', () => {
  const found = run({
    occurrences: [occ('e1', 'Parent-teacher night', '2026-08-24T17:00:00.000Z', '2026-08-24T19:00:00.000Z')],
    participants: [part('e1', MOM, 'attendee')],
    shifts: [shift('s1', 'emp-1', '2026-08-24T16:00:00.000Z', '2026-08-24T22:00:00.000Z', 'draft')],
    employeeMemberIds: { 'emp-1': MOM },
  });
  assert.deepEqual(kinds(found), ['work']);
  assert.equal(found[0]?.severity, 'info');
  assert.ok(/pencilled in/i.test(found[0]?.explanation ?? ''), found[0]?.explanation ?? '');
});

test('work: a CANCELLED shift never conflicts', () => {
  const found = run({
    occurrences: [occ('e1', 'Parent-teacher night', '2026-08-24T17:00:00.000Z', '2026-08-24T19:00:00.000Z')],
    participants: [part('e1', MOM, 'attendee')],
    shifts: [shift('s1', 'emp-1', '2026-08-24T16:00:00.000Z', '2026-08-24T22:00:00.000Z', 'cancelled')],
    employeeMemberIds: { 'emp-1': MOM },
  });
  assert.deepEqual(found, []);
});

test('work: an unmapped employee produces no work conflict', () => {
  const found = run({
    occurrences: [occ('e1', 'Parent-teacher night', '2026-08-24T17:00:00.000Z', '2026-08-24T19:00:00.000Z')],
    participants: [part('e1', MOM, 'attendee')],
    shifts: [shift('s1', 'emp-9', '2026-08-24T16:00:00.000Z', '2026-08-24T22:00:00.000Z', 'published')],
    employeeMemberIds: {},
  });
  assert.deepEqual(found, []);
});

test('work: a shift that merely touches the event does not conflict', () => {
  const found = run({
    occurrences: [occ('e1', 'Dinner', '2026-08-24T22:00:00.000Z', '2026-08-24T23:00:00.000Z')],
    participants: [part('e1', MOM, 'attendee')],
    shifts: [shift('s1', 'emp-1', '2026-08-24T16:00:00.000Z', '2026-08-24T22:00:00.000Z', 'published')],
    employeeMemberIds: { 'emp-1': MOM },
  });
  assert.deepEqual(found, []);
});

/* ----------------------------------------------------------- 4. employee */

test('employee: two intersecting published shifts are a warning', () => {
  const found = run({
    shifts: [
      shift('s1', 'emp-1', '2026-08-24T14:00:00.000Z', '2026-08-24T18:00:00.000Z', 'published'),
      shift('s2', 'emp-1', '2026-08-24T17:00:00.000Z', '2026-08-24T21:00:00.000Z', 'published'),
    ],
    employeeMemberIds: { 'emp-1': DAD },
  });

  assert.deepEqual(kinds(found), ['employee']);
  const c = found[0];
  assert.ok(c);
  assert.equal(c.severity, 'warning');
  assert.deepEqual(c.memberIds, [DAD]);
  assert.equal(c.window.startsAt, '2026-08-24T17:00:00.000Z');
  assert.ok(c.explanation.includes('Dad'), c.explanation);
});

test('employee: a draft shift overlapping a published one is not an employee conflict', () => {
  const found = run({
    shifts: [
      shift('s1', 'emp-1', '2026-08-24T14:00:00.000Z', '2026-08-24T18:00:00.000Z', 'published'),
      shift('s2', 'emp-1', '2026-08-24T17:00:00.000Z', '2026-08-24T21:00:00.000Z', 'draft'),
    ],
    employeeMemberIds: { 'emp-1': DAD },
  });
  assert.deepEqual(found, []);
});

test('employee: different employees on overlapping shifts is normal staffing', () => {
  const found = run({
    shifts: [
      shift('s1', 'emp-1', '2026-08-24T14:00:00.000Z', '2026-08-24T18:00:00.000Z', 'published'),
      shift('s2', 'emp-2', '2026-08-24T14:00:00.000Z', '2026-08-24T18:00:00.000Z', 'published'),
    ],
    employeeMemberIds: { 'emp-1': DAD, 'emp-2': MOM },
  });
  assert.deepEqual(found, []);
});

/* ------------------------------------------------------------- 5. travel */

test('travel: a tight gap between two events is info', () => {
  const found = run({
    occurrences: [
      occ('e1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e2', 'Dentist', '2026-08-24T17:10:00.000Z', '2026-08-24T18:00:00.000Z'),
    ],
    participants: [part('e1', ANA, 'attendee'), part('e2', ANA, 'attendee')],
  });

  assert.deepEqual(kinds(found), ['travel']);
  const c = found[0];
  assert.ok(c);
  assert.equal(c.severity, 'info');
  assert.equal(c.window.startsAt, '2026-08-24T17:00:00.000Z', 'window is the gap itself');
  assert.equal(c.window.endsAt, '2026-08-24T17:10:00.000Z');
  assert.ok(c.explanation.includes('only 10 minutes'), c.explanation);
});

test('travel: a comfortable gap is silent, and the threshold is configurable', () => {
  const occurrences = [
    occ('e1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
    occ('e2', 'Dentist', '2026-08-24T17:20:00.000Z', '2026-08-24T18:00:00.000Z'),
  ];
  const participants = [part('e1', ANA, 'attendee'), part('e2', ANA, 'attendee')];

  assert.deepEqual(run({ occurrences, participants }), [], `20 min > ${DEFAULT_TRAVEL_GAP_MINUTES} min default`);
  assert.deepEqual(kinds(run({ occurrences, participants, travelGapMinutes: 30 })), ['travel']);
});

test('travel: back-to-back with zero gap is reported as no gap at all', () => {
  const found = run({
    occurrences: [
      occ('e1', 'School', '2026-08-24T14:00:00.000Z', '2026-08-24T15:00:00.000Z'),
      occ('e2', 'Piano', '2026-08-24T15:00:00.000Z', '2026-08-24T16:00:00.000Z'),
    ],
    participants: [part('e1', ANA, 'attendee'), part('e2', ANA, 'attendee')],
  });
  assert.deepEqual(kinds(found), ['travel']);
  assert.ok(/no gap at all/i.test(found[0]?.explanation ?? ''), found[0]?.explanation ?? '');
});

test('travel: overlapping events report overlap, never travel', () => {
  const found = run({
    occurrences: [
      occ('e1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e2', 'Dentist', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z'),
    ],
    participants: [part('e1', ANA, 'attendee'), part('e2', ANA, 'attendee')],
  });
  assert.deepEqual(kinds(found), ['overlap']);
});

/* -------------------------------------------------- severity matrix sweep */

test('severity matrix: every kind lands on its documented severity in one pass', () => {
  const found = run({
    occurrences: [
      // blocking: unsupervised minor
      occ('e-minor', 'Playground', '2026-08-24T12:00:00.000Z', '2026-08-24T13:00:00.000Z', [LEO]),
      // warning: plain overlap for Ana
      occ('e-a1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e-a2', 'Dentist', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z'),
      // info: travel for Ana after the dentist
      occ('e-a3', 'Choir', '2026-08-24T17:35:00.000Z', '2026-08-24T18:30:00.000Z'),
      // warning: Mom's published shift collides with her event
      occ('e-m1', 'Parent-teacher night', '2026-08-25T17:00:00.000Z', '2026-08-25T19:00:00.000Z'),
    ],
    participants: [
      part('e-a1', ANA, 'attendee'),
      part('e-a2', ANA, 'attendee'),
      part('e-a3', ANA, 'attendee'),
      part('e-m1', MOM, 'attendee'),
    ],
    minorMemberIds: [LEO],
    shifts: [
      shift('s-mom', 'emp-1', '2026-08-25T16:00:00.000Z', '2026-08-25T22:00:00.000Z', 'published'),
      shift('s-dad-1', 'emp-2', '2026-08-26T14:00:00.000Z', '2026-08-26T18:00:00.000Z', 'published'),
      shift('s-dad-2', 'emp-2', '2026-08-26T17:00:00.000Z', '2026-08-26T20:00:00.000Z', 'published'),
    ],
    employeeMemberIds: { 'emp-1': MOM, 'emp-2': DAD },
  });

  const matrix = new Map(found.map((c) => [`${c.kind}:${c.severity}`, true]));
  assert.ok(matrix.has('responsibility:blocking'), 'unsupervised minor => blocking');
  assert.ok(matrix.has('overlap:warning'), 'plain overlap => warning');
  assert.ok(matrix.has('travel:info'), 'tight travel => info');
  assert.ok(matrix.has('work:warning'), 'published shift collision => warning');
  assert.ok(matrix.has('employee:warning'), 'double shift => warning');
  assert.equal(found.length, 5, 'exactly five conflicts, one per kind');

  const starts = found.map((c) => Date.parse(c.window.startsAt));
  const ascending = [...starts].sort((a, b) => a - b);
  assert.deepEqual(starts, ascending, 'output is sorted by window start');
});

/* --------------------------------------------------------- determinism */

const DETERMINISM_INPUT = {
  householdId: HOUSEHOLD,
  memberNames: NAMES,
  minorMemberIds: [ANA, LEO],
  employeeMemberIds: { 'emp-1': MOM, 'emp-2': DAD },
  occurrences: [
    occ('e1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
    occ('e2', 'Dentist', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z'),
    occ('e3', 'Choir', '2026-08-24T17:35:00.000Z', '2026-08-24T18:30:00.000Z'),
    occ('e4', 'Playground', '2026-08-24T12:00:00.000Z', '2026-08-24T13:00:00.000Z', [LEO]),
    occ('e5', 'Parent-teacher night', '2026-08-25T17:00:00.000Z', '2026-08-25T19:00:00.000Z'),
    occ('e6', 'Leo swim', '2026-08-24T16:15:00.000Z', '2026-08-24T17:15:00.000Z'),
  ],
  participants: [
    part('e1', ANA, 'attendee'),
    part('e1', MOM, 'responsible'),
    part('e2', ANA, 'attendee'),
    part('e2', MOM, 'responsible'),
    part('e3', ANA, 'attendee'),
    part('e3', DAD, 'responsible'),
    part('e5', MOM, 'attendee'),
    part('e6', LEO, 'attendee'),
    part('e6', DAD, 'responsible'),
  ],
  shifts: [
    shift('s1', 'emp-1', '2026-08-25T16:00:00.000Z', '2026-08-25T22:00:00.000Z', 'published', 'Closer'),
    shift('s2', 'emp-2', '2026-08-26T14:00:00.000Z', '2026-08-26T18:00:00.000Z', 'published'),
    shift('s3', 'emp-2', '2026-08-26T17:00:00.000Z', '2026-08-26T20:00:00.000Z', 'published'),
    shift('s4', 'emp-2', '2026-08-26T19:00:00.000Z', '2026-08-26T23:00:00.000Z', 'cancelled'),
  ],
} satisfies Input;

/** Deterministic shuffle (seeded LCG) — no Math.random in the tests either. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

test('determinism: the same input twice yields deep-equal output', () => {
  const first = detectConflicts(DETERMINISM_INPUT);
  const second = detectConflicts(DETERMINISM_INPUT);
  assert.ok(first.length >= 5, `expected a rich conflict set, got ${first.length}`);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first), 'byte-identical serialization');
  for (const c of first) assert.match(c.id, /^[0-9a-f]{32}$/, 'ids are truncated sha256 hex');
});

test('determinism: shuffled input yields identical ids in identical order', () => {
  const baseline = detectConflicts(DETERMINISM_INPUT);

  for (const seed of [1, 7, 42, 1337, 99991]) {
    const scrambled = detectConflicts({
      ...DETERMINISM_INPUT,
      occurrences: shuffled(DETERMINISM_INPUT.occurrences, seed),
      participants: shuffled(DETERMINISM_INPUT.participants, seed + 1),
      shifts: shuffled(DETERMINISM_INPUT.shifts, seed + 2),
    });
    assert.deepEqual(scrambled.map((c) => c.id), baseline.map((c) => c.id), `ids stable for seed ${seed}`);
    assert.equal(JSON.stringify(scrambled), JSON.stringify(baseline), `full output stable for seed ${seed}`);
  }
});

test('determinism: ids are unique per conflict and stable across separate processes-worth of state', () => {
  const found = detectConflicts(DETERMINISM_INPUT);
  const ids = new Set(found.map((c) => c.id));
  assert.equal(ids.size, found.length, 'no id collisions');
  // A different household over identical scheduling facts must not reuse ids.
  const other = detectConflicts({ ...DETERMINISM_INPUT, householdId: 'hh-other' });
  assert.equal(other.length, found.length);
  for (const c of other) assert.ok(!ids.has(c.id), 'ids are scoped to the household');
});

test('determinism: duplicate participant rows do not duplicate conflicts', () => {
  const participants = [
    part('e1', ANA, 'attendee'),
    part('e1', ANA, 'attendee'),
    part('e2', ANA, 'optional'),
    part('e2', ANA, 'attendee'),
  ];
  const found = run({
    occurrences: [
      occ('e1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e2', 'Dentist', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z'),
    ],
    participants,
  });
  assert.equal(found.length, 1);
  assert.deepEqual(
    found,
    run({
      occurrences: [
        occ('e1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
        occ('e2', 'Dentist', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z'),
      ],
      participants: [...participants].reverse(),
    }),
    'strongest role wins regardless of row order',
  );
});

/* ------------------------------------------------- explain + resolution */

test('explainConflict: returns a family-readable sentence with no ids', () => {
  const found = run({
    occurrences: [
      occ('e1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e2', 'Dentist', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z'),
    ],
    participants: [part('e1', ANA, 'attendee'), part('e2', ANA, 'attendee')],
    timezone: 'America/Chicago',
  });
  const c = found[0];
  assert.ok(c);
  const text = explainConflict(c);

  assert.equal(text, c.explanation, 'unresolved conflicts read as their stored explanation');
  assert.ok(text.startsWith('Ana is double-booked'), text);
  assert.ok(text.includes('11:30'), `local time rendered in the household zone: ${text}`);
  assert.ok(text.endsWith('.'), 'it is a sentence');
  assert.ok(!text.includes(c.id) && !text.includes('e1') && !text.includes(ANA), `no ids leak: ${text}`);
  assert.ok(!/conflict|occurrence|severity|blocking/i.test(text), `no jargon: ${text}`);
});

test('explainConflict: falls back to plain language when the explanation is empty', () => {
  const bare: Conflict = {
    id: 'deadbeef',
    householdId: HOUSEHOLD,
    kind: 'employee',
    severity: 'warning',
    memberIds: [DAD],
    occurrenceRefs: [],
    window: { startsAt: '2026-08-24T16:00:00.000Z', endsAt: '2026-08-24T17:00:00.000Z' },
    explanation: '   ',
  };
  assert.equal(explainConflict(bare), 'Someone is scheduled for two shifts at once.');
});

test('isResolved / explainConflict: resolution metadata is respected', () => {
  const base = run({
    occurrences: [
      occ('e1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e2', 'Dentist', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z'),
    ],
    participants: [part('e1', ANA, 'attendee'), part('e2', ANA, 'attendee')],
  })[0];
  assert.ok(base);

  assert.equal(isResolved(base), false, 'freshly detected conflicts are unresolved');

  const resolved: Conflict = {
    ...base,
    resolution: { resolvedBy: MOM, resolvedAt: '2026-08-24T15:00:00.000Z', note: 'Moved the dentist to Friday' },
  };
  assert.equal(isResolved(resolved), true);
  assert.ok(explainConflict(resolved).includes('Already sorted out: Moved the dentist to Friday'));

  const noteless: Conflict = { ...base, resolution: { resolvedBy: MOM, resolvedAt: '2026-08-24T15:00:00.000Z' } };
  assert.equal(isResolved(noteless), true);
  assert.ok(explainConflict(noteless).endsWith('This one is already sorted out.'));

  const bogus: Conflict = { ...base, resolution: { resolvedBy: '', resolvedAt: '' } };
  assert.equal(isResolved(bogus), false, 'empty resolution metadata does not count');
});

/* ---------------------------------------------------------- robustness */

test('robustness: empty input yields an empty array', () => {
  assert.deepEqual(run(), []);
  assert.deepEqual(detectConflicts({ householdId: HOUSEHOLD, occurrences: [], participants: [] }), []);
});

test('robustness: unparseable or zero-length occurrences are skipped, not thrown on', () => {
  const found = run({
    occurrences: [
      occ('bad', 'Broken', 'not-a-date', 'also-not-a-date'),
      occ('zero', 'Zero length', '2026-08-24T16:00:00.000Z', '2026-08-24T16:00:00.000Z'),
      occ('e1', 'Soccer practice', '2026-08-24T15:30:00.000Z', '2026-08-24T16:30:00.000Z'),
    ],
    participants: [part('bad', ANA, 'attendee'), part('zero', ANA, 'attendee'), part('e1', ANA, 'attendee')],
  });
  assert.deepEqual(found, [], 'a zero-length instant cannot overlap anything');
});

test('robustness: names are optional and no id ever leaks into an explanation', () => {
  const found = detectConflicts({
    householdId: HOUSEHOLD,
    occurrences: [
      occ('e1', 'Soccer practice', '2026-08-24T16:00:00.000Z', '2026-08-24T17:00:00.000Z'),
      occ('e2', 'Dentist', '2026-08-24T16:30:00.000Z', '2026-08-24T17:30:00.000Z'),
    ],
    participants: [part('e1', ANA, 'attendee'), part('e2', ANA, 'attendee')],
  });
  assert.equal(found.length, 1);
  const text = found[0]?.explanation ?? '';
  assert.ok(text.startsWith('A family member is double-booked'), text);
  assert.ok(!text.includes(ANA), text);
});

test('performance: 4000 occurrences across 8 members stay well under a naive O(n^2) scan', () => {
  const members = [MOM, DAD, ANA, LEO, 'm-5', 'm-6', 'm-7', 'm-8'];
  const occurrences: Occurrence[] = [];
  const participants: Array<{ eventId: UUID; memberId: UUID; role: ParticipantRole }> = [];
  const dayStart = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < 4000; i += 1) {
    const memberId = members[i % members.length] ?? MOM;
    const start = dayStart + i * 60 * MINUTE_IN_MS;
    const id = `perf-${i}`;
    occurrences.push(
      occ(id, `Event ${i}`, new Date(start).toISOString(), new Date(start + 30 * MINUTE_IN_MS).toISOString()),
    );
    participants.push(part(id, memberId, 'attendee'));
  }
  const started = process.hrtime.bigint();
  const found = detectConflicts({ householdId: HOUSEHOLD, occurrences, participants, memberNames: NAMES });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(found, [], 'staggered, well-spaced events produce nothing');
  assert.ok(elapsedMs < 2000, `sweep took ${elapsedMs.toFixed(1)}ms`);
});

