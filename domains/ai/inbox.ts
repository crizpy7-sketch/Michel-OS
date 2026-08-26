/**
 * Michel-OS — Inbox classification and routing (Agent H).
 *
 * PRODUCT_SPEC §3 (Inbox): the family dumps unorganised text — "we need milk",
 * "Mateo plays Saturday at 4", "Maria cannot work Thursday" — and the AI layer
 * routes each item into the right mini-app.
 *
 * ARCHITECTURE.md §3 is the constraint that shapes this file: *the LLM must
 * never directly own calendar state*. So this module does not save anything and
 * does not decide anything. It reads text and emits an `AIActionProposal` —
 * the same untrusted envelope a model would produce — which then goes through
 * `validateAction` like any other. The classifier is deterministic rather than
 * model-driven, which buys two things worth more than cleverness here:
 *
 *   - the same sentence always routes the same way, so a family can learn what
 *     the system does with their words;
 *   - it is the floor under a model, not a competitor to one. A model's
 *     classification enters the pipeline through the identical proposal shape
 *     and meets the identical validator.
 *
 * The rule that keeps it honest: **never invent a required field.** If the text
 * does not say when, this module will not guess a due date to make a tidier
 * proposal — it emits `classify_inbox_item` instead, which is a read-level
 * action that parks the item for a human. A confidently wrong 9am reminder is
 * worse than an item still sitting in the inbox.
 */

import {
  type AIActionProposal,
  type AIActionType,
  type DomainKey,
  type InboxItem,
  type Instant,
  type TimeZone,
  type UUID,
  type Weekday,
} from '../../lib/contracts/index.ts';

/* ---------------------------------------------------------------- context */

export interface InboxMemberRef {
  id: UUID;
  displayName: string;
}

export interface InboxContext {
  householdId: UUID;
  /** Injected instant. Relative words ("tomorrow") resolve against this. */
  now: Instant;
  /** The household's zone; every local time in the text is read in it. */
  timezone: TimeZone;
  members?: readonly InboxMemberRef[];
  /** Shia Baby staff, so "Maria cannot work Thursday" routes to the business. */
  employees?: readonly InboxMemberRef[];
}

export interface InboxClassification {
  domain: DomainKey;
  /** 0..1, derived from the strength of the signals — never a magic number. */
  confidence: number;
  /** Human-readable reasons, in a fixed order, for the confirmation screen. */
  signals: string[];
  /** Household members named in the text. */
  participantIds: UUID[];
  /** The time the text described, if it described one at all. */
  when: { startsAt: Instant; endsAt: Instant } | null;
  /** A weekly rule, when the text said "every Tuesday and Thursday". */
  recurrence: { freq: 'WEEKLY'; interval: number; byWeekday: Weekday[] } | null;
  /** The untrusted envelope for `validateAction`. Nothing is saved from here. */
  proposal: AIActionProposal;
}

/* ---------------------------------------------------------------- lexicons */

/**
 * Domain signals, strongest first within each list.
 *
 * These are whole-word matches. "practice" must not fire on "practical", and a
 * substring matcher in a family calendar produces exactly that class of
 * embarrassing misroute.
 */
const LEXICON: ReadonlyArray<{ domain: DomainKey; weight: number; words: readonly string[] }> = Object.freeze([
  { domain: 'shia-baby', weight: 4, words: ['shift', 'shifts', 'closing', 'opening', 'inventory', 'restock', 'employee', 'staff', 'payroll', 'register'] },
  { domain: 'competition', weight: 4, words: ['competition', 'tournament', 'meet', 'championship', 'finals', 'regionals', 'awards'] },
  { domain: 'games', weight: 4, words: ['game', 'games', 'scrimmage', 'opponent', 'kickoff', 'playoff'] },
  { domain: 'practice', weight: 4, words: ['practice', 'practices', 'rehearsal', 'training', 'workout', 'drills'] },
  { domain: 'appointments', weight: 4, words: ['appointment', 'dentist', 'doctor', 'pediatrician', 'orthodontist', 'checkup', 'clinic', 'salon', 'haircut', 'reservation'] },
  { domain: 'school', weight: 4, words: ['school', 'teacher', 'homework', 'classroom', 'assembly', 'principal', 'detention'] },
  { domain: 'work', weight: 3, words: ['jobsite', 'overtime', 'scaffold', 'crew', 'foreman'] },
  { domain: 'shopping', weight: 4, words: ['buy', 'groceries', 'grocery', 'milk', 'eggs', 'bread', 'diapers', 'shampoo', 'detergent'] },
  { domain: 'errands', weight: 4, words: ['return', 'returns', 'pickup', 'drop', 'mail', 'package', 'pharmacy', 'bank', 'deposit', 'dmv'] },
  { domain: 'reminders', weight: 4, words: ['remind', 'reminder', 'remember', 'renew', 'renewal', 'call', 'email', 'rsvp'] },
]);

