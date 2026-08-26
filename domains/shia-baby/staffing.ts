/**
 * Michel-OS — Shia Baby employee scheduling (Agent J1).
 *
 * PRODUCT_SPEC §4 lists seven warnings a published schedule must never hide:
 * an unavailable employee, a double booking, no opener, no closer, inadequate
 * coverage, excessive hours, and a collision with a family obligation.
 * `analyzeSchedule` produces all seven from one pass over the roster.
 *
 * Two boundaries this module holds and does not negotiate:
 *
 *   1. It warns; it does not refuse. A manager may knowingly publish a thin
 *      Saturday. Silently rewriting the schedule to make a warning go away
 *      would be the "silently disable failing features" failure that
 *      SWARM_ORCHESTRATION.md §3 forbids — so `publishSchedule` reports every
 *      warning and blocks only on the ones that mean the day cannot run.
 *   2. Business scope is not household scope. `Business.id` is a distinct UUID
 *      from `Household.id` (CR-008), so every function takes the business and
 *      checks that each row it was handed actually belongs to it. A row from
 *      another shop is dropped, never scheduled.
 *
 * Pure: no clock, no ids minted here. Coverage questions are asked about an
 * explicit window the caller supplies.
 */

import { authorize } from '../household/permissions.ts';
import {
  err,
  ok,
  WEEKDAYS,
  type Availability,
  type Employee,
  type Instant,
  type Member,
  type Result,
  type Shift,
  type ShiftSwap,
  type TimeOffRequest,
  type UUID,
  type ValidationIssue,
  type Weekday,
} from '../../lib/contracts/index.ts';

/* ---------------------------------------------------------------- helpers */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Shift states that occupy nobody's time and collide with nothing. */
const INERT: ReadonlyArray<Shift['status']> = ['cancelled', 'swapped'];

function issue(path: string, message: string, code: ValidationIssue['code']): ValidationIssue {
  return { path, message, code };
}

function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Local wall-clock fields for an instant in a named zone. */
function zoned(ms: number, timezone: string): { weekday: Weekday; minuteOfDay: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const short = get('weekday').toUpperCase().slice(0, 2) as Weekday;
  const weekday = WEEKDAYS.includes(short) ? short : 'MO';
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));

  return {
    weekday,
    minuteOfDay: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  // Half-open: a shift that ends exactly when the next begins is a handover,
  // not a double booking.
  return aStart < bEnd && bStart < aEnd;
}

/* --------------------------------------------------------------- warnings */

export const STAFFING_WARNING_CODES = [
  'unavailable_employee',
  'double_booked',
  'no_opener',
  'no_closer',
  'inadequate_coverage',
  'excessive_hours',
  'family_conflict',
  'unassigned_shift',
  'time_off_collision',
] as const;
export type StaffingWarningCode = (typeof STAFFING_WARNING_CODES)[number];

export interface StaffingWarning {
  code: StaffingWarningCode;
  /** `blocking` means the day cannot run as scheduled; `warning` means a human should look. */
  severity: 'warning' | 'blocking';
  employeeIds: UUID[];
  shiftIds: UUID[];
  /** Plain language, for the manager, with no ids in it. */
  message: string;
}

/**
 * Opening and closing are defined by the business day, not by a shift's label:
 * a manager who forgets to type "opening" into the role field has still
 * scheduled an opener. A shift opens the day if it starts at or before the
 * opening minute, and closes it if it ends at or after the closing minute.
 */
export interface CoverageRule {
  /** Local minutes from midnight, in the business timezone. */
  opensAtMinute: number;
  closesAtMinute: number;
  /** Fewest people who must be on the floor at any moment the shop is open. */
  minimumOnFloor: number;
  /** Hours per employee per week beyond which the schedule is flagged. */
  maxWeeklyHours: number;
}

export const DEFAULT_COVERAGE: CoverageRule = Object.freeze({
  opensAtMinute: 8 * 60,
  closesAtMinute: 18 * 60,
  minimumOnFloor: 1,
  maxWeeklyHours: 40,
});

/* ------------------------------------------------------------- assignment */

