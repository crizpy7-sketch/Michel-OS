/**
 * Michel-OS — universal recurrence engine (ARCHITECTURE.md §7).
 *
 * Owner: Core Scheduling Agent (Agent F).
 * Consumers: conflict engine, calendar views, reminder scheduler, AI validator.
 *
 * The whole module is PURE and DETERMINISTIC: no I/O, no clock reads, no
 * randomness, no mutation of its inputs. The same arguments always produce a
 * deeply-equal result array. (The only module-level state is a memoisation
 * cache of `Intl.DateTimeFormat` instances, which cannot change any result.)
 *
 * ---------------------------------------------------------------------------
 * ERROR POLICY — two distinct classes, deliberately handled differently
 * ---------------------------------------------------------------------------
 * 1. BAD DATA (rows that came out of Postgres) NEVER throws. A malformed
 *    recurrence rule, an unparseable instant, an unknown IANA zone, a nonsense
 *    `byWeekday` on a MONTHLY rule — all of these are skipped/ignored and the
 *    engine returns the safest useful result it can. A scheduling UI must not
 *    500 because one row is dirty.
 * 2. PROGRAMMER ERRORS throw a plain `Error` with a descriptive message:
 *      - a missing/unparseable `window.from` / `window.to`
 *      - `window.to <= window.from` (an empty or inverted query window)
 *      - `options.maxOccurrences` that is not an integer >= 1
 *    These can only come from a caller bug, never from stored data.
 *
 * ---------------------------------------------------------------------------
 * TIME / DST MODEL — read this before touching the date math
 * ---------------------------------------------------------------------------
 * Occurrences repeat at the same LOCAL WALL-CLOCK TIME in `event.timezone`
 * (the RFC-5545 `DTSTART;TZID=` model). All arithmetic walks local calendar
 * fields and then converts back to a UTC instant, resolving that date's real
 * UTC offset via `Intl.DateTimeFormat`. So a 09:00 America/Chicago event stays
 * at 09:00 local across a DST transition even though its UTC instant moves by
 * an hour. Honest simplifications:
 *   - DURATION is preserved as an ABSOLUTE millisecond span taken from the base
 *     event (`endsAt - startsAt`), not as a local wall-clock span. An occurrence
 *     that straddles a DST transition therefore ends one hour earlier/later in
 *     local terms than the base event did.
 *   - NON-EXISTENT local times (the spring-forward gap, e.g. 02:30 on a US
 *     spring transition day) resolve forward into the post-transition offset.
 *   - AMBIGUOUS local times (the fall-back hour, which happens twice) resolve
 *     deterministically to one of the two valid instants — consistently the
 *     same one for the same input, but the engine does not let a caller pick.
 *   - An unknown / malformed `timezone` falls back to UTC rather than throwing.
 *
 * ---------------------------------------------------------------------------
 * MONTHLY OVERFLOW — SKIP, NEVER CLAMP
 * ---------------------------------------------------------------------------
 * A `byMonthDay` (or an inherited start day-of-month) that does not exist in a
 * given month is SKIPPED for that month. Day 31 in February produces nothing;
 * it is NOT clamped to the 28th/29th and NOT rolled into March 3rd. Clamping
 * silently invents a family commitment on a day nobody chose, and rolling over
 * corrupts the month grid; skipping is the only option that can never surprise
 * a parent looking at the calendar. Same rule for day 31 in 30-day months and
 * day 30 in February. This matches RFC 5545 (invalid BYMONTHDAY dates are
 * ignored) and Google Calendar's "monthly on day 31" behaviour.
 */