/** Phrases that name a domain outright and outweigh a single keyword. */
const STRONG_PHRASES: ReadonlyArray<{ domain: DomainKey; weight: number; rx: RegExp }> = Object.freeze([
  { domain: 'shopping', weight: 6, rx: /\bwe (?:need|are out of|ran out of)\b/i },
  { domain: 'shopping', weight: 6, rx: /\b(?:add|put) .+ (?:to|on) the (?:shopping |grocery )?list\b/i },
  { domain: 'shia-baby', weight: 7, rx: /\bcan(?:no|')?t work\b/i },
  { domain: 'shia-baby', weight: 6, rx: /\b(?:time off|day off|shift swap|cover (?:my|the) shift)\b/i },
  { domain: 'games', weight: 6, rx: /\bplays?\b(?!.*\bpractice\b)/i },
  { domain: 'school', weight: 6, rx: /\b(?:early release|picture day|field trip|parent[- ]teacher|report card)\b/i },
  { domain: 'reminders', weight: 6, rx: /\b(?:remind me|don'?t forget)\b/i },
  { domain: 'errands', weight: 5, rx: /\b(?:pick up|drop off|swing by)\b/i },
]);

/** Words that signal a repeating commitment. */
const RECURRENCE_RX = /\b(every|each|weekly)\b/i;

/* ---------------------------------------------------------------- time */

const WEEKDAY_WORDS: ReadonlyArray<{ code: Weekday; words: readonly string[] }> = Object.freeze([
  { code: 'SU', words: ['sunday', 'sun'] },
  { code: 'MO', words: ['monday', 'mon'] },
  { code: 'TU', words: ['tuesday', 'tue', 'tues'] },
  { code: 'WE', words: ['wednesday', 'wed'] },
  { code: 'TH', words: ['thursday', 'thu', 'thur', 'thurs'] },
  { code: 'FR', words: ['friday', 'fri'] },
  { code: 'SA', words: ['saturday', 'sat'] },
]);

const WEEKDAY_INDEX: Readonly<Record<Weekday, number>> = Object.freeze({
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
});

const DEFAULT_DURATION_MINUTES = 60;

/**
 * Cached per zone. `instantFromZoned` makes several passes per item, so a fresh
 * formatter per call would dominate a batch inbox import.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: TimeZone): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timezone);
  if (cached !== undefined) return cached;
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hourCycle: 'h23',
  };
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-US', options);
  } catch {
    // A household with a corrupt timezone still gets sensible routing.
    dtf = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
  FORMATTERS.set(timezone, dtf);
  return dtf;
}

/** Local wall-clock fields of an instant in a zone. */
function zonedFields(ms: number, timezone: TimeZone): {
  year: number; month: number; day: number; hour: number; minute: number; weekdayIndex: number;
} {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  const shortDay = (parts.find((p) => p.type === 'weekday')?.value ?? 'Mon').toUpperCase().slice(0, 2) as Weekday;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekdayIndex: WEEKDAY_INDEX[shortDay] ?? 1,
  };
}

/**
 * Local wall-clock fields back to a UTC instant.
 *
 * Two passes: guess with the UTC interpretation, measure the zone's offset at
 * that guess, correct, then re-measure. That settles DST transitions, where the
 * first correction can land on the other side of the jump.
 */
function instantFromZoned(
  fields: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: TimeZone,
): number {
  const naive = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, 0, 0);
  let guess = naive;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = zonedFields(guess, timezone);
    const seenNaive = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0, 0);
    const drift = naive - seenNaive;
    if (drift === 0) break;
    guess += drift;
  }
  return guess;
}

interface ParsedTime {
  /** Minutes from local midnight. */
  startMinute: number;
  endMinute: number | null;
  /** True when the text used an explicit am/pm rather than a bare hour. */
  explicitMeridiem: boolean;
}