export interface AssignShiftInput {
  shift: Shift;
  employee: Employee;
  actor: Member;
  /** The household the actor belongs to, for the tenancy check. */
  householdId: UUID;
  businessId: UUID;
  /** Everything already on the books for this employee — used for the double-booking check. */
  existingShifts?: readonly Shift[];
  availability?: readonly Availability[];
  timeOff?: readonly TimeOffRequest[];
  /** Business timezone, for reading availability windows. Defaults to UTC. */
  timezone?: string;
}

/**
 * Assign an employee to a shift.
 *
 * Rejects only for things that make the assignment invalid — wrong business,
 * missing permission, an inactive employee, an inverted time range, an approved
 * absence, or the same person already on the floor. Availability is a
 * preference, so working outside it is returned as a warning on an accepted
 * assignment rather than a refusal: shops ask people to come in early.
 */
export interface AssignedShift {
  shift: Shift;
  warnings: StaffingWarning[];
}

export function assignShift(input: AssignShiftInput): Result<AssignedShift> {
  const { shift, employee, actor, businessId } = input;
  const timezone = input.timezone ?? 'UTC';

  const verdict = authorize({
    member: actor,
    householdId: input.householdId,
    permission: 'employee.schedule',
    resource: { householdId: input.householdId },
  });
  if (!verdict.allowed) {
    return err([issue('actor', verdict.reason, verdict.code === 'tenant' ? 'tenant' : 'permission')]);
  }

  const issues: ValidationIssue[] = [];

  // CR-008: business scope is established by the caller; this module's job is to
  // refuse anything that does not match what it was told.
  if (shift.businessId !== businessId) {
    issues.push(issue('shift.businessId', 'This shift belongs to another business.', 'tenant'));
  }
  if (employee.businessId !== businessId) {
    issues.push(issue('employee.businessId', 'This employee works for another business.', 'tenant'));
  }
  if (employee.active !== true) {
    issues.push(issue('employee.active', 'This employee is no longer active.', 'logic'));
  }
  if (INERT.includes(shift.status)) {
    issues.push(issue('shift.status', `A ${shift.status} shift cannot be assigned.`, 'logic'));
  }

  const start = parseInstant(shift.startsAt);
  const end = parseInstant(shift.endsAt);
  if (start === null || end === null) {
    issues.push(issue('shift', 'A shift needs a valid start and end instant.', 'format'));
  } else if (end <= start) {
    issues.push(issue('shift.endsAt', 'A shift must end after it starts.', 'logic'));
  }

  if (issues.length > 0) return err(issues);

  /* -- hard collisions: approved time off, and being in two places at once -- */

  for (const request of input.timeOff ?? []) {
    if (request.employeeId !== employee.id || request.status !== 'approved') continue;
    const offStart = parseInstant(request.startsAt);
    const offEnd = parseInstant(request.endsAt);
    if (offStart === null || offEnd === null) continue;
    if (overlaps(start!, end!, offStart, offEnd)) {
      return err([
        issue(
          'shift',
          `${employee.displayName} has approved time off covering this shift.`,
          'logic',
        ),
      ]);
    }
  }

  for (const other of input.existingShifts ?? []) {
    if (other.id === shift.id || other.employeeId !== employee.id) continue;
    if (INERT.includes(other.status)) continue;
    const otherStart = parseInstant(other.startsAt);
    const otherEnd = parseInstant(other.endsAt);
    if (otherStart === null || otherEnd === null) continue;
    if (overlaps(start!, end!, otherStart, otherEnd)) {
      return err([
        issue('shift', `${employee.displayName} is already scheduled during this shift.`, 'logic'),
      ]);
    }
  }

  /* -- soft: availability is a preference, not a rule ---------------------- */

  const warnings: StaffingWarning[] = [];
  const availability = (input.availability ?? []).filter((a) => a.employeeId === employee.id);
  if (availability.length > 0 && !isWithinAvailability(start!, end!, availability, timezone)) {
    warnings.push({
      code: 'unavailable_employee',
      severity: 'warning',
      employeeIds: [employee.id],
      shiftIds: [shift.id],
      message: `${employee.displayName} has not said they are available at this time.`,
    });
  }

  return ok({ shift: { ...shift, employeeId: employee.id }, warnings });
}

