/**
 * PHASE D — INTEGRATION.
 *
 * Owner: Lead Orchestrator. Four agents built four modules in parallel against
 * one frozen contract and never imported each other's code. This test is the
 * first time those modules meet. It walks the pipeline from ARCHITECTURE.md §3
 * end to end:
 *
 *   user input -> structured proposal -> schema validation -> permission
 *   validation -> conflict analysis -> confirmation -> deterministic command
 *
 * Unit tests prove each agent kept its own promise. This proves the promises
 * fit together — which is a different question, and the one that usually fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authorize, permissionOracle } from '../../domains/household/permissions.ts';
import { expandOccurrences } from '../../domains/scheduling/recurrence.ts';
import { detectConflicts, explainConflict } from '../../domains/scheduling/conflicts.ts';
import { validateAction } from '../../domains/ai/validator.ts';
import type { EventRecord, Member, Occurrence } from '../../lib/contracts/index.ts';

/* ---------------------------------------------------------- a household */

const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const OTHER_HOUSEHOLD = '22222222-2222-4222-8222-222222222222';

const MOM: Member = {
  id: 'm-mom', householdId: HOUSEHOLD, userId: 'u-mom', displayName: 'Michel',
  role: 'owner', color: 'brand.primary', active: true,
};
const TEEN: Member = {
  id: 'm-teen', householdId: HOUSEHOLD, userId: 'u-teen', displayName: 'Ana',
  role: 'teen', color: 'brand.teal', active: true,
};
const CHILD: Member = {
  id: 'm-kid', householdId: HOUSEHOLD, userId: null, displayName: 'Noor',
  role: 'child', color: 'brand.coral', active: true,
};
const SHOP_EMPLOYEE: Member = {
  id: 'm-emp', householdId: HOUSEHOLD, userId: 'u-emp', displayName: 'Riley',
  role: 'employee', color: 'brand.slate', active: true,
};

/** Soccer practice, Mon/Wed/Fri 4–5pm, all through the autumn. */
const PRACTICE: EventRecord = {
  id: 'e-practice',
  householdId: HOUSEHOLD,
  scheduleId: 's-practice',
  domain: 'practice',
  title: 'Soccer practice',
  location: 'Riverside fields',
  startsAt: '2026-09-07T21:00:00.000Z', // 4pm America/Chicago
  endsAt: '2026-09-07T22:00:00.000Z',
  allDay: false,
  timezone: 'America/Chicago',
  status: 'confirmed',
  createdBy: MOM.id,
  recurrence: { freq: 'WEEKLY', interval: 1, byWeekday: ['MO', 'WE', 'FR'], until: '2026-11-27' },
};

/** A dentist appointment dropped straight into the middle of a Wednesday practice. */
const DENTIST: EventRecord = {
  id: 'e-dentist',
  householdId: HOUSEHOLD,
  scheduleId: 's-appointments',
  domain: 'appointments',
  title: 'Dentist — Noor',
  location: 'Dr. Vance',
  startsAt: '2026-09-09T21:30:00.000Z',
  endsAt: '2026-09-09T22:30:00.000Z',
  allDay: false,
  timezone: 'America/Chicago',
  status: 'confirmed',
  createdBy: MOM.id,
};

const WEEK = { from: '2026-09-07T00:00:00.000Z', to: '2026-09-14T00:00:00.000Z' };

function familyWeek(): Occurrence[] {
  return [
    ...expandOccurrences(PRACTICE, WEEK, { participantIds: [TEEN.id, MOM.id] }),
    ...expandOccurrences(DENTIST, WEEK, { participantIds: [CHILD.id, MOM.id] }),
  ];
}

/* ------------------------------------------------------------- the walk */

