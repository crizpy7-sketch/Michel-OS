/**
 * Unit tests for Shia Baby employee scheduling (Agent J1, domains/shia-baby/staffing.ts).
 *
 * PRODUCT_SPEC §4 names seven warnings. Each has a test that produces it and a
 * test that proves it stays quiet when it should — a warning that always fires
 * is as useless as one that never does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_COVERAGE,
  acceptSwap,
  analyzeSchedule,
  approveSwap,
  assignShift,
  publishSchedule,
  reviewTimeOff,
  type StaffingWarningCode,
} from '../../domains/shia-baby/staffing.ts';
import type {
  Availability,
  Employee,
  Member,
  Role,
  Shift,
  ShiftSwap,
  TimeOffRequest,
  UUID,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------- fixtures */

const HOUSEHOLD: UUID = 'hh-michel';
const BUSINESS: UUID = 'biz-shia-baby';
const OTHER_BUSINESS: UUID = 'biz-somebody-else';

const MARIA: UUID = 'emp-maria';
const JON: UUID = 'emp-jon';

function member(id: UUID, role: Role, householdId: UUID = HOUSEHOLD): Member {
  return { id, householdId, userId: null, displayName: id, role, color: 'slate', active: true };
}

const owner = member('m-owner', 'owner');
const adult = member('m-adult', 'adult');
const viewer = member('m-viewer', 'viewer');

function employee(id: UUID, displayName: string, patch: Partial<Employee> = {}): Employee {
  return { id, businessId: BUSINESS, memberId: null, displayName, hourlyRate: 18, active: true, ...patch };
}

const maria = employee(MARIA, 'Maria');
const jon = employee(JON, 'Jon');

function shift(id: UUID, employeeId: UUID | null, startsAt: string, endsAt: string, patch: Partial<Shift> = {}): Shift {
  return { id, businessId: BUSINESS, employeeId, startsAt, endsAt, status: 'draft', ...patch };
}

/** A full trading day: 08:00–18:00 UTC on 2026-08-24 (a Monday). */
const OPEN = '2026-08-24T08:00:00.000Z';
const CLOSE = '2026-08-24T18:00:00.000Z';
const WEEK = { from: '2026-08-24T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' };

function codes(warnings: ReadonlyArray<{ code: StaffingWarningCode }>): StaffingWarningCode[] {
  return warnings.map((w) => w.code);
}

function value<T>(result: { ok: true; value: T } | { ok: false; issues: unknown[] }): T {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return (result as { ok: true; value: T }).value;
}

function issues(result: { ok: boolean; issues?: unknown[] }): Array<{ code: string; path: string; message: string }> {
  assert.equal(result.ok, false, 'expected a rejection');
  return (result as { issues: Array<{ code: string; path: string; message: string }> }).issues;
}

/** A schedule with nothing wrong with it, for the "stays quiet" half of each pair. */
function cleanDay(): Parameters<typeof analyzeSchedule>[0] {
  return {
    businessId: BUSINESS,
    employees: [maria, jon],
    shifts: [
      shift('s-open', MARIA, OPEN, '2026-08-24T13:00:00.000Z'),
      shift('s-close', JON, '2026-08-24T13:00:00.000Z', CLOSE),
    ],
    window: WEEK,
  };
}

/* ------------------------------------------------------------ assignment */

test('assignShift: an owner can assign an active employee to a draft shift', () => {
  const result = value(
    assignShift({
      shift: shift('s1', null, OPEN, CLOSE),
      employee: maria,
      actor: owner,
      householdId: HOUSEHOLD,
      businessId: BUSINESS,
    }),
  );
  assert.equal(result.shift.employeeId, MARIA);
  assert.deepEqual(result.warnings, []);
});

test('assignShift: an adult holds no employee.schedule (CR-003 ruling) and is refused', () => {
  const rejected = assignShift({
    shift: shift('s1', null, OPEN, CLOSE),
    employee: maria,
    actor: adult,
    householdId: HOUSEHOLD,
    businessId: BUSINESS,
  });
  assert.deepEqual(issues(rejected).map((i) => i.code), ['permission']);
  assert.equal(
    assignShift({
      shift: shift('s1', null, OPEN, CLOSE),
      employee: maria,
      actor: viewer,
      householdId: HOUSEHOLD,
      businessId: BUSINESS,
    }).ok,
    false,
  );
});

