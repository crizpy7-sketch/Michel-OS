/**
 * Michel-OS — Morning Brief (Agent H).
 *
 * PRODUCT_SPEC §10 lists what the brief shows: today, a preview of tomorrow,
 * conflicts, reminders, errands, a shopping count, Shia Baby staffing warnings,
 * and the important competition or game coming up.
 *
 * The brief is the one screen somebody reads *before* they have decided to care,
 * so its job is triage, not completeness. Three rules follow from that:
 *
 *   - **Assemble, never compute.** Occurrences come from the recurrence engine,
 *     conflicts from the conflict engine, warnings from the staffing module.
 *     If this file recomputed any of them, the brief could disagree with the
 *     screen the family opens next — and the brief would be the one they
 *     remembered.
 *   - **Bounded.** Every list is capped. A brief that shows forty reminders has
 *     told the family nothing.
 *   - **Deterministic and clock-free.** `now` is injected. Two people opening
 *     the brief at the same instant see the same brief, in the same order.
 *
 * The greeting is time-of-day aware but deliberately plain: this is a screen
 * about a dentist appointment and a double-booked Tuesday, and a chirpy tone
 * would be reaching for a mood the reader may not be in.
 */

import {
  type Conflict,
  type DomainKey,
  type Errand,
  type Instant,
  type MorningBrief,
  type Occurrence,
  type Reminder,
  type ShoppingItem,
  type TimeZone,
  type UUID,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------------ config */

export interface BriefLimits {
  today: number;
  tomorrow: number;
  conflicts: number;
  reminders: number;
  errands: number;
  staffingWarnings: number;
}

export const BRIEF_LIMITS: Readonly<BriefLimits> = Object.freeze({
  today: 12,
  tomorrow: 8,
  conflicts: 5,
  reminders: 8,
  errands: 6,
  staffingWarnings: 5,
});

/** How far ahead a game or competition still counts as "coming up". */
export const HEADLINE_HORIZON_DAYS = 7;

/** Domains whose events are the ones a family plans a week around. */
const HEADLINE_DOMAINS: ReadonlySet<DomainKey> = new Set<DomainKey>(['competition', 'games']);

/* ----------------------------------------------------------------- helpers */

function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

interface LocalDay {
  date: string; // YYYY-MM-DD
  hour: number;
}

/** Cached per zone — the brief calls this once per occurrence and reminder. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: TimeZone): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timezone);
  if (cached !== undefined) return cached;
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  };
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-CA', options);
  } catch {
    dtf = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' });
  }
  FORMATTERS.set(timezone, dtf);
  return dtf;
}

function localDay(ms: number, timezone: TimeZone): LocalDay {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) || 0,
  };
}

/** The same local date, `offset` days later. */
function shiftDate(date: string, offset: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + offset));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function compareOccurrences(a: Occurrence, b: Occurrence): number {
  if (a.occurrenceStart !== b.occurrenceStart) return a.occurrenceStart < b.occurrenceStart ? -1 : 1;
  if (a.occurrenceEnd !== b.occurrenceEnd) return a.occurrenceEnd < b.occurrenceEnd ? -1 : 1;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/* ------------------------------------------------------------------- input */

export interface MorningBriefInput {
  householdId: UUID;
  /** Injected. The brief never reads the clock. */
  now: Instant;
  timezone: TimeZone;
  /** Who the brief is for; used only for the greeting. */
  memberName?: string;
  /** Already expanded by the recurrence engine, over at least today + tomorrow. */
  occurrences: readonly Occurrence[];
  /** Already detected by the conflict engine. */
  conflicts?: readonly Conflict[];
  reminders?: readonly Reminder[];
  errands?: readonly Errand[];
  shoppingItems?: readonly ShoppingItem[];
  /** Already produced by the staffing module; passed through, never recomputed. */
  staffingWarnings?: readonly string[];
  limits?: Partial<BriefLimits>;
}

/* ------------------------------------------------------------------ build */

/**
 * Assemble the brief for one household at one instant.
 *
 * Everything is filtered to the household first — the brief renders somebody's
 * whole morning, so a leaked row here would be a leak on the most-read screen
 * in the product.
 */
export function buildMorningBrief(input: MorningBriefInput): MorningBrief {
  const limits = { ...BRIEF_LIMITS, ...(input.limits ?? {}) };
  const nowMs = parseInstant(input.now);
  const timezone = input.timezone || 'UTC';

  if (nowMs === null) {
    // A brief with no clock is empty rather than wrong. Every list is present so
    // the UI never has to branch on a partially-built object.
    return {
      householdId: input.householdId,
      date: '',
      greeting: greetingFor(null, input.memberName),
      today: [], tomorrow: [], conflicts: [], reminders: [], errands: [],
      shoppingCount: 0, staffingWarnings: [],
    };
  }

  const here = localDay(nowMs, timezone);
  const todayDate = here.date;
  const tomorrowDate = shiftDate(todayDate, 1);

  /* -- today and tomorrow -------------------------------------------------- */

  const byDay = new Map<string, Occurrence[]>();
  for (const occurrence of input.occurrences) {
    if (occurrence.status === 'cancelled') continue;
    const startMs = parseInstant(occurrence.occurrenceStart);
    if (startMs === null) continue;
    const date = localDay(startMs, timezone).date;
    if (date !== todayDate && date !== tomorrowDate) continue;
    const bucket = byDay.get(date);
    if (bucket) bucket.push(occurrence);
    else byDay.set(date, [occurrence]);
  }

  const today = (byDay.get(todayDate) ?? []).sort(compareOccurrences).slice(0, limits.today);
  const tomorrow = (byDay.get(tomorrowDate) ?? []).sort(compareOccurrences).slice(0, limits.tomorrow);

  /* -- conflicts ----------------------------------------------------------- */

  // Blocking first: the point of the brief is that the family sees the thing
  // that cannot happen before the thing that merely might not.
  const severityRank: Record<Conflict['severity'], number> = { blocking: 0, warning: 1, info: 2 };
  const conflicts = (input.conflicts ?? [])
    .filter((c) => c.householdId === input.householdId && c.resolution === undefined && c.severity !== 'info')
    .sort((a, b) => {
      if (a.severity !== b.severity) return severityRank[a.severity] - severityRank[b.severity];
      if (a.window.startsAt !== b.window.startsAt) return a.window.startsAt < b.window.startsAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, limits.conflicts);

  /* -- reminders ----------------------------------------------------------- */

  const reminders = (input.reminders ?? [])
    .filter((reminder) => {
      if (reminder.householdId !== input.householdId) return false;
      if (reminder.status === 'completed' || reminder.status === 'dismissed') return false;
      const due = parseInstant(reminder.status === 'snoozed' ? reminder.snoozedUntil : reminder.dueAt);
      if (due === null) return false;
      // Overdue, or falling due today — compared by LOCAL date, so a reminder
      // due at 8pm tonight counts and one due just after local midnight does
      // not. A reminder for next Friday is not this morning's business.
      return localDay(due, timezone).date <= todayDate;
    })
    .sort((a, b) => {
      const aKey = (a.status === 'snoozed' ? a.snoozedUntil : a.dueAt) ?? a.dueAt;
      const bKey = (b.status === 'snoozed' ? b.snoozedUntil : b.dueAt) ?? b.dueAt;
      if (aKey !== bKey) return aKey < bKey ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, limits.reminders);

  /* -- errands and shopping ------------------------------------------------ */

  const errands = (input.errands ?? [])
    .filter((e) => e.householdId === input.householdId && (e.status === 'open' || e.status === 'in_progress'))
    .sort((a, b) => {
      // Dated errands first, soonest first; undated ones after, by id.
      const aDue = a.dueAt ?? '';
      const bDue = b.dueAt ?? '';
      if (aDue !== bDue) {
        if (aDue === '') return 1;
        if (bDue === '') return -1;
        return aDue < bDue ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, limits.errands);

  const shoppingCount = (input.shoppingItems ?? []).filter(
    (item) => item.householdId === input.householdId && item.status === 'needed',
  ).length;

  /* -- staffing ------------------------------------------------------------ */

  const staffingWarnings = [...(input.staffingWarnings ?? [])].slice(0, limits.staffingWarnings);

  /* -- headline ------------------------------------------------------------ */

  const horizon = nowMs + HEADLINE_HORIZON_DAYS * 86_400_000;
  const headline = [...input.occurrences]
    .filter((occurrence) => {
      if (occurrence.status === 'cancelled') return false;
      if (!HEADLINE_DOMAINS.has(occurrence.domain)) return false;
      const startMs = parseInstant(occurrence.occurrenceStart);
      return startMs !== null && startMs >= nowMs && startMs <= horizon;
    })
    .sort(compareOccurrences)[0];

  return {
    householdId: input.householdId,
    date: todayDate,
    greeting: greetingFor(here.hour, input.memberName),
    today,
    tomorrow,
    conflicts,
    reminders,
    errands,
    shoppingCount,
    staffingWarnings,
    ...(headline === undefined
      ? {}
      : {
          headline: {
            title: headline.title,
            startsAt: headline.occurrenceStart,
            domain: headline.domain,
          },
        }),
  };
}

/**
 * Plain, and correct for the reader's local hour.
 *
 * "Good morning" on a screen somebody opened at 11pm is a small thing that
 * makes the whole brief feel like it is not paying attention.
 */
function greetingFor(hour: number | null, memberName?: string): string {
  const name = typeof memberName === 'string' && memberName.trim().length > 0 ? `, ${memberName.trim()}` : '';
  if (hour === null) return `Hello${name}.`;
  if (hour < 12) return `Good morning${name}.`;
  if (hour < 18) return `Good afternoon${name}.`;
  return `Good evening${name}.`;
}

/**
 * A one-line summary of the brief, for a push notification or a widget.
 *
 * Reports counts rather than restating the headline: the brief itself is one
 * tap away, and a notification that duplicates the screen it links to is noise.
 * "Nothing scheduled" is a real answer and gets said plainly.
 */
export function summarizeBrief(brief: MorningBrief): string {
  const parts: string[] = [];
  if (brief.today.length > 0) parts.push(`${brief.today.length} event${brief.today.length === 1 ? '' : 's'} today`);
  if (brief.conflicts.length > 0) {
    const blocking = brief.conflicts.filter((c) => c.severity === 'blocking').length;
    parts.push(blocking > 0 ? `${blocking} conflict${blocking === 1 ? '' : 's'} to sort out` : 'a possible conflict');
  }
  if (brief.reminders.length > 0) parts.push(`${brief.reminders.length} reminder${brief.reminders.length === 1 ? '' : 's'}`);
  if (brief.errands.length > 0) parts.push(`${brief.errands.length} errand${brief.errands.length === 1 ? '' : 's'}`);
  if (brief.shoppingCount > 0) parts.push(`${brief.shoppingCount} thing${brief.shoppingCount === 1 ? '' : 's'} to buy`);
  if (brief.staffingWarnings.length > 0) parts.push(`${brief.staffingWarnings.length} staffing warning${brief.staffingWarnings.length === 1 ? '' : 's'}`);

  if (parts.length === 0) return 'Nothing scheduled today.';
  if (parts.length === 1) return `${capitalize(parts[0]!)}.`;
  const last = parts.pop()!;
  return `${capitalize(parts.join(', '))} and ${last}.`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