import { WEEKDAYS } from '../../lib/contracts/index.ts';
import type {
  CalendarDate,
  EventRecord,
  Frequency,
  Instant,
  Occurrence,
  ExpansionResult,
  RecurrenceRule,
  TimeZone,
  UUID,
  Weekday,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------------ limits */

/** Default ceiling on how many occurrences a single call may return. */
export const DEFAULT_MAX_OCCURRENCES = 1000;

/**
 * Absolute ceiling on candidate dates examined per call. `count` must be
 * counted from the series start (never from the query window), so expansion
 * always begins at `event.startsAt`; this guard is what makes an unbounded
 * rule (no `until`, no `count`) over a century-wide window terminate in
 * milliseconds instead of hanging the request. ~274 years of daily candidates.
 */
export const MAX_EXPANSION_STEPS = 100_000;

/* --------------------------------------------------------- local date types */

interface LocalDate {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
}

interface LocalDateTime extends LocalDate {
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

/* ------------------------------------------------------- timezone plumbing */

/** Memoised formatters. Pure cache — never changes a result, only its cost. */
const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

function getZoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    // Unknown IANA zone in the row — degrade to UTC, do not throw (bad data).
    formatter = null;
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** Build a UTC instant from calendar fields, overflow-normalising (day 32 -> next month). */
function utcFromFields(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number {
  const date = new Date(0);
  // setUTCFullYear (rather than Date.UTC) so years 0..99 are not mapped to 19xx.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime();
}

/** UTC offset (ms) in effect in `timeZone` at `instantMs`. 0 for unknown zones. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const formatter = getZoneFormatter(timeZone);
  if (formatter === null) return 0;
  const parts = formatter.formatToParts(new Date(instantMs));
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    const value = Number(part.value);
    if (Number.isNaN(value)) continue;
    if (part.type === 'year') year = value;
    else if (part.type === 'month') month = value;
    else if (part.type === 'day') day = value;
    else if (part.type === 'hour') hour = value === 24 ? 0 : value;
    else if (part.type === 'minute') minute = value;
    else if (part.type === 'second') second = value;
  }
  const asIfUtc = utcFromFields(year, month, day, hour, minute, second, 0);
  // Formatted parts are second-resolution, so compare against a floored instant.
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Instant -> wall-clock fields in `timeZone`. */
function toZonedFields(instantMs: number, timeZone: string): LocalDateTime {
  const shifted = new Date(instantMs + zoneOffsetMs(instantMs, timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    ms: shifted.getUTCMilliseconds(),
  };
}

/**
 * Wall-clock fields in `timeZone` -> instant. Two-pass offset resolution: guess
 * with the offset at the naive instant, then re-resolve with the offset that
 * actually applies. See the DST notes in the module header for gap/ambiguity.
 */
function fromZonedFields(fields: LocalDateTime, timeZone: string): number {
  const asIfUtc = utcFromFields(
    fields.year,
    fields.month,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
    fields.ms,
  );
  const firstOffset = zoneOffsetMs(asIfUtc, timeZone);
  const guess = asIfUtc - firstOffset;
  const secondOffset = zoneOffsetMs(guess, timeZone);
  return secondOffset === firstOffset ? guess : asIfUtc - secondOffset;
}

/* ------------------------------------------------------ calendar utilities */

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(utcFromFields(date.year, date.month, date.day + days, 0, 0, 0, 0));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** 0 = Sunday .. 6 = Saturday — same ordering as the frozen `WEEKDAYS` tuple. */
function dayOfWeek(date: LocalDate): number {
  return new Date(utcFromFields(date.year, date.month, date.day, 0, 0, 0, 0)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one.
  return new Date(utcFromFields(year, month + 1, 0, 0, 0, 0, 0)).getUTCDate();
}

function compareLocalDate(a: LocalDate, b: LocalDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

function pad(value: number, width: number): string {
  const text = String(Math.abs(value));
  return (value < 0 ? '-' : '') + (text.length >= width ? text : '0'.repeat(width - text.length) + text);
}

function formatCalendarDate(date: LocalDate): CalendarDate {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseCalendarDate(value: unknown): LocalDate | null {
  if (typeof value !== 'string' || !CALENDAR_DATE_PATTERN.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** ISO instant -> epoch ms, or null when absent/unparseable (bad data). */
function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function toInstant(ms: number): Instant {
  return new Date(ms).toISOString();
}

/* ---------------------------------------------------------- rule normalising */

interface NormalizedRule {
  freq: Frequency;
  interval: number;
  /**
   * WEEKLY only: offsets 0..6 from the rule's week start, ascending and deduped.
   * With the default WKST=MO these are the familiar MO=0 … SU=6.
   */
  weekdayOffsets: number[] | null;
  /** CR-006: index into WEEKDAYS of the day the week starts on. Defaults to MO. */
  weekStartIndex: number;
  /** MONTHLY only: 1..31, ascending and deduped. */
  monthDays: number[] | null;
  until: LocalDate | null;
  count: number | null;
}

/** CR-005: a blank or non-string location is no location at all. */
function cleanLocation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Defensive normalisation of a row-shaped rule.
 *
 * Returns `null` when the rule cannot be iterated at all (missing rule, unknown
 * `freq`, `interval` that is not an integer >= 1). A `null` here means "treat
 * this event as a single non-recurring event" — the safest useful result, since
 * the base event genuinely exists even when its rule is corrupt.
 *
 * Individual out-of-place fields are dropped rather than poisoning the rule:
 *   - `byWeekday` on a DAILY/MONTHLY rule -> ignored
 *   - `byMonthDay` on a DAILY/WEEKLY rule -> ignored
 *   - unknown weekday codes / month days outside 1..31 -> dropped; if that
 *     empties the list the rule behaves as if the field were absent
 *   - `until` that is not a real YYYY-MM-DD date -> ignored
 *   - `count` that is not an integer >= 1 -> ignored
 * (Negative `byMonthDay` values such as -1 for "last day" are NOT part of the
 * frozen contract — the field is documented as 1..31 — so they are dropped.)
 */
function normalizeRule(rule: RecurrenceRule | undefined): NormalizedRule | null {
  if (rule === undefined || rule === null || typeof rule !== 'object') return null;
  const freq = rule.freq;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null;
  if (!isPositiveInt(rule.interval)) return null;

  // CR-006. An unknown or absent `weekStart` falls back to the RFC 5545
  // default, Monday — the same anchor v1.0 hardcoded, so existing series do
  // not shift underneath a household that never set the field.
  const declaredWeekStart = WEEKDAYS.indexOf(rule.weekStart as Weekday);
  const weekStartIndex = declaredWeekStart < 0 ? WEEKDAYS.indexOf('MO') : declaredWeekStart;

  let weekdayOffsets: number[] | null = null;
  if (freq === 'WEEKLY' && Array.isArray(rule.byWeekday)) {
    const offsets: number[] = [];
    for (const code of rule.byWeekday) {
      const index = WEEKDAYS.indexOf(code);
      if (index < 0) continue; // unknown code — drop it
      const fromWeekStart = (index - weekStartIndex + 7) % 7;
      if (!offsets.includes(fromWeekStart)) offsets.push(fromWeekStart);
    }
    if (offsets.length > 0) {
      offsets.sort((a, b) => a - b);
      weekdayOffsets = offsets;
    }
  }

  let monthDays: number[] | null = null;
  if (freq === 'MONTHLY' && Array.isArray(rule.byMonthDay)) {
    const days: number[] = [];
    for (const day of rule.byMonthDay) {
      if (!Number.isInteger(day) || day < 1 || day > 31) continue;
      if (!days.includes(day)) days.push(day);
    }
    if (days.length > 0) {
      days.sort((a, b) => a - b);
      monthDays = days;
    }
  }

  return {
    freq,
    interval: rule.interval,
    weekStartIndex,
    weekdayOffsets,
    monthDays,
    until: parseCalendarDate(rule.until),
    count: isPositiveInt(rule.count) ? rule.count : null,
  };
}

function buildExceptionSet(rule: RecurrenceRule | undefined): Set<string> {
  const set = new Set<string>();
  if (rule === undefined || rule === null || !Array.isArray(rule.exceptions)) return set;
  for (const entry of rule.exceptions) {
    // Only well-formed YYYY-MM-DD entries can ever match; anything else is
    // dirty data and is ignored rather than throwing.
    if (typeof entry === 'string' && CALENDAR_DATE_PATTERN.test(entry)) set.add(entry);
  }
  return set;
}

/**
 * Candidate local dates produced by one period of the rule, ascending.
 *
 * DAILY   period k -> start + k*interval days.
 * WEEKLY  period k -> the selected weekdays of the k*interval-th week after the
 *         week containing the series start. The week starts on the rule's
 *         `weekStart` (CR-006), defaulting to MONDAY per RFC 5545 — that anchor
 *         is what makes "every 2 weeks on Mon+Fri" stable rather than drifting
 *         with the start weekday.
 * MONTHLY period k -> the selected month days of the k*interval-th month.
 *         Days that do not exist in that month are omitted (skip, never clamp).
 */
function periodDates(rule: NormalizedRule, start: LocalDate, period: number): LocalDate[] {
  if (rule.freq === 'DAILY') {
    return [addDays(start, period * rule.interval)];
  }

  if (rule.freq === 'WEEKLY') {
    const fromWeekStart = (dayOfWeek(start) - rule.weekStartIndex + 7) % 7;
    const offsets = rule.weekdayOffsets ?? [fromWeekStart];
    const anchor = addDays(start, -fromWeekStart);
    const weekShift = period * rule.interval * 7;
    return offsets.map((offset) => addDays(anchor, weekShift + offset));
  }

  // MONTHLY
  const totalMonths = start.year * 12 + (start.month - 1) + period * rule.interval;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const length = daysInMonth(year, month);
  const wanted = rule.monthDays ?? [start.day];
  const dates: LocalDate[] = [];
  for (const day of wanted) {
    if (day > length) continue; // e.g. the 31st of February — skipped outright
    dates.push({ year, month, day });
  }
  return dates;
}

/* ------------------------------------------------------------- window logic */

/** Half-open window test: an occurrence intersects [from, to). */
function intersectsWindow(startMs: number, endMs: number, fromMs: number, toMs: number): boolean {
  if (startMs >= toMs) return false;
  if (endMs > fromMs) return true;
  // Zero-length occurrence (start === end): treat it as a point in time so a
  // point event exactly at `from` is still visible.
  return endMs === startMs && startMs >= fromMs;
}

interface StagedOccurrence {
  startMs: number;
  endMs: number;
  occurrence: Occurrence;
}

function compareStaged(a: StagedOccurrence, b: StagedOccurrence): number {
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  if (a.endMs !== b.endMs) return a.endMs - b.endMs;
  if (a.occurrence.eventId !== b.occurrence.eventId) {
    return a.occurrence.eventId < b.occurrence.eventId ? -1 : 1;
  }
  if (a.occurrence.isOverride !== b.occurrence.isOverride) {
    return a.occurrence.isOverride ? 1 : -1;
  }
  return 0;
}

/* ------------------------------------------------------------- public API */

/**
 * Expand `event` into the concrete occurrences that intersect `window`.
 *
 * @param event   The base event. When `event.recurrence` is absent (or too
 *                corrupt to iterate) this yields at most one occurrence.
 * @param window  Half-open ISO instant range `[from, to)`. `to <= from` throws.
 * @param options
 *   - `participantIds` stamped verbatim onto every occurrence. The engine has
 *     no access to `EventParticipant` rows; the caller supplies the roster.
 *   - `overrides` materialised single-occurrence edits. An override applies
 *     when `override.seriesId === event.id` and its `recurrenceId` equals the
 *     ORIGINAL occurrence start. It replaces that occurrence entirely (its own
 *     start/end/title/status/domain win) and may move it out of, or into, the
 *     query window. `status: 'cancelled'` deletes the occurrence. If two
 *     overrides target the same `recurrenceId`, the LAST one in the array wins.
 *   - `maxOccurrences` hard cap on the returned array (default 1000).
 *
 * Ordering: ascending by `occurrenceStart`, with `occurrenceEnd`, `eventId` and
 * `isOverride` as deterministic tie-breakers, so identical inputs always give a
 * deeply-equal array.
 *
 * Semantics worth knowing:
 *   - A base event with `status: 'cancelled'` yields NOTHING, mirroring the
 *     cancelled-override rule (a cancelled series is not on the calendar).
 *   - `count` is applied to the RAW rule expansion from the series start, so it
 *     is independent of the query window. Exceptions and cancelled overrides
 *     consume a count slot (RFC 5545 order: expand, then subtract EXDATE).
 *   - `exceptions` are matched on the occurrence's LOCAL date (YYYY-MM-DD) in
 *     `event.timezone`, and win over an override for the same date.
 *   - `until` is inclusive by local date: an occurrence on the `until` day is
 *     kept, the next one is not.
 */
export function expandOccurrencesDetailed(
  event: EventRecord,
  window: { from: string; to: string },
  options?: { participantIds?: string[]; overrides?: EventRecord[]; maxOccurrences?: number },
): ExpansionResult {
  /* -- programmer errors: throw ------------------------------------------ */
  if (event === null || typeof event !== 'object') {
    throw new Error('expandOccurrences: `event` is required.');
  }
  if (window === null || typeof window !== 'object') {
    throw new Error('expandOccurrences: `window` is required.');
  }
  const windowFrom = parseInstant(window.from);
  if (windowFrom === null) {
    throw new Error(`expandOccurrences: window.from is not a valid ISO instant (${String(window.from)}).`);
  }
  const windowTo = parseInstant(window.to);
  if (windowTo === null) {
    throw new Error(`expandOccurrences: window.to is not a valid ISO instant (${String(window.to)}).`);
  }
  if (windowTo <= windowFrom) {
    throw new Error(
      `expandOccurrences: window.to (${window.to}) must be strictly after window.from (${window.from}).`,
    );
  }
  const requestedMax = options?.maxOccurrences;
  if (requestedMax !== undefined && !isPositiveInt(requestedMax)) {
    throw new Error(
      `expandOccurrences: options.maxOccurrences must be an integer >= 1 (received ${String(requestedMax)}).`,
    );
  }
  const maxOccurrences = requestedMax ?? DEFAULT_MAX_OCCURRENCES;

  /* -- bad data: degrade quietly ----------------------------------------- */
  const empty: ExpansionResult = { occurrences: [], truncated: false, maxOccurrences };
  if (event.status === 'cancelled') return empty;
  const seriesStart = parseInstant(event.startsAt);
  if (seriesStart === null) return empty; // unusable row
  const seriesEnd = parseInstant(event.endsAt);
  // A missing or inverted end yields a zero-length occurrence rather than a throw.
  const durationMs = seriesEnd === null || seriesEnd < seriesStart ? 0 : seriesEnd - seriesStart;
  const timezone: TimeZone =
    typeof event.timezone === 'string' && event.timezone.length > 0 ? event.timezone : 'UTC';

  const suppliedParticipantIds = options?.participantIds;
  const participantIds: UUID[] = Array.isArray(suppliedParticipantIds)
    ? suppliedParticipantIds.filter((id): id is UUID => typeof id === 'string')
    : [];

  /* -- overrides, keyed by the original occurrence start ------------------ */
  const overrides = new Map<number, EventRecord>();
  let latestOverrideAnchor = Number.NEGATIVE_INFINITY;
  const suppliedOverrides = options?.overrides;
  if (Array.isArray(suppliedOverrides)) {
    for (const override of suppliedOverrides) {
      if (override === null || typeof override !== 'object') continue;
      if (override.seriesId !== event.id) continue; // belongs to another series
      const anchor = parseInstant(override.recurrenceId);
      if (anchor === null) continue; // not an occurrence-level override
      overrides.set(anchor, override); // last write wins, deterministically
      if (anchor > latestOverrideAnchor) latestOverrideAnchor = anchor;
    }
  }

  // Expansion must reach far enough to see any overridden occurrence whose
  // ANCHOR sits past the window (it may have been moved INTO the window).
  const expandUntilMs =
    latestOverrideAnchor === Number.NEGATIVE_INFINITY
      ? windowTo
      : Math.max(windowTo, latestOverrideAnchor + 1);

  const baseLocation = cleanLocation(event.location);
  const exceptions = buildExceptionSet(event.recurrence);
  const rule = normalizeRule(event.recurrence);
  const isSeries = rule !== null;
  const staged: StagedOccurrence[] = [];
  /** Set when the hard step guard, not the rule, ended the expansion. */
  let stepLimited = false;

  const materialise = (rawStartMs: number, localDate: LocalDate): 'kept' | 'skipped' => {
    if (exceptions.has(formatCalendarDate(localDate))) return 'skipped';

    const override = overrides.get(rawStartMs);
    if (override !== undefined) {
      if (override.status === 'cancelled') return 'skipped';
      const overrideStart = parseInstant(override.startsAt);
      if (overrideStart === null) return 'skipped'; // unusable override row
      const overrideEndRaw = parseInstant(override.endsAt);
      const overrideEnd =
        overrideEndRaw === null || overrideEndRaw < overrideStart
          ? overrideStart + durationMs
          : overrideEndRaw;
      if (!intersectsWindow(overrideStart, overrideEnd, windowFrom, windowTo)) return 'skipped';
      const overrideLocation = cleanLocation(override.location) ?? baseLocation;
      staged.push({
        startMs: overrideStart,
        endMs: overrideEnd,
        occurrence: {
          eventId: override.id,
          seriesId: override.seriesId ?? event.id,
          occurrenceStart: toInstant(overrideStart),
          occurrenceEnd: toInstant(overrideEnd),
          title: override.title,
          domain: override.domain,
          status: override.status,
          participantIds: [...participantIds],
          isOverride: true,
          // CR-005. Omitted rather than set to undefined when absent, so two
          // expansions of the same series stay deep-strict-equal.
          ...(overrideLocation === undefined ? {} : { location: overrideLocation }),
        },
      });
      return 'kept';
    }

    const endMs = rawStartMs + durationMs;
    if (!intersectsWindow(rawStartMs, endMs, windowFrom, windowTo)) return 'skipped';
    staged.push({
      startMs: rawStartMs,
      endMs,
      occurrence: {
        eventId: event.id,
        seriesId: isSeries ? event.id : null,
        occurrenceStart: toInstant(rawStartMs),
        occurrenceEnd: toInstant(endMs),
        title: event.title,
        domain: event.domain,
        status: event.status,
        participantIds: [...participantIds],
        isOverride: false,
        ...(baseLocation === undefined ? {} : { location: baseLocation }),
      },
    });
    return 'kept';
  };

  if (rule === null) {
    // Non-recurring (or a rule too broken to iterate): at most one occurrence.
    materialise(seriesStart, toZonedFields(seriesStart, timezone));
  } else {
    const startFields = toZonedFields(seriesStart, timezone);
    const startDate: LocalDate = {
      year: startFields.year,
      month: startFields.month,
      day: startFields.day,
    };
    let period = 0;
    let steps = 0;
    let generated = 0;

    expansion: while (true) {
      if (steps >= MAX_EXPANSION_STEPS) {
        stepLimited = true;
        break expansion;
      }
      const candidates = periodDates(rule, startDate, period);
      period += 1;
      steps += 1; // an empty period (e.g. Feb for byMonthDay 31) still costs a step

      for (const candidate of candidates) {
        steps += 1;
        if (steps >= MAX_EXPANSION_STEPS) {
          stepLimited = true;
          break expansion;
        }

        // Dates earlier in the anchor week/month are not part of the series.
        if (compareLocalDate(candidate, startDate) < 0) continue;
        // `until` is inclusive of its own day.
        if (rule.until !== null && compareLocalDate(candidate, rule.until) > 0) break expansion;

        const rawStartMs = fromZonedFields(
          {
            year: candidate.year,
            month: candidate.month,
            day: candidate.day,
            hour: startFields.hour,
            minute: startFields.minute,
            second: startFields.second,
            ms: startFields.ms,
          },
          timezone,
        );
        if (rawStartMs < seriesStart) continue;

        // `count` is consumed by the RAW expansion — window-independent.
        generated += 1;
        if (rule.count !== null && generated > rule.count) break expansion;

        // Nothing generated at or after this bound can reach the window.
        if (rawStartMs >= expandUntilMs) break expansion;

        materialise(rawStartMs, candidate);

        // Guardrail: once the cap is filled and every override anchor is behind
        // us, later occurrences could only be truncated away anyway. We stage
        // exactly ONE past the cap on purpose (CR-007) — that surplus row is
        // what distinguishes a series that ended from one that was cut off.
        if (staged.length > maxOccurrences && rawStartMs > latestOverrideAnchor) break expansion;
      }
    }
  }

  staged.sort(compareStaged);
  const overflowed = staged.length > maxOccurrences;
  const capped = overflowed ? staged.slice(0, maxOccurrences) : staged;
  return {
    occurrences: capped.map((entry) => entry.occurrence),
    // Either bound counts as truncation: the caller's cap, or the hard step
    // guard that stops a pathological rule from spinning.
    truncated: overflowed || stepLimited,
    maxOccurrences,
  };
}

/**
 * Expand a series into the occurrences that intersect a window.
 *
 * The list-only form. Use `expandOccurrencesDetailed` when the caller needs to
 * know whether the cap cut the list short — a UI cannot offer a "more
 * occurrences exist" affordance from a bare array (CR-007).
 */
export function expandOccurrences(
  event: EventRecord,
  window: { from: string; to: string },
  options?: { participantIds?: string[]; overrides?: EventRecord[]; maxOccurrences?: number },
): Occurrence[] {
  return expandOccurrencesDetailed(event, window, options).occurrences;
}

/**
 * Do two occurrences overlap in time?
 *
 * Half-open intervals `[start, end)`: touching endpoints do NOT overlap, so a
 * 15:00-16:00 and a 16:00-17:00 occurrence are back-to-back, not conflicting.
 * A zero-length (or inverted, i.e. corrupt) occurrence is the empty interval
 * and therefore overlaps nothing. Unparseable instants return `false` rather
 * than throwing — the conflict engine must never crash on one bad row.
 *
 * This is purely temporal: it says nothing about shared participants, members
 * or locations. Those checks belong to the conflict engine.
 */
export function occurrencesOverlap(a: Occurrence, b: Occurrence): boolean {
  if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object') return false;
  const aStart = parseInstant(a.occurrenceStart);
  const aEnd = parseInstant(a.occurrenceEnd);
  const bStart = parseInstant(b.occurrenceStart);
  const bEnd = parseInstant(b.occurrenceEnd);
  if (aStart === null || aEnd === null || bStart === null || bEnd === null) return false;
  if (aEnd <= aStart || bEnd <= bStart) return false;
  return aStart < bEnd && bStart < aEnd;
}