/**
 * Does a declared availability set cover the whole shift?
 *
 * Evaluated per local day so an overnight shift is judged against both days it
 * touches. An explicit `available: false` window always wins over an
 * overlapping positive one — saying "not Thursdays" has to mean something even
 * when a broad "weekdays" window also exists.
 */
function isWithinAvailability(
  startMs: number,
  endMs: number,
  windows: readonly Availability[],
  timezone: string,
): boolean {
  // Walk the shift in 15-minute probes: cheap, and it cannot be fooled by a
  // gap in the middle the way checking only the endpoints can.
  const step = 15 * MINUTE_MS;
  for (let at = startMs; at < endMs; at += step) {
    const { weekday, minuteOfDay } = zoned(at, timezone);
    const applicable = windows.filter(
      (w) => w.weekday === weekday && minuteOfDay >= w.startMinute && minuteOfDay < w.endMinute,
    );
    if (applicable.length === 0) return false;
    if (applicable.some((w) => w.available === false)) return false;
  }
  return true;
}

/* ------------------------------------------------------------- time off */

export function reviewTimeOff(
  request: TimeOffRequest,
  decision: 'approved' | 'denied',
  actor: Member,
  householdId: UUID,
): Result<TimeOffRequest> {
  const verdict = authorize({
    member: actor,
    householdId,
    permission: 'business.manage',
    resource: { householdId },
  });
  if (!verdict.allowed) {
    return err([issue('actor', verdict.reason, verdict.code === 'tenant' ? 'tenant' : 'permission')]);
  }
  if (request.status !== 'requested') {
    return err([
      issue('status', `This request was already ${request.status} and cannot be reviewed again.`, 'logic'),
    ]);
  }
  return ok({ ...request, status: decision, reviewedBy: actor.id });
}

/**
 * A swap moves a shift from one employee to another.
 *
 * `requested -> accepted -> approved` is three separate acts by three different
 * people: the employee giving the shift up, the colleague taking it, and the
 * manager signing off. Collapsing them would let one employee hand a Saturday
 * to somebody who never agreed to work it.
 */
export function acceptSwap(swap: ShiftSwap, toEmployeeId: UUID): Result<ShiftSwap> {
  if (swap.status !== 'requested') {
    return err([issue('status', `A ${swap.status} swap cannot be accepted.`, 'logic')]);
  }
  if (toEmployeeId === swap.fromEmployeeId) {
    return err([issue('toEmployeeId', 'A shift cannot be swapped with the person giving it up.', 'logic')]);
  }
  return ok({ ...swap, status: 'accepted', toEmployeeId });
}

export interface ApprovedSwap {
  swap: ShiftSwap;
  /** The shift, reassigned. Persist both or neither. */
  shift: Shift;
}

export function approveSwap(
  swap: ShiftSwap,
  shift: Shift,
  actor: Member,
  householdId: UUID,
): Result<ApprovedSwap> {
  const verdict = authorize({
    member: actor,
    householdId,
    permission: 'employee.schedule',
    resource: { householdId },
  });
  if (!verdict.allowed) {
    return err([issue('actor', verdict.reason, verdict.code === 'tenant' ? 'tenant' : 'permission')]);
  }
  if (swap.status !== 'accepted') {
    return err([issue('status', 'Only a swap a colleague has accepted can be approved.', 'logic')]);
  }
  if (swap.toEmployeeId === null) {
    return err([issue('toEmployeeId', 'An accepted swap must name who is taking the shift.', 'logic')]);
  }
  if (shift.id !== swap.shiftId) {
    return err([issue('shift.id', 'This swap is for a different shift.', 'logic')]);
  }

  return ok({
    swap: { ...swap, status: 'approved', reviewedBy: actor.id },
    shift: { ...shift, employeeId: swap.toEmployeeId },
  });
}

/* -------------------------------------------------------------- analysis */