test('assignShift: a shift or employee from another business is refused as a tenant violation', () => {
  const foreignShift = assignShift({
    shift: shift('s1', null, OPEN, CLOSE, { businessId: OTHER_BUSINESS }),
    employee: maria,
    actor: owner,
    householdId: HOUSEHOLD,
    businessId: BUSINESS,
  });
  assert.deepEqual(issues(foreignShift).map((i) => i.code), ['tenant']);

  const foreignEmployee = assignShift({
    shift: shift('s1', null, OPEN, CLOSE),
    employee: employee('emp-x', 'Someone', { businessId: OTHER_BUSINESS }),
    actor: owner,
    householdId: HOUSEHOLD,
    businessId: BUSINESS,
  });
  assert.deepEqual(issues(foreignEmployee).map((i) => i.code), ['tenant']);
});

test('assignShift: an inactive employee and an inverted shift are both reported at once', () => {
  const rejected = assignShift({
    shift: shift('s1', null, CLOSE, OPEN),
    employee: employee('emp-gone', 'Former', { active: false }),
    actor: owner,
    householdId: HOUSEHOLD,
    businessId: BUSINESS,
  });
  assert.deepEqual(issues(rejected).map((i) => i.path).sort(), ['employee.active', 'shift.endsAt']);
});

test('assignShift: an existing overlapping shift blocks the assignment, a handover does not', () => {
  const existing = [shift('s-a', MARIA, OPEN, '2026-08-24T13:00:00.000Z', { status: 'published' })];

  const clash = assignShift({
    shift: shift('s-b', null, '2026-08-24T12:00:00.000Z', CLOSE),
    employee: maria,
    actor: owner,
    householdId: HOUSEHOLD,
    businessId: BUSINESS,
    existingShifts: existing,
  });
  assert.match(issues(clash)[0]!.message, /already scheduled/);

  const handover = assignShift({
    shift: shift('s-b', null, '2026-08-24T13:00:00.000Z', CLOSE),
    employee: maria,
    actor: owner,
    householdId: HOUSEHOLD,
    businessId: BUSINESS,
    existingShifts: existing,
  });
  assert.equal(handover.ok, true, 'back-to-back is a handover, not a double booking');
});

test('assignShift: approved time off blocks; a merely requested absence does not', () => {
  const request = (status: TimeOffRequest['status']): TimeOffRequest => ({
    id: 'to-1',
    businessId: BUSINESS,
    employeeId: MARIA,
    startsAt: '2026-08-24T00:00:00.000Z',
    endsAt: '2026-08-25T00:00:00.000Z',
    status,
  });

  const blocked = assignShift({
    shift: shift('s1', null, OPEN, CLOSE),
    employee: maria,
    actor: owner,
    householdId: HOUSEHOLD,
    businessId: BUSINESS,
    timeOff: [request('approved')],
  });
  assert.match(issues(blocked)[0]!.message, /approved time off/);

  assert.equal(
    assignShift({
      shift: shift('s1', null, OPEN, CLOSE),
      employee: maria,
      actor: owner,
      householdId: HOUSEHOLD,
      businessId: BUSINESS,
      timeOff: [request('requested')],
    }).ok,
    true,
    'an unreviewed request must not silently block scheduling',
  );
});

test('assignShift: working outside declared availability warns but still assigns', () => {
  const availability: Availability[] = [
    { id: 'av-1', businessId: BUSINESS, employeeId: MARIA, weekday: 'MO', startMinute: 540, endMinute: 720, available: true },
  ];
  const result = value(
    assignShift({
      shift: shift('s1', null, OPEN, CLOSE), // 08:00, before the 09:00 window opens
      employee: maria,
      actor: owner,
      householdId: HOUSEHOLD,
      businessId: BUSINESS,
      availability,
    }),
  );
  assert.equal(result.shift.employeeId, MARIA, 'shops do ask people to come in early');
  assert.deepEqual(codes(result.warnings), ['unavailable_employee']);
});

test('assignShift: an explicit "not available" window beats an overlapping positive one', () => {
  const availability: Availability[] = [
    { id: 'av-1', businessId: BUSINESS, employeeId: MARIA, weekday: 'MO', startMinute: 0, endMinute: 1440, available: true },
    { id: 'av-2', businessId: BUSINESS, employeeId: MARIA, weekday: 'MO', startMinute: 600, endMinute: 720, available: false },
  ];
  const result = value(
    assignShift({
      shift: shift('s1', null, OPEN, CLOSE),
      employee: maria,
      actor: owner,
      householdId: HOUSEHOLD,
      businessId: BUSINESS,
      availability,
    }),
  );
  assert.deepEqual(codes(result.warnings), ['unavailable_employee']);
});