test('integration: recurrence feeds the conflict engine through the frozen Occurrence shape', () => {
  const occurrences = familyWeek();

  // Mon, Wed, Fri practice + one dentist.
  assert.equal(occurrences.filter((o) => o.eventId === 'e-practice').length, 3);
  assert.equal(occurrences.filter((o) => o.eventId === 'e-dentist').length, 1);

  const conflicts = detectConflicts({
    householdId: HOUSEHOLD,
    occurrences,
    participants: [
      { eventId: 'e-practice', memberId: TEEN.id, role: 'attendee' },
      { eventId: 'e-practice', memberId: MOM.id, role: 'responsible' },
      { eventId: 'e-dentist', memberId: CHILD.id, role: 'attendee' },
      { eventId: 'e-dentist', memberId: MOM.id, role: 'responsible' },
    ],
    minorMemberIds: [CHILD.id],
  });

  // Michel cannot be responsible at the fields and the dentist at the same time.
  const wednesday = conflicts.filter((c) => c.window.startsAt.startsWith('2026-09-09'));
  assert.ok(wednesday.length > 0, 'expected a Wednesday conflict between practice and the dentist');
  assert.ok(
    wednesday.some((c) => c.memberIds.includes(MOM.id) && c.severity === 'blocking'),
    'a double-booked responsible adult must be blocking',
  );

  // The explanation is what a parent actually reads on their phone.
  const sentence = explainConflict(wednesday[0]!);
  assert.ok(sentence.length > 20, 'explanation should be a real sentence');
  assert.ok(!sentence.includes(HOUSEHOLD), 'explanations must not leak raw ids');
});

test('integration: conflict ids are stable across an independent expansion', () => {
  const input = (occ: Occurrence[]) => ({
    householdId: HOUSEHOLD,
    occurrences: occ,
    participants: [
      { eventId: 'e-practice', memberId: MOM.id, role: 'responsible' as const },
      { eventId: 'e-dentist', memberId: MOM.id, role: 'responsible' as const },
    ],
  });

  // Expand the week twice from scratch, detect twice: the ids must match.
  const first = detectConflicts(input(familyWeek()));
  const second = detectConflicts(input(familyWeek()));
  assert.deepEqual(
    first.map((c) => c.id),
    second.map((c) => c.id),
    'conflict ids must be a pure function of the schedule, not of when it was computed',
  );
});

test('integration: the AI validator runs on the real permission kernel', () => {
  // Michel asks for a new event. The oracle is the real authorization matrix,
  // not a stub — the AI layer never gets to invent its own answer.
  const verdict = validateAction(
    {
      type: 'create_event',
      confidence: 0.95,
      payload: {
        scheduleId: 's-appointments',
        title: 'Parent-teacher conference',
        startsAt: '2026-09-15T21:00:00.000Z',
        endsAt: '2026-09-15T22:00:00.000Z',
      },
    },
    {
      householdId: HOUSEHOLD,
      actorMemberId: MOM.id,
      now: '2026-09-01T12:00:00.000Z',
      can: permissionOracle(MOM, HOUSEHOLD),
    },
  );

  assert.notEqual(verdict.decision, 'reject', `owner creating an event should not be rejected: ${JSON.stringify(verdict.errors)}`);
  assert.ok(verdict.command, 'an accepted action must produce a deterministic command');
  assert.equal(verdict.command?.payload.title, 'Parent-teacher conference');
});

test('integration: a child proposing through the AI layer is refused by the permission kernel', () => {
  const verdict = validateAction(
    {
      type: 'create_event',
      confidence: 0.99,
      payload: {
        scheduleId: 's-appointments',
        title: 'Ice cream, every day, forever',
        startsAt: '2026-09-15T21:00:00.000Z',
        endsAt: '2026-09-15T22:00:00.000Z',
      },
    },
    {
      householdId: HOUSEHOLD,
      actorMemberId: CHILD.id,
      now: '2026-09-01T12:00:00.000Z',
      can: permissionOracle(CHILD, HOUSEHOLD),
    },
  );

  assert.equal(verdict.decision, 'reject');
  assert.ok(verdict.errors.some((e) => e.code === 'permission'));
});