export interface AnalyzeScheduleInput {
  businessId: UUID;
  shifts: readonly Shift[];
  employees: readonly Employee[];
  availability?: readonly Availability[];
  timeOff?: readonly TimeOffRequest[];
  /** The window under review: typically one published week. */
  window: { from: Instant; to: Instant };
  coverage?: Partial<CoverageRule>;
  timezone?: string;
  /**
   * Family obligations that a shift would collide with, expressed as the
   * employee whose family it is. The conflict engine owns detecting these; this
   * module only reports the ones it is handed, so the two never disagree.
   */
  familyObligations?: ReadonlyArray<{ employeeId: UUID; startsAt: Instant; endsAt: Instant; title: string }>;
}

export interface ScheduleAnalysis {
  warnings: StaffingWarning[];
  /** employeeId -> scheduled hours inside the window. */
  hoursByEmployee: Record<UUID, number>;
  /** Local dates in the window that have a shift but no opener / no closer. */
  daysWithoutOpener: string[];
  daysWithoutCloser: string[];
}

/**
 * Every §4 warning, produced deterministically from one roster.
 *
 * Warnings come back sorted by code then by the ids involved, so the same
 * schedule always renders the same list — a manager who sees the order shuffle
 * between two loads stops trusting the list.
 */
export function analyzeSchedule(input: AnalyzeScheduleInput): ScheduleAnalysis {
  const timezone = input.timezone ?? 'UTC';
  const rule: CoverageRule = { ...DEFAULT_COVERAGE, ...(input.coverage ?? {}) };
  const windowFrom = parseInstant(input.window.from) ?? Number.NEGATIVE_INFINITY;
  const windowTo = parseInstant(input.window.to) ?? Number.POSITIVE_INFINITY;

  const employeeById = new Map<UUID, Employee>(
    input.employees.filter((e) => e.businessId === input.businessId).map((e) => [e.id, e]),
  );
  const nameOf = (employeeId: UUID | null): string =>
    (employeeId !== null ? employeeById.get(employeeId)?.displayName : undefined) ?? 'An employee';

  interface Span {
    shift: Shift;
    start: number;
    end: number;
  }

  const spans: Span[] = [];
  for (const shift of input.shifts) {
    if (shift.businessId !== input.businessId) continue; // another shop's row
    if (INERT.includes(shift.status)) continue;
    const start = parseInstant(shift.startsAt);
    const end = parseInstant(shift.endsAt);
    if (start === null || end === null || end <= start) continue;
    if (end <= windowFrom || start >= windowTo) continue;
    spans.push({ shift, start, end });
  }
  spans.sort((a, b) =>
    a.start !== b.start ? a.start - b.start : a.shift.id < b.shift.id ? -1 : a.shift.id > b.shift.id ? 1 : 0,
  );

  const warnings: StaffingWarning[] = [];
  const hoursByEmployee: Record<UUID, number> = {};

  /* -- unassigned, hours, availability, time off -------------------------- */

  for (const span of spans) {
    const employeeId = span.shift.employeeId;
    if (employeeId === null) {
      warnings.push({
        code: 'unassigned_shift',
        severity: 'blocking',
        employeeIds: [],
        shiftIds: [span.shift.id],
        message: `A ${span.shift.role ?? 'shift'} on ${zoned(span.start, timezone).date} has nobody assigned to it.`,
      });
      continue;
    }

    const clipped = Math.min(span.end, windowTo) - Math.max(span.start, windowFrom);
    hoursByEmployee[employeeId] = (hoursByEmployee[employeeId] ?? 0) + clipped / HOUR_MS;

    const windows = (input.availability ?? []).filter((a) => a.employeeId === employeeId);
    if (windows.length > 0 && !isWithinAvailability(span.start, span.end, windows, timezone)) {
      warnings.push({
        code: 'unavailable_employee',
        severity: 'warning',
        employeeIds: [employeeId],
        shiftIds: [span.shift.id],
        message: `${nameOf(employeeId)} is scheduled outside the hours they said they are available.`,
      });
    }

    for (const request of input.timeOff ?? []) {
      if (request.employeeId !== employeeId || request.status !== 'approved') continue;
      const offStart = parseInstant(request.startsAt);
      const offEnd = parseInstant(request.endsAt);
      if (offStart === null || offEnd === null) continue;
      if (overlaps(span.start, span.end, offStart, offEnd)) {
        warnings.push({
          code: 'time_off_collision',
          severity: 'blocking',
          employeeIds: [employeeId],
          shiftIds: [span.shift.id],
          message: `${nameOf(employeeId)} has approved time off during this shift.`,
        });
      }
    }
  }

  /* -- double booking ------------------------------------------------------ */

  const byEmployee = new Map<UUID, Span[]>();
  for (const span of spans) {
    const employeeId = span.shift.employeeId;
    if (employeeId === null) continue;
    const bucket = byEmployee.get(employeeId);
    if (bucket) bucket.push(span);
    else byEmployee.set(employeeId, [span]);
  }

  for (const [employeeId, list] of byEmployee) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        if (b.start >= a.end) break; // sorted by start, so nothing later can overlap either
        if (overlaps(a.start, a.end, b.start, b.end)) {
          warnings.push({
            code: 'double_booked',
            severity: 'blocking',
            employeeIds: [employeeId],
            shiftIds: [a.shift.id, b.shift.id].sort(),
            message: `${nameOf(employeeId)} is scheduled for two shifts that overlap.`,
          });
        }
      }
    }

    const hours = hoursByEmployee[employeeId] ?? 0;
    if (hours > rule.maxWeeklyHours) {
      warnings.push({
        code: 'excessive_hours',
        severity: 'warning',
        employeeIds: [employeeId],
        shiftIds: list.map((s) => s.shift.id).sort(),
        message:
          `${nameOf(employeeId)} is scheduled for ${round1(hours)} hours, ` +
          `over the ${rule.maxWeeklyHours}-hour limit.`,
      });
    }
  }

  /* -- opener / closer / floor coverage, per local day --------------------- */

  const days = new Map<string, Span[]>();
  for (const span of spans) {
    const date = zoned(span.start, timezone).date;
    const bucket = days.get(date);
    if (bucket) bucket.push(span);
    else days.set(date, [span]);
  }

  const daysWithoutOpener: string[] = [];
  const daysWithoutCloser: string[] = [];

  for (const date of [...days.keys()].sort()) {
    const dayShifts = days.get(date)!;

    const hasOpener = dayShifts.some((s) => zoned(s.start, timezone).minuteOfDay <= rule.opensAtMinute);
    const hasCloser = dayShifts.some((s) => {
      const localEnd = zoned(s.end, timezone);
      // An end that has rolled past midnight closes the previous day.
      return localEnd.date !== date || localEnd.minuteOfDay >= rule.closesAtMinute;
    });

    if (!hasOpener) {
      daysWithoutOpener.push(date);
      warnings.push({
        code: 'no_opener',
        severity: 'blocking',
        employeeIds: [],
        shiftIds: dayShifts.map((s) => s.shift.id).sort(),
        message: `Nobody is scheduled to open on ${date}.`,
      });
    }
    if (!hasCloser) {
      daysWithoutCloser.push(date);
      warnings.push({
        code: 'no_closer',
        severity: 'blocking',
        employeeIds: [],
        shiftIds: dayShifts.map((s) => s.shift.id).sort(),
        message: `Nobody is scheduled to close on ${date}.`,
      });
    }

    const thin = thinnestCoverage(dayShifts.map((s) => ({ start: s.start, end: s.end })), date, rule, timezone);
    if (thin !== null && thin.onFloor < rule.minimumOnFloor) {
      warnings.push({
        code: 'inadequate_coverage',
        severity: 'warning',
        employeeIds: [],
        shiftIds: dayShifts.map((s) => s.shift.id).sort(),
        message:
          `On ${date} the shop drops to ${thin.onFloor} on the floor ` +
          `around ${formatMinute(thin.atMinute)}, below the minimum of ${rule.minimumOnFloor}.`,
      });
    }
  }

  /* -- family obligations -------------------------------------------------- */

  for (const obligation of input.familyObligations ?? []) {
    const start = parseInstant(obligation.startsAt);
    const end = parseInstant(obligation.endsAt);
    if (start === null || end === null) continue;
    for (const span of byEmployee.get(obligation.employeeId) ?? []) {
      if (!overlaps(span.start, span.end, start, end)) continue;
      warnings.push({
        code: 'family_conflict',
        severity: 'warning',
        employeeIds: [obligation.employeeId],
        shiftIds: [span.shift.id],
        message: `${nameOf(obligation.employeeId)} has a family commitment (${obligation.title}) during this shift.`,
      });
    }
  }

  warnings.sort(compareWarnings);
  return { warnings, hoursByEmployee, daysWithoutOpener, daysWithoutCloser };
}