/* -------------------------------------------------------- time off / swaps */

test('reviewTimeOff: an owner approves; a second review is refused', () => {
  const request: TimeOffRequest = {
    id: 'to-1',
    businessId: BUSINESS,
    employeeId: MARIA,
    startsAt: '2026-08-24T00:00:00.000Z',
    endsAt: '2026-08-25T00:00:00.000Z',
    status: 'requested',
  };
  const approved = value(reviewTimeOff(request, 'approved', owner, HOUSEHOLD));
  assert.equal(approved.status, 'approved');
  assert.equal(approved.reviewedBy, owner.id);

  assert.equal(reviewTimeOff(approved, 'denied', owner, HOUSEHOLD).ok, false, 'no quiet reversal');
  assert.equal(reviewTimeOff(request, 'approved', adult, HOUSEHOLD).ok, false, 'adult has no business.manage');
});

test('swaps: request, accept and approve are three separate acts', () => {
  const swap: ShiftSwap = {
    id: 'sw-1',
    businessId: BUSINESS,
    shiftId: 's-sat',
    fromEmployeeId: MARIA,
    toEmployeeId: null,
    status: 'requested',
  };
  const saturday = shift('s-sat', MARIA, OPEN, CLOSE, { status: 'published' });

  // A manager cannot approve a swap nobody has taken.
  assert.equal(approveSwap(swap, saturday, owner, HOUSEHOLD).ok, false);

  const accepted = value(acceptSwap(swap, JON));
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.toEmployeeId, JON);

  const approved = value(approveSwap(accepted, saturday, owner, HOUSEHOLD));
  assert.equal(approved.swap.status, 'approved');
  assert.equal(approved.shift.employeeId, JON, 'the shift actually moves');
});

test('swaps: a shift cannot be swapped back to the person giving it up, or approved for the wrong shift', () => {
  const swap: ShiftSwap = {
    id: 'sw-1',
    businessId: BUSINESS,
    shiftId: 's-sat',
    fromEmployeeId: MARIA,
    toEmployeeId: null,
    status: 'requested',
  };
  assert.equal(acceptSwap(swap, MARIA).ok, false);

  const accepted = value(acceptSwap(swap, JON));
  const wrongShift = approveSwap(accepted, shift('s-sun', MARIA, OPEN, CLOSE), owner, HOUSEHOLD);
  assert.deepEqual(issues(wrongShift).map((i) => i.path), ['shift.id']);
});

/* --------------------------------------------------------------- analysis */

test('analyzeSchedule: a well-covered day produces no warnings at all', () => {
  const analysis = analyzeSchedule(cleanDay());
  assert.deepEqual(analysis.warnings, [], JSON.stringify(analysis.warnings));
  assert.deepEqual(analysis.daysWithoutOpener, []);
  assert.deepEqual(analysis.daysWithoutCloser, []);
  assert.equal(analysis.hoursByEmployee[MARIA], 5);
  assert.equal(analysis.hoursByEmployee[JON], 5);
});

test('analyzeSchedule: a late start means no opener, an early finish means no closer', () => {
  const noOpener = analyzeSchedule({
    ...cleanDay(),
    shifts: [shift('s1', MARIA, '2026-08-24T10:00:00.000Z', CLOSE)],
  });
  assert.ok(codes(noOpener.warnings).includes('no_opener'));
  assert.deepEqual(noOpener.daysWithoutOpener, ['2026-08-24']);

  const noCloser = analyzeSchedule({
    ...cleanDay(),
    shifts: [shift('s1', MARIA, OPEN, '2026-08-24T15:00:00.000Z')],
  });
  assert.ok(codes(noCloser.warnings).includes('no_closer'));
});

test('analyzeSchedule: an overnight shift closes the day it started on', () => {
  const analysis = analyzeSchedule({
    ...cleanDay(),
    shifts: [shift('s1', MARIA, OPEN, '2026-08-25T02:00:00.000Z')],
  });
  assert.equal(codes(analysis.warnings).includes('no_closer'), false, 'the shift runs past midnight');
});

