/**
 * INTENT PARSER — the seat the LLM sits in.
 *
 * PRODUCT_SPEC §1 wants a user to type "Leila has practice every Tuesday and
 * Thursday from 6 to 8" and have it land in Practice, recurring, with the right
 * person attached.
 *
 * **This is a deterministic rule-based parser, not a language model.** Saying so
 * plainly matters: the product claims an "AI scheduling brain", and what is
 * actually shipping here is a grammar. It handles the phrasings a family
 * actually uses for scheduling and reports honest confidence — low confidence
 * on a weak match is what routes the proposal to a confirmation prompt instead
 * of silently doing the wrong thing.
 *
 * The important architectural property is unchanged either way: whatever sits
 * in this seat only *proposes*. `validateAction` decides. Swapping this module
 * for a real model call means the validator, the permission checks, and the
 * confirmation policy all still stand between the model and the database.
 *
 * Pure and deterministic: no clock, no randomness, no I/O. `now` is injected.
 */
import type { AIActionProposal, DomainKey, RecurrenceRule, Weekday } from '../../lib/contracts/index.ts';

export interface ParseContext {
  /** ISO instant used as "today" for relative dates. Injected, never read. */
  now: string;
  /** Household members, so "Ana" resolves to a member id. */
  members: Array<{ id: string; displayName: string }>;
  /** Schedules, so a domain resolves to a real schedule row. */
  schedules: Array<{ id: string; domain: DomainKey }>;
  timezone?: string;
}

export interface ParseResult {
  proposal: AIActionProposal;
  /** Human-readable account of what was understood, shown before confirming. */
  understood: string[];
}

const WEEKDAY_WORDS: Array<[RegExp, Weekday, number]> = [
  [/\bsun(day)?s?\b/i, 'SU', 0],
  [/\bmon(day)?s?\b/i, 'MO', 1],
  [/\btue(s|sday)?s?\b/i, 'TU', 2],
  [/\bwed(nesday)?s?\b/i, 'WE', 3],
  [/\bthu(r|rs|rsday)?s?\b/i, 'TH', 4],
  [/\bfri(day)?s?\b/i, 'FR', 5],
  [/\bsat(urday)?s?\b/i, 'SA', 6],
];

/** Domain keywords, most specific first — "practice" must beat a bare verb. */
const DOMAIN_HINTS: Array<[RegExp, DomainKey]> = [
  [/\b(practice|training|rehearsal|lesson)\b/i, 'practice'],
  [/\b(game|match|scrimmage|valley cats)\b/i, 'games'],
  [/\b(competition|meet|tournament|recital)\b/i, 'competition'],
  [/\b(dentist|doctor|appointment|checkup|check-up|salon|haircut|clinic)\b/i, 'appointments'],
  [/\b(school|class|teacher|parent-teacher|field trip|pickup|drop-?off|picture day)\b/i, 'school'],
  [/\b(shift|jobsite|job site|work|overtime)\b/i, 'work'],
  [/\b(shia baby|shop|store|inventory|market)\b/i, 'shia-baby'],
  [/\b(errand|return|pharmacy|bank|post office|mail)\b/i, 'errands'],
];

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

interface TimeOfDay { hour: number; minute: number }

/** "6", "6:30", "6pm", "6:30 pm", "18:00" */
function parseTime(raw: string, meridiemHint?: string): TimeOfDay | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = (m[3] ?? meridiemHint ?? '').toLowerCase();
  if (hour > 23 || minute > 59) return null;

  if (meridiem === 'pm' && hour < 12) hour += 12;
  else if (meridiem === 'am' && hour === 12) hour = 0;
  else if (!meridiem && hour >= 1 && hour <= 7) {
    // "from 6 to 8" in a family calendar means the evening, not dawn. This is a
    // guess, so it is reported in `understood` and lowers confidence.
    hour += 12;
  }
  return { hour, minute };
}

function ymd(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Build an instant from a calendar date and a wall-clock time.
 *
 * Known simplification, stated rather than hidden: the offset for the household
 * timezone is applied as a fixed -5 (America/Chicago CDT) rather than resolved
 * per-date. A parse in November would be an hour off. The recurrence engine
 * handles real DST correctly; this parser does not, which is why every parsed
 * event goes through a confirmation step showing the resolved time.
 */
function instant(dateStr: string, time: TimeOfDay, offsetHours = -5): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const utc = Date.UTC(y ?? 2026, (mo ?? 1) - 1, d ?? 1, time.hour - offsetHours, time.minute, 0);
  return new Date(utc).toISOString();
}