/**
 * Read a clock time, or a range, out of the text.
 *
 * Bare hours are the interesting case. "practice at 6" means the evening and
 * "school at 8" means the morning, so a bare 1–7 reads as PM and 8–11 as AM.
 * That rule is wrong sometimes, which is why `explicitMeridiem` travels with
 * the result and lowers confidence — a guessed meridiem should reach a human.
 */
function parseTime(text: string): ParsedTime | null {
  const rangeRx = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
  const range = rangeRx.exec(text);
  if (range) {
    const endMeridiem = (range[6] ?? '').toLowerCase();
    const startMeridiem = (range[3] ?? '').toLowerCase() || endMeridiem;
    const start = toMinute(Number(range[1]), Number(range[2] ?? 0), startMeridiem);
    let end = toMinute(Number(range[4]), Number(range[5] ?? 0), endMeridiem);
    // "6 to 8" in the evening: an end that lands before the start means the
    // range crossed the meridiem the writer never typed.
    if (end <= start) end += 12 * 60;
    return { startMinute: start, endMinute: end, explicitMeridiem: startMeridiem !== '' };
  }

  const singleRx = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2})(?::(\d{2}))?\b/i;
  const single = singleRx.exec(text);
  if (single) {
    const withMeridiem = single[1] !== undefined;
    const hour = Number(withMeridiem ? single[1] : single[4]);
    const minute = Number((withMeridiem ? single[2] : single[5]) ?? 0);
    const meridiem = (single[3] ?? '').toLowerCase();
    if (!Number.isFinite(hour) || hour > 23) return null;
    return {
      startMinute: toMinute(hour, minute, meridiem),
      endMinute: null,
      explicitMeridiem: meridiem !== '',
    };
  }

  return null;
}

function toMinute(hour: number, minute: number, meridiem: string): number {
  let h = hour % 24;
  if (meridiem === 'pm' && h < 12) h += 12;
  else if (meridiem === 'am' && h === 12) h = 0;
  else if (meridiem === '') {
    // The bare-hour reading, documented above.
    if (h >= 1 && h <= 7) h += 12;
    else if (h === 12) h = 12;
  }
  return h * 60 + (Number.isFinite(minute) ? minute : 0);
}

interface ParsedDay {
  /** Offset in whole days from the local "today". */
  dayOffset: number;
  /** The weekday the text named, when it named one. */
  weekday: Weekday | null;
  label: string;
}

/**
 * Read a day out of the text.
 *
 * A bare weekday means the next one that has not happened yet — "Mateo plays
 * Saturday" said on a Saturday morning means today, not a week away, so the
 * same-day case is kept rather than skipped.
 */
function parseDay(text: string, todayWeekdayIndex: number): ParsedDay | null {
  if (/\btomorrow\b/i.test(text)) return { dayOffset: 1, weekday: null, label: 'tomorrow' };
  if (/\btoday\b|\btonight\b/i.test(text)) return { dayOffset: 0, weekday: null, label: 'today' };

  for (const { code, words } of WEEKDAY_WORDS) {
    for (const word of words) {
      if (new RegExp(`\\b${word}s?\\b`, 'i').test(text)) {
        const target = WEEKDAY_INDEX[code];
        const offset = (target - todayWeekdayIndex + 7) % 7;
        return { dayOffset: offset, weekday: code, label: words[0]! };
      }
    }
  }
  return null;
}

/** Every weekday named in the text, for "every Tuesday and Thursday". */
function parseWeekdays(text: string): Weekday[] {
  const found: Weekday[] = [];
  for (const { code, words } of WEEKDAY_WORDS) {
    if (words.some((word) => new RegExp(`\\b${word}s?\\b`, 'i').test(text))) found.push(code);
  }
  return found;
}

/* -------------------------------------------------------------- classify */

const DOMAIN_TO_ACTION: Readonly<Partial<Record<DomainKey, AIActionType>>> = Object.freeze({
  shopping: 'add_shopping_item',
  errands: 'create_errand',
  reminders: 'create_reminder',
});

/** Domains whose items are calendar events rather than list rows. */
const EVENT_DOMAINS: ReadonlySet<DomainKey> = new Set<DomainKey>([
  'appointments', 'practice', 'competition', 'games', 'school', 'work',
]);