test('analyzeSchedule: overlapping shifts for one person are a blocking double booking', () => {
  const analysis = analyzeSchedule({
    ...cleanDay(),
    shifts: [
      shift('s1', MARIA, OPEN, '2026-08-24T14:00:00.000Z'),
      shift('s2', MARIA, '2026-08-24T13:00:00.000Z', CLOSE),
    ],
  });
  const doubled = analysis.warnings.find((w) => w.code === 'double_booked');
  assert.ok(doubled);
  assert.equal(doubled.severity, 'blocking');
  assert.deepEqual(doubled.shiftIds, ['s1', 's2']);
  assert.match(doubled.message, /Maria/, 'the manager reads names, not ids');
});

test('analyzeSchedule: two different people overlapping is coverage, not a double booking', () => {
  const analysis = analyzeSchedule({
    ...cleanDay(),
    shifts: [
      shift('s1', MARIA, OPEN, '2026-08-24T14:00:00.000Z'),
      shift('s2', JON, '2026-08-24T13:00:00.000Z', CLOSE),
    ],
  });
  assert.equal(codes(analysis.warnings).includes('double_booked'), false);
});

test('analyzeSchedule: a gap in the trading day is inadequate coverage', () => {
  const analysis = analyzeSchedule({
    ...cleanDay(),
    shifts: [
      shift('s1', MARIA, OPEN, '2026-08-24T12:00:00.000Z'),
      shift('s2', JON, '2026-08-24T14:00:00.000Z', CLOSE),
    ],
  });
  const thin = analysis.warnings.find((w) => w.code === 'inadequate_coverage');
  assert.ok(thin, 'the shop is empty between 12:00 and 14:00');
  assert.match(thin.message, /12:00 PM/);
});

test('analyzeSchedule: a raised floor minimum turns a single-cover day into a warning', () => {
  const single = { ...cleanDay(), coverage: { minimumOnFloor: 2 } };
  assert.ok(codes(analyzeSchedule(single).warnings).includes('inadequate_coverage'));
  assert.equal(
    codes(analyzeSchedule(cleanDay()).warnings).includes('inadequate_coverage'),
    false,
    `the default minimum is ${DEFAULT_COVERAGE.minimumOnFloor}`,
  );
});

test('analyzeSchedule: hours past the weekly limit warn, and the count is per employee', () => {
  const days = ['24', '25', '26', '27', '28', '29'].map((d, i) =>
    shift(`s${i}`, MARIA, `2026-08-${d}T08:00:00.000Z`, `2026-08-${d}T16:00:00.000Z`),
  );
  const analysis = analyzeSchedule({ ...cleanDay(), shifts: days });
  assert.equal(analysis.hoursByEmployee[MARIA], 48);
  const excessive = analysis.warnings.find((w) => w.code === 'excessive_hours');
  assert.ok(excessive);
  assert.match(excessive.message, /48 hours/);
  assert.equal(analysis.hoursByEmployee[JON], undefined, 'Jon is not charged for Maria’s week');
});

test('analyzeSchedule: hours are clipped to the window under review', () => {
  const straddling = shift('s1', MARIA, '2026-08-23T20:00:00.000Z', '2026-08-24T04:00:00.000Z');
  const analysis = analyzeSchedule({ ...cleanDay(), shifts: [straddling] });
  assert.equal(analysis.hoursByEmployee[MARIA], 4, 'only the hours inside the week count');
});

test('analyzeSchedule: an unassigned shift is blocking, and approved time off collides', () => {
  const analysis = analyzeSchedule({
    ...cleanDay(),
    shifts: [shift('s-open', null, OPEN, '2026-08-24T13:00:00.000Z'), shift('s-close', MARIA, '2026-08-24T13:00:00.000Z', CLOSE)],
    timeOff: [
      {
        id: 'to-1',
        businessId: BUSINESS,
        employeeId: MARIA,
        startsAt: '2026-08-24T00:00:00.000Z',
        endsAt: '2026-08-25T00:00:00.000Z',
        status: 'approved',
      },
    ],
  });
  assert.ok(codes(analysis.warnings).includes('unassigned_shift'));
  assert.ok(codes(analysis.warnings).includes('time_off_collision'));
});