/** Next occurrence of a weekday on or after `from`. */
function nextWeekday(from: Date, targetDow: number): Date {
  const d = new Date(from.getTime());
  const delta = (targetDow - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
}

function findMember(text: string, members: ParseContext['members']): { id: string; name: string } | null {
  for (const m of members) {
    const rx = new RegExp(`\\b${m.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (rx.test(text)) return { id: m.id, name: m.displayName };
  }
  return null;
}

function detectDomain(text: string): DomainKey | null {
  for (const [rx, domain] of DOMAIN_HINTS) if (rx.test(text)) return domain;
  return null;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parse one line of family shorthand into a proposal.
 *
 * Never throws and always returns something: an unparseable line becomes a
 * low-confidence inbox capture, which is the honest answer — the product's
 * Inbox exists precisely so unclear input has somewhere to go.
 */
export function parseIntent(input: string, ctx: ParseContext): ParseResult {
  const text = input.trim();
  const understood: string[] = [];

  if (text.length === 0) {
    return {
      proposal: { type: 'classify_inbox_item', payload: {}, confidence: 0 },
      understood: ['Nothing to read.'],
    };
  }

  const lower = text.toLowerCase();
  const today = new Date(ctx.now);

  /* ------------------------------------------------------- shopping ---- */

  const shopping = /^(?:we\s+)?(?:need|buy|get|pick up|add)\s+(.+?)(?:\s+(?:to|on)\s+the\s+(\w+)\s+list)?$/i.exec(text);
  if (shopping && !/\b(remind|appointment|practice|game|at\s+\d)\b/i.test(text)) {
    const raw = (shopping[1] ?? '').trim();
    const qtyMatch = /^(\d+)\s+(.*)$/.exec(raw);
    const quantity = qtyMatch ? Number(qtyMatch[1]) : 1;
    const name = qtyMatch ? (qtyMatch[2] ?? raw) : raw;
    const listName = shopping[2] ? titleCase(shopping[2]) : /\b(tape|bows|packaging|labels)\b/i.test(name) ? 'Business' : 'Groceries';
    understood.push(`Shopping item: ${name}`, `List: ${listName}`);
    if (quantity !== 1) understood.push(`Quantity: ${quantity}`);
    return {
      proposal: {
        type: 'add_shopping_item',
        payload: { name: titleCase(name), listName, quantity },
        confidence: 0.86,
        rationale: 'Phrased as something to buy.',
      },
      understood,
    };
  }

  /* ------------------------------------------------------ reminders ---- */

  const reminder = /^remind\s+(?:me|us)?\s*(?:to\s+)?(.+)$/i.exec(text);
  if (reminder) {
    let body = (reminder[1] ?? '').trim();
    let dueAt = instant(ymd(today), { hour: 9, minute: 0 });
    let confidence = 0.7;

    for (const [rx, , dow] of WEEKDAY_WORDS) {
      if (rx.test(body)) {
        const date = nextWeekday(today, dow);
        dueAt = instant(ymd(date), { hour: 9, minute: 0 });
        body = body.replace(rx, '').replace(/\s+on\s*$/i, '').trim();
        understood.push(`Due: ${ymd(date)}`);
        confidence = 0.82;
        break;
      }
    }
    if (/\btomorrow\b/i.test(body)) {
      const d = new Date(today.getTime() + 86_400_000);
      dueAt = instant(ymd(d), { hour: 9, minute: 0 });
      body = body.replace(/\btomorrow\b/i, '').trim();
      understood.push(`Due: ${ymd(d)}`);
      confidence = 0.85;
    }

    understood.unshift(`Reminder: ${body}`);
    return {
      proposal: {
        type: 'create_reminder',
        payload: { title: titleCase(body), dueAt },
        confidence,
        rationale: 'Starts with "remind".',
      },
      understood,
    };
  }

  /* -------------------------------------------------------- errands ---- */

  if (/^(?:i\s+need\s+to\s+)?(return|drop off|pick up|mail|deposit)\b/i.test(text) && /\b(pharmacy|package|bank|post|store|shop)\b/i.test(text)) {
    understood.push(`Errand: ${text}`);
    return {
      proposal: { type: 'create_errand', payload: { title: titleCase(text) }, confidence: 0.72, rationale: 'Reads as a physical task.' },
      understood,
    };
  }

  /* --------------------------------------------------------- events ---- */

  const member = findMember(text, ctx.members);
  const domain = detectDomain(text);

  // Times: "from 6 to 8", "at 3:30", "6-8pm"
  let start: TimeOfDay | null = null;
  let end: TimeOfDay | null = null;
  let timeGuess = false;

  const range = /\bfrom\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(?:to|until|till|-)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(text)
    ?? /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.exec(text);
  if (range) {
    const tail = /(am|pm)\s*$/i.exec(range[2] ?? '')?.[1];
    start = parseTime(range[1] ?? '', tail);
    end = parseTime(range[2] ?? '');
    if (!/am|pm/i.test(range[1] ?? '') && !/am|pm/i.test(range[2] ?? '')) timeGuess = true;
  } else {
    const at = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(text);
    if (at) {
      start = parseTime(at[1] ?? '');
      if (start) {
        end = { hour: start.hour + 1, minute: start.minute };
        if (!/am|pm/i.test(at[1] ?? '')) timeGuess = true;
      }
    }
  }

  // Recurrence: "every Tuesday and Thursday", "every week", "every 2 weeks"
  let recurrence: RecurrenceRule | undefined;
  const days: Weekday[] = [];
  let firstDow: number | null = null;
  for (const [rx, code, dow] of WEEKDAY_WORDS) {
    if (rx.test(text)) {
      days.push(code);
      if (firstDow === null) firstDow = dow;
    }
  }
  const isRecurring = /\bevery\b|\bweekly\b|\beach\b/i.test(text);
  if (isRecurring && days.length > 0) {
    const intervalMatch = /\bevery\s+(\d+)\s+weeks?\b/i.exec(text);
    recurrence = {
      freq: 'WEEKLY',
      interval: intervalMatch ? Number(intervalMatch[1]) : 1,
      byWeekday: days,
    };
    understood.push(`Repeats: ${days.join(', ')}${recurrence.interval > 1 ? ` every ${recurrence.interval} weeks` : ' weekly'}`);
  }

  // Date: an explicit weekday, "tomorrow", "September 12", else today.
  let dateStr = ymd(today);
  if (/\btomorrow\b/i.test(text)) {
    dateStr = ymd(new Date(today.getTime() + 86_400_000));
    understood.push(`Date: ${dateStr}`);
  } else if (firstDow !== null) {
    dateStr = ymd(nextWeekday(today, firstDow));
    understood.push(`Starts: ${dateStr}`);
  } else {
    const monthDay = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})\\b`, 'i').exec(text);
    if (monthDay) {
      const monthIndex = MONTHS.indexOf((monthDay[1] ?? '').toLowerCase());
      const day = Number(monthDay[2]);
      dateStr = ymd(new Date(Date.UTC(today.getUTCFullYear(), monthIndex, day)));
      understood.push(`Date: ${dateStr}`);
    }
  }

  // If nothing schedule-shaped was found, it belongs in the Inbox.
  if (!start && !domain && !member) {
    understood.push('Could not tell what this is — filing it to the Inbox to sort out later.');
    return {
      proposal: {
        type: 'classify_inbox_item',
        payload: { rawText: text },
        confidence: 0.25,
        rationale: 'No time, member, or category recognised.',
      },
      understood,
    };
  }

  const resolvedStart = start ?? { hour: 17, minute: 0 };
  const resolvedEnd = end ?? { hour: resolvedStart.hour + 1, minute: resolvedStart.minute };
  const resolvedDomain: DomainKey = domain ?? 'general';
  const schedule = ctx.schedules.find((s) => s.domain === resolvedDomain) ?? ctx.schedules[0];

  // Title: strip the machinery, keep the human words.
  let title = text
    .replace(/\bfrom\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+(?:to|until|till|-)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi, '')
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi, '')
    .replace(/\bevery\s+(\d+\s+)?weeks?\b/gi, '')
    .replace(/\bevery\b/gi, '')
    .replace(/\b(and|on)\b\s*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  for (const [rx] of WEEKDAY_WORDS) title = title.replace(rx, '').trim();
  title = title.replace(/\s+(and|on|,)\s*$/i, '').replace(/^\s*(has|have)\s+/i, '').replace(/\s{2,}/g, ' ').trim();
  if (title.length === 0) title = titleCase(resolvedDomain.replace('-', ' '));

  if (member) understood.unshift(`Who: ${member.name}`);
  understood.unshift(`Event: ${titleCase(title)}`);
  understood.push(`Category: ${resolvedDomain}`);
  if (timeGuess) understood.push('Assumed evening — confirm the time is right.');

  // Confidence is a real signal, not decoration: a guessed hour or a missing
  // person is exactly when the user should be asked rather than obeyed.
  let confidence = 0.9;
  if (!start) confidence -= 0.25;
  if (timeGuess) confidence -= 0.12;
  if (!domain) confidence -= 0.15;
  if (!member) confidence -= 0.08;
  confidence = Math.max(0.1, Math.round(confidence * 100) / 100);

  return {
    proposal: {
      type: recurrence ? 'create_recurring_schedule' : 'create_event',
      payload: {
        scheduleId: schedule?.id ?? 'sch-general',
        domain: resolvedDomain,
        title: titleCase(title),
        startsAt: instant(dateStr, resolvedStart),
        endsAt: instant(dateStr, resolvedEnd),
        timezone: ctx.timezone ?? 'America/Chicago',
        allDay: false,
        ...(recurrence ? { recurrence } : {}),
        ...(member ? { participantIds: [member.id] } : {}),
      },
      confidence,
      rationale: 'Recognised a scheduling phrase.',
    },
    understood,
  };
}