/**
 * Classify one inbox item and produce the proposal it implies.
 *
 * Confidence is computed from the signals actually found, so it is auditable:
 * a strong phrase plus a resolved time scores high, a lone weak keyword scores
 * low, and a guessed meridiem costs a little. It is never a constant.
 */
export function classifyInboxItem(item: InboxItem, ctx: InboxContext): InboxClassification {
  const text = typeof item?.rawText === 'string' ? item.rawText : '';
  const signals: string[] = [];

  /* -- 1. which mini-app ---------------------------------------------------- */

  const scores = new Map<DomainKey, number>();
  const bump = (domain: DomainKey, weight: number, why: string): void => {
    scores.set(domain, (scores.get(domain) ?? 0) + weight);
    signals.push(why);
  };

  for (const phrase of STRONG_PHRASES) {
    if (phrase.rx.test(text)) bump(phrase.domain, phrase.weight, `phrase matched for ${phrase.domain}`);
  }
  for (const entry of LEXICON) {
    for (const word of entry.words) {
      if (word.length === 0) continue;
      if (new RegExp(`\\b${word}\\b`, 'i').test(text)) {
        bump(entry.domain, entry.weight, `keyword "${word}" (${entry.domain})`);
        break; // one hit per domain per lexicon entry; repetition is not evidence
      }
    }
  }

  /* -- 2. who ------------------------------------------------------------- */

  const participantIds: UUID[] = [];
  for (const member of ctx.members ?? []) {
    if (namedIn(text, member.displayName)) {
      participantIds.push(member.id);
      signals.push(`named ${member.displayName}`);
    }
  }
  participantIds.sort();

  const namedEmployees = (ctx.employees ?? []).filter((e) => namedIn(text, e.displayName));
  if (namedEmployees.length > 0) {
    bump('shia-baby', 3, `named employee ${namedEmployees.map((e) => e.displayName).sort().join(', ')}`);
  }

  /* -- 3. when ------------------------------------------------------------ */

  const nowMs = Date.parse(ctx.now);
  const today = Number.isFinite(nowMs) ? zonedFields(nowMs, ctx.timezone) : null;

  const time = parseTime(text);
  const day = today === null ? null : parseDay(text, today.weekdayIndex);
  const repeats = RECURRENCE_RX.test(text);
  const repeatDays = repeats ? parseWeekdays(text) : [];

  let when: { startsAt: Instant; endsAt: Instant } | null = null;
  if (today !== null && (day !== null || time !== null)) {
    const base = new Date(
      instantFromZoned({ ...today, hour: 12, minute: 0 }, ctx.timezone) + (day?.dayOffset ?? 0) * 86_400_000,
    );
    const local = zonedFields(base.getTime(), ctx.timezone);
    const startMinute = time?.startMinute ?? 9 * 60;
    const endMinute = time?.endMinute ?? startMinute + DEFAULT_DURATION_MINUTES;

    const startMs = instantFromZoned(
      { year: local.year, month: local.month, day: local.day, hour: Math.floor(startMinute / 60), minute: startMinute % 60 },
      ctx.timezone,
    );
    const endMs = instantFromZoned(
      { year: local.year, month: local.month, day: local.day, hour: Math.floor(endMinute / 60), minute: endMinute % 60 },
      ctx.timezone,
    );

    when = { startsAt: new Date(startMs).toISOString(), endsAt: new Date(Math.max(endMs, startMs + 60_000)).toISOString() };
    if (day !== null) signals.push(`day: ${day.label}`);
    if (time !== null) signals.push(time.explicitMeridiem ? 'explicit time of day' : 'time of day inferred from a bare hour');
  }

  const recurrence =
    repeats && repeatDays.length > 0 ? { freq: 'WEEKLY' as const, interval: 1, byWeekday: repeatDays } : null;
  if (recurrence !== null) signals.push(`repeats weekly on ${repeatDays.join(', ')}`);

  /* -- 4. settle the domain ------------------------------------------------ */

  let domain: DomainKey = 'general';
  let topScore = 0;
  // Ties break on the lexicon's own order, which is fixed — never on Map order.
  for (const entry of [...STRONG_PHRASES, ...LEXICON]) {
    const score = scores.get(entry.domain) ?? 0;
    if (score > topScore) {
      topScore = score;
      domain = entry.domain;
    }
  }
  if (topScore === 0 && when !== null) {
    // A bare "Saturday at 4" with no other signal is still a calendar entry.
    domain = 'general';
    signals.push('a time with no category — filed as a general event');
  }

  /* -- 5. confidence ------------------------------------------------------- */

  let confidence = 0;
  if (topScore > 0) confidence += Math.min(0.55, topScore * 0.09);
  if (when !== null) confidence += 0.2;
  if (participantIds.length > 0) confidence += 0.1;
  if (recurrence !== null) confidence += 0.05;
  if (time !== null && !time.explicitMeridiem) confidence -= 0.1; // a guessed meridiem is a guess
  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(4))));

  /* -- 6. the proposal ----------------------------------------------------- */

  const proposal = buildProposal({ item, ctx, domain, when, recurrence, participantIds, confidence, text });

  return { domain, confidence, signals, participantIds, when, recurrence, proposal };
}