test('analyzeSchedule: a family obligation handed in by the conflict engine is reported', () => {
  const analysis = analyzeSchedule({
    ...cleanDay(),
    familyObligations: [
      {
        employeeId: MARIA,
        startsAt: '2026-08-24T09:00:00.000Z',
        endsAt: '2026-08-24T10:00:00.000Z',
        title: 'Ana’s dentist',
      },
    ],
  });
  const family = analysis.warnings.find((w) => w.code === 'family_conflict');
  assert.ok(family);
  assert.match(family.message, /Ana’s dentist/);
});

test('analyzeSchedule: cancelled and swapped shifts occupy nobody’s time', () => {
  const analysis = analyzeSchedule({
    ...cleanDay(),
    shifts: [
      ...cleanDay().shifts,
      shift('s-dead', MARIA, OPEN, CLOSE, { status: 'cancelled' }),
      shift('s-moved', MARIA, OPEN, CLOSE, { status: 'swapped' }),
    ],
  });
  assert.equal(codes(analysis.warnings).includes('double_booked'), false);
  assert.equal(analysis.hoursByEmployee[MARIA], 5, 'an inert shift is not paid time');
});

test('analyzeSchedule: another business’s shifts are ignored entirely', () => {
  const analysis = analyzeSchedule({
    ...cleanDay(),
    shifts: [...cleanDay().shifts, shift('s-foreign', MARIA, OPEN, CLOSE, { businessId: OTHER_BUSINESS })],
  });
  assert.deepEqual(analysis.warnings, [], 'a competitor’s roster cannot create warnings here');
});

test('analyzeSchedule: the warning list is identical however the roster is ordered', () => {
  const input = {
    ...cleanDay(),
    shifts: [
      shift('s1', MARIA, OPEN, '2026-08-24T14:00:00.000Z'),
      shift('s2', MARIA, '2026-08-24T13:00:00.000Z', CLOSE),
      shift('s3', null, '2026-08-25T09:00:00.000Z', '2026-08-25T17:00:00.000Z'),
    ],
  };
  const forward = analyzeSchedule(input);
  const backward = analyzeSchedule({ ...input, shifts: [...input.shifts].reverse() });
  assert.deepEqual(forward.warnings, backward.warnings);
  assert.deepEqual(forward.hoursByEmployee, backward.hoursByEmployee);
});

/* ------------------------------------------------------------ publishing */

test('publishSchedule: a clean week publishes every draft shift', () => {
  const result = value(publishSchedule({ ...cleanDay(), actor: owner, householdId: HOUSEHOLD }));
  assert.deepEqual(result.shifts.map((s) => s.status), ['published', 'published']);
  assert.deepEqual(result.warnings, []);
});

test('publishSchedule: a blocking gap refuses to publish and says why', () => {
  const rejected = publishSchedule({
    ...cleanDay(),
    shifts: [shift('s1', null, OPEN, CLOSE)],
    actor: owner,
    householdId: HOUSEHOLD,
  });
  const paths = issues(rejected).map((i) => i.path);
  assert.ok(paths.includes('schedule.unassigned_shift'), JSON.stringify(paths));
});

test('publishSchedule: force publishes anyway but still hands back every warning', () => {
  const result = value(
    publishSchedule({
      ...cleanDay(),
      shifts: [shift('s1', null, OPEN, CLOSE)],
      actor: owner,
      householdId: HOUSEHOLD,
      force: true,
    }),
  );
  assert.ok(codes(result.warnings).includes('unassigned_shift'), 'an override must not swallow the warning');
});

test('publishSchedule: a thin-but-runnable week publishes with the warning attached', () => {
  const result = value(
    publishSchedule({ ...cleanDay(), coverage: { minimumOnFloor: 2 }, actor: owner, householdId: HOUSEHOLD }),
  );
  assert.equal(result.shifts.length, 2, 'a manager may knowingly run a thin day');
  assert.ok(codes(result.warnings).includes('inadequate_coverage'));
});

test('publishSchedule: a viewer cannot publish, and neither can a member of another household', () => {
  assert.equal(publishSchedule({ ...cleanDay(), actor: viewer, householdId: HOUSEHOLD }).ok, false);
  const intruder = member('m-intruder', 'owner', 'hh-elsewhere');
  const rejected = publishSchedule({ ...cleanDay(), actor: intruder, householdId: HOUSEHOLD });
  assert.deepEqual(issues(rejected).map((i) => i.code), ['tenant']);
});