/**
 * The thinnest moment of a trading day, by sweeping the shift boundaries.
 *
 * Only boundaries can change the headcount, so checking them is exact — and it
 * costs O(n log n) rather than the O(minutes) a naive minute-by-minute scan
 * would burn on every render.
 */
function thinnestCoverage(
  spans: ReadonlyArray<{ start: number; end: number }>,
  date: string,
  rule: CoverageRule,
  timezone: string,
): { onFloor: number; atMinute: number } | null {
  if (spans.length === 0) return null;

  const openMs = spans.reduce((min, s) => Math.min(min, s.start), Number.POSITIVE_INFINITY);
  const dayStart = openMs - zoned(openMs, timezone).minuteOfDay * MINUTE_MS;
  const from = dayStart + rule.opensAtMinute * MINUTE_MS;
  const to = dayStart + rule.closesAtMinute * MINUTE_MS;
  if (to <= from) return null;

  const marks = new Set<number>([from]);
  for (const span of spans) {
    if (span.start > from && span.start < to) marks.add(span.start);
    if (span.end > from && span.end < to) marks.add(span.end);
  }

  let worst: { onFloor: number; atMinute: number } | null = null;
  for (const at of [...marks].sort((a, b) => a - b)) {
    const onFloor = spans.filter((s) => s.start <= at && s.end > at).length;
    if (worst === null || onFloor < worst.onFloor) {
      worst = { onFloor, atMinute: zoned(at, timezone).minuteOfDay };
    }
  }
  // A day whose shifts all fall outside trading hours still has a thin moment.
  void date;
  return worst;
}