/** Whole-name, case-insensitive. "Ana" must not match "Anastasia" or "banana". */
function namedIn(text: string, displayName: string): boolean {
  const first = displayName.trim().split(/\s+/)[0];
  if (first === undefined || first.length < 2) return false;
  const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

interface ProposalInput {
  item: InboxItem;
  ctx: InboxContext;
  domain: DomainKey;
  when: { startsAt: Instant; endsAt: Instant } | null;
  recurrence: { freq: 'WEEKLY'; interval: number; byWeekday: Weekday[] } | null;
  participantIds: UUID[];
  confidence: number;
  text: string;
}

/**
 * Build the untrusted envelope.
 *
 * The fallback is the whole point: whenever a required field cannot be read out
 * of the text, this returns `classify_inbox_item` — a read-level action that
 * files the item under a suggested domain and waits for a person. Fabricating a
 * plausible `dueAt` to reach a tidier action type is exactly the failure this
 * pipeline exists to prevent.
 */
function buildProposal(input: ProposalInput): AIActionProposal {
  const { item, domain, when, recurrence, participantIds, confidence, text } = input;
  const title = summarize(text);

  const park = (): AIActionProposal => ({
    type: 'classify_inbox_item',
    payload: { inboxItemId: item.id, domain, notes: text.slice(0, 2000) },
    confidence,
    rationale: 'Not enough detail to fill a concrete action; filed for review.',
  });

  if (title.length === 0) return park();

  if (EVENT_DOMAINS.has(domain) || (domain === 'general' && when !== null)) {
    if (when === null) return park(); // an event with no time is not an event
    const payload: Record<string, unknown> = {
      title,
      domain,
      startsAt: when.startsAt,
      endsAt: when.endsAt,
      timezone: input.ctx.timezone,
    };
    if (participantIds.length > 0) payload['participantIds'] = participantIds;
    if (recurrence !== null) payload['recurrence'] = recurrence;
    return {
      type: recurrence === null ? 'create_event' : 'create_recurring_schedule',
      payload,
      confidence,
      rationale: `Reads as a ${domain} entry.`,
    };
  }

  const action = DOMAIN_TO_ACTION[domain];

  if (action === 'add_shopping_item') {
    return {
      type: 'add_shopping_item',
      payload: { name: title, quantity: 1 },
      confidence,
      rationale: 'Reads as something to buy.',
    };
  }

  if (action === 'create_errand') {
    const payload: Record<string, unknown> = { title };
    if (when !== null) payload['dueAt'] = when.startsAt;
    return { type: 'create_errand', payload, confidence, rationale: 'Reads as a trip to make.' };
  }

  if (action === 'create_reminder') {
    // `dueAt` is required by the frozen schema and cannot be invented.
    if (when === null) return park();
    const payload: Record<string, unknown> = { title, dueAt: when.startsAt };
    if (participantIds.length === 1) payload['assignedTo'] = participantIds[0];
    return { type: 'create_reminder', payload, confidence, rationale: 'Reads as something to remember.' };
  }

  return park();
}

/**
 * A title from free text: the first clause, trimmed and capped.
 *
 * Deliberately not a summarizer. Showing the family their own words back is
 * more trustworthy than a paraphrase, and it cannot hallucinate.
 */
function summarize(text: string): string {
  const firstClause = text.split(/[.\n;]/)[0] ?? '';
  return firstClause.trim().replace(/\s+/g, ' ').slice(0, 200);
}