test('integration: tenant isolation holds across both the auth kernel and the AI layer', () => {
  // Same denial, reached by two independent paths.
  const direct = authorize({ member: MOM, permission: 'event.read', householdId: OTHER_HOUSEHOLD });
  assert.equal(direct.allowed, false);
  assert.equal(direct.allowed === false ? direct.code : null, 'tenant');

  const viaAi = validateAction(
    {
      type: 'create_event',
      confidence: 0.99,
      payload: {
        householdId: OTHER_HOUSEHOLD,
        scheduleId: 's-x',
        title: 'Reach into the neighbours',
        startsAt: '2026-09-15T21:00:00.000Z',
        endsAt: '2026-09-15T22:00:00.000Z',
      },
    },
    { householdId: HOUSEHOLD, actorMemberId: MOM.id, now: '2026-09-01T12:00:00.000Z', can: permissionOracle(MOM, HOUSEHOLD) },
  );
  assert.equal(viaAi.decision, 'reject');
  assert.ok(viaAi.errors.some((e) => e.code === 'tenant'));
});

test('integration: a shop employee is walled off from the family calendar', () => {
  const readFamily = authorize({ member: SHOP_EMPLOYEE, permission: 'event.read', householdId: HOUSEHOLD });
  assert.equal(readFamily.allowed, false, 'an employee must not be able to read family appointments');

  const scheduleShift = authorize({ member: SHOP_EMPLOYEE, permission: 'employee.schedule', householdId: HOUSEHOLD });
  assert.equal(scheduleShift.allowed, true, 'but they still work here');
});

test('integration: a proposal the model is unsure about asks before it acts', () => {
  const verdict = validateAction(
    {
      type: 'cancel_event',
      confidence: 0.4,
      payload: { eventId: 'e-practice' },
    },
    { householdId: HOUSEHOLD, actorMemberId: MOM.id, now: '2026-09-01T12:00:00.000Z', can: permissionOracle(MOM, HOUSEHOLD) },
  );

  assert.notEqual(verdict.decision, 'execute', 'a low-confidence destructive action must never execute silently');
  if (verdict.decision === 'confirm') {
    assert.ok((verdict.requiresConfirmationBecause?.length ?? 0) > 0, 'the user deserves a reason for the prompt');
  }
});

test('integration: a teen may schedule, and the schedule they produce still lands in the conflict engine', () => {
  const verdict = validateAction(
    {
      type: 'create_event',
      confidence: 0.9,
      payload: {
        scheduleId: 's-practice',
        title: 'Study group',
        startsAt: '2026-09-09T21:15:00.000Z',
        endsAt: '2026-09-09T22:15:00.000Z',
      },
    },
    { householdId: HOUSEHOLD, actorMemberId: TEEN.id, now: '2026-09-01T12:00:00.000Z', can: permissionOracle(TEEN, HOUSEHOLD) },
  );
  assert.notEqual(verdict.decision, 'reject', `a teen may create events: ${JSON.stringify(verdict.errors)}`);

  // Feed the resulting command straight into the schedule as a real occurrence.
  const studyGroup: Occurrence = {
    eventId: 'e-study',
    seriesId: null,
    occurrenceStart: String(verdict.command?.payload.startsAt),
    occurrenceEnd: String(verdict.command?.payload.endsAt),
    title: String(verdict.command?.payload.title),
    domain: 'school',
    status: 'confirmed',
    participantIds: [TEEN.id],
    isOverride: false,
  };

  const conflicts = detectConflicts({
    householdId: HOUSEHOLD,
    occurrences: [...familyWeek(), studyGroup],
    participants: [
      { eventId: 'e-practice', memberId: TEEN.id, role: 'attendee' },
      { eventId: 'e-study', memberId: TEEN.id, role: 'attendee' },
    ],
  });

  assert.ok(
    conflicts.some((c) => c.memberIds.includes(TEEN.id)),
    'the study group collides with Wednesday practice and the engine should say so',
  );
});