function compareWarnings(a: StaffingWarning, b: StaffingWarning): number {
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  const aKey = `${a.employeeIds.join(',')}|${a.shiftIds.join(',')}|${a.message}`;
  const bKey = `${b.employeeIds.join(',')}|${b.shiftIds.join(',')}|${b.message}`;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatMinute(minuteOfDay: number): string {
  const hour24 = Math.floor(minuteOfDay / 60) % 24;
  const minute = minuteOfDay % 60;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/* ------------------------------------------------------------ publishing */

export interface PublishResult {
  shifts: Shift[];
  warnings: StaffingWarning[];
}

/**
 * Publish a draft week.
 *
 * Blocking warnings stop the publish — an unassigned shift or a day with no
 * opener is not a schedule, it is a gap. Non-blocking warnings ride along on
 * success: the manager is told, and the manager decides. `force` exists for the
 * deliberate override, and it still returns every warning rather than
 * swallowing them.
 */
export function publishSchedule(
  input: AnalyzeScheduleInput & { actor: Member; householdId: UUID; force?: boolean },
): Result<PublishResult> {
  const verdict = authorize({
    member: input.actor,
    householdId: input.householdId,
    permission: 'employee.schedule',
    resource: { householdId: input.householdId },
  });
  if (!verdict.allowed) {
    return err([issue('actor', verdict.reason, verdict.code === 'tenant' ? 'tenant' : 'permission')]);
  }

  const analysis = analyzeSchedule(input);
  const blocking = analysis.warnings.filter((w) => w.severity === 'blocking');

  if (blocking.length > 0 && input.force !== true) {
    return err(
      blocking.map((w) => issue(`schedule.${w.code}`, w.message, 'logic')),
    );
  }

  const published = input.shifts
    .filter((s) => s.businessId === input.businessId && s.status === 'draft')
    .map((s): Shift => ({ ...s, status: 'published' }));

  return ok({ shifts: published, warnings: analysis.warnings });
}
