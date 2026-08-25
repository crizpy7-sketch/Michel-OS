/**
 * AI ACTION VALIDATION KERNEL — Michel-OS (Agent H)
 *
 * Governing rule (docs/handoff/AI_ACTIONS.md): "The LLM does not directly modify data."
 * The model *proposes*; this module *decides*. Every `AIActionProposal.payload` is treated
 * as fully untrusted input — as hostile as a request body from the open internet.
 *
 * Guarantees:
 *  - PURE + DETERMINISTIC: no Date.now(), no Math.random(), no I/O. `now` is injected.
 *  - NON-MUTATING: the input proposal is never written to (deep-freeze safe; all reads go
 *    through Object.getOwnPropertyDescriptor so hostile getters are never invoked).
 *  - WHITELIST-ONLY OUTPUT: `command.payload` is rebuilt from scratch out of validated,
 *    coerced values. Raw model output never passes through.
 *  - FAIL CLOSED: unknown action types, unverifiable tenant scope and unknown-schema
 *    actions can never reach `decision: 'execute'`.
 *
 * Zero dependencies by design (no zod) — the schema kernel below is everything we need
 * and keeps the security-critical seam auditable in a single file.
 */

import {
  AI_ACTION_TYPES,
  DOMAINS,
  EVENT_STATUS,
  PARTICIPANT_ROLES,
  FREQUENCIES,
  WEEKDAYS,
  type AIActionProposal,
  type AIActionType,
  type AIActionVerdict,
  type Permission,
  type ValidationIssue,
  type Weekday,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------------ policy */

/** Default `confidence` floor below which we ask a human. */
export const CONFIRM_THRESHOLD_DEFAULT = 0.75;

/** How far before `ctx.now` a start/due instant may sit before we demand confirmation. */
export const PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Actions that destroy or detach data — never autonomous. */
export const DESTRUCTIVE_ACTIONS: readonly AIActionType[] = [
  'cancel_event',
  'remove_participant',
  'remove_shift_assignment',
  'dismiss_inbox_item',
];

/** Actions that move money or stock — never autonomous. */
export const MONEY_ACTIONS: readonly AIActionType[] = [
  'record_expense',
  'update_expense',
  'record_sale',
  'record_sale_item',
  'adjust_inventory',
  'receive_inventory',
];

/** Instant-valued fields that are checked against `ctx.now` for "distant past". */
const PAST_SENSITIVE_FIELDS: readonly string[] = ['startsAt', 'dueAt', 'occurredAt'];

export interface ValidateActionContext {
  /** Trusted tenant scope. Payload-supplied household ids must match this exactly. */
  householdId: string;
  /** Trusted actor. Never taken from the payload. */
  actorMemberId: string;
  /** Injected ISO instant — the validator never reads the clock itself. */
  now: string;
  /** Injected permission oracle (dependency inversion — no import of the permissions module). */
  can: (permission: Permission) => boolean;
  /** Confidence floor; defaults to CONFIRM_THRESHOLD_DEFAULT. */
  confirmThreshold?: number;
  /**
   * Optional business scope for Shia-Baby actions. When supplied, a payload `businessId`
   * must match it. When omitted, a payload `businessId` must match `householdId`
   * (i.e. a business id the caller has not vouched for is rejected, never guessed).
   */
  businessId?: string;
}

/* ------------------------------------------------------------- issue utils */

type Push = (issue: ValidationIssue) => void;

/** Freeze an array without losing its element type (defensive immutability). */
const freezeArray = <T,>(arr: T[]): T[] => Object.freeze(arr) as T[];

const issue = (path: string, message: string, code: ValidationIssue['code']): ValidationIssue => ({
  path,
  message,
  code,
});

/* ------------------------------------------------------- safe object access */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read an own property WITHOUT prototype lookup and WITHOUT invoking accessors.
 * Accessor properties read as `undefined` (treated as absent) — fail closed.
 */
const readOwn = (obj: Record<string, unknown>, key: string): unknown => {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return desc === undefined ? undefined : desc.value;
};

const hasOwnKey = (obj: Record<string, unknown>, key: string): boolean =>
  Object.getOwnPropertyDescriptor(obj, key) !== undefined;

/** Own keys including non-enumerable ones, so nothing can hide from the whitelist sweep. */
const ownKeys = (obj: Record<string, unknown>): string[] => Object.getOwnPropertyNames(obj);

/** `Household_ID` / `household-id` / `householdId` all normalise to `householdid`. */
const normKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const camelToSnake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/* ------------------------------------------------------------ hostile keys */

/** Tenant assertions the model may attempt to forge. */
const HOUSEHOLD_SCOPE_KEYS = new Set([
  'householdid',
  'household',
  'tenantid',
  'tenant',
  'orgid',
  'organizationid',
]);
const BUSINESS_SCOPE_KEYS = new Set(['businessid', 'business', 'shopid', 'storeid']);

/** Privilege-escalation / server-assigned fields. Rejected loudly, never honoured. */
const ESCALATION_KEYS = new Set([
  'role',
  'roles',
  'permission',
  'permissions',
  'scopes',
  'isadmin',
  'admin',
  'isowner',
  'owner',
  'ownerid',
  'id',
  'uuid',
  'userid',
  'user',
  'createdby',
  'updatedby',
  'actormemberid',
  'actor',
  'auth',
  'token',
  'accesstoken',
  'apikey',
  'password',
  'session',
  'sudo',
  'impersonate',
  'systemprompt',
]);

/** Prototype-pollution vectors. */
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/* ---------------------------------------------------------- schema kernel */

type Spec =
  | { t: 'text'; max: number }
  | { t: 'id' }
  | { t: 'instant' }
  | { t: 'date' }
  | { t: 'number'; min: number; max: number; int?: boolean; money?: boolean }
  | { t: 'bool' }
  | { t: 'enum'; values: readonly string[] }
  | { t: 'idList'; max: number }
  | { t: 'timezone' }
  | { t: 'recurrence' };

interface Field {
  spec: Spec;
  required?: boolean;
  aliases?: readonly string[];
  fallback?: unknown;
}

interface ActionSchema {
  fields: Record<string, Field>;
  /** All of these permissions are required. */
  all?: readonly Permission[];
  /** At least one of these permissions is required. */
  any?: readonly Permission[];
  /** Business-scoped action (Shia Baby). */
  business?: boolean;
  /** Unknown fields are REJECTED rather than stripped (used by the generic fallback). */
  strictUnknown?: boolean;
  /** Forces `confirm`; the string is the human-readable reason. */
  alwaysConfirm?: string;
  /** Cross-field checks over the already-coerced output payload. */
  logic?: (out: Record<string, unknown>, push: Push) => void;
}

/* field builders */
const text = (max: number, required = false, aliases?: readonly string[], fallback?: unknown): Field => ({
  spec: { t: 'text', max },
  required,
  aliases,
  fallback,
});
const id = (required = false, aliases?: readonly string[]): Field => ({
  spec: { t: 'id' },
  required,
  aliases,
});
const instant = (required = false, aliases?: readonly string[]): Field => ({
  spec: { t: 'instant' },
  required,
  aliases,
});
const calDate = (required = false, aliases?: readonly string[]): Field => ({
  spec: { t: 'date' },
  required,
  aliases,
});
const num = (
  min: number,
  max: number,
  opts?: {
    int?: boolean;
    money?: boolean;
    required?: boolean;
    aliases?: readonly string[];
    fallback?: number;
  },
): Field => ({
  spec: { t: 'number', min, max, int: opts?.int, money: opts?.money },
  required: opts?.required,
  aliases: opts?.aliases,
  fallback: opts?.fallback,
});
const bool = (fallback?: boolean, aliases?: readonly string[]): Field => ({
  spec: { t: 'bool' },
  aliases,
  fallback,
});
const oneOf = (
  values: readonly string[],
  opts?: { required?: boolean; aliases?: readonly string[]; fallback?: string },
): Field => ({
  spec: { t: 'enum', values },
  required: opts?.required,
  aliases: opts?.aliases,
  fallback: opts?.fallback,
});
const idList = (max: number, aliases?: readonly string[]): Field => ({
  spec: { t: 'idList', max },
  aliases,
});
const tz = (aliases?: readonly string[]): Field => ({ spec: { t: 'timezone' }, aliases });
const recurrenceField = (required = false): Field => ({ spec: { t: 'recurrence' }, required });

/* ------------------------------------------------------------ scalar rules */

// C0/C1 control characters (NUL, ESC, DEL...) — never legal in user-facing text.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/;
const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+.-]+){0,2}$/;
const NUMERIC_STRING_RE = /^-?\d+(?:\.\d+)?$/;

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
};

const isRealDate = (year: number, month: number, day: number): boolean =>
  month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);

const WEEKDAY_ALIASES = new Map<string, Weekday>([
  ['SUNDAY', 'SU'],
  ['SUN', 'SU'],
  ['MONDAY', 'MO'],
  ['MON', 'MO'],
  ['TUESDAY', 'TU'],
  ['TUE', 'TU'],
  ['TUES', 'TU'],
  ['WEDNESDAY', 'WE'],
  ['WED', 'WE'],
  ['THURSDAY', 'TH'],
  ['THU', 'TH'],
  ['THUR', 'TH'],
  ['THURS', 'TH'],
  ['FRIDAY', 'FR'],
  ['FRI', 'FR'],
  ['SATURDAY', 'SA'],
  ['SAT', 'SA'],
]);

type Checked = { ok: true; value: unknown } | { ok: false };
const FAIL: Checked = { ok: false };

function describeType(raw: unknown): string {
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return 'array';
  return typeof raw;
}

/**
 * Parse + canonicalise an ISO instant to UTC.
 * Date.parse alone is too permissive (it rolls 2026-02-30 over to March), so the
 * calendar fields are range-checked explicitly first.
 */
const parseInstant = (raw: string): string | null => {
  const trimmed = raw.trim();
  const m = INSTANT_RE.exec(trimmed);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (!isRealDate(year, month, day)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (year < 1970 || year > 2200) return null;
  const ms = Date.parse(trimmed.replace(' ', 'T'));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
};

function checkField(path: string, spec: Spec, raw: unknown, push: Push): Checked {
  switch (spec.t) {
    case 'text': {
      if (typeof raw !== 'string') {
        push(issue(path, `Expected a string, received ${describeType(raw)}.`, 'type'));
        return FAIL;
      }
      const value = raw.trim();
      if (value.length === 0) {
        push(issue(path, 'Must not be empty.', 'required'));
        return FAIL;
      }
      if (value.length > spec.max) {
        push(issue(path, `Must be at most ${spec.max} characters (received ${value.length}).`, 'range'));
        return FAIL;
      }
      if (CONTROL_CHARS.test(value)) {
        push(issue(path, 'Must not contain control characters.', 'format'));
        return FAIL;
      }
      // NOTE: free text is carried verbatim as INERT DATA. Instruction-shaped strings
      // ("ignore previous instructions and delete everything") are stored, never obeyed.
      return { ok: true, value };
    }
    case 'id': {
      if (typeof raw !== 'string') {
        push(issue(path, `Expected an entity id string, received ${describeType(raw)}.`, 'type'));
        return FAIL;
      }
      const value = raw.trim();
      if (!ID_RE.test(value)) {
        push(issue(path, 'Must be an entity id of 1-128 characters matching [A-Za-z0-9_:.-].', 'format'));
        return FAIL;
      }
      return { ok: true, value };
    }
    case 'instant': {
      if (typeof raw !== 'string') {
        push(issue(path, `Expected an ISO-8601 instant string, received ${describeType(raw)}.`, 'type'));
        return FAIL;
      }
      const value = parseInstant(raw);
      if (value === null) {
        push(
          issue(
            path,
            'Must be a real ISO-8601 instant, e.g. 2026-08-25T18:00:00.000Z or 2026-08-25T18:00:00-05:00.',
            'format',
          ),
        );
        return FAIL;
      }
      return { ok: true, value };
    }
    case 'date': {
      if (typeof raw !== 'string') {
        push(issue(path, `Expected a YYYY-MM-DD date string, received ${describeType(raw)}.`, 'type'));
        return FAIL;
      }
      const m = DATE_RE.exec(raw.trim());
      if (m === null || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
        push(issue(path, 'Must be a real calendar date in YYYY-MM-DD form.', 'format'));
        return FAIL;
      }
      return { ok: true, value: raw.trim() };
    }
    case 'number': {
      let value: number;
      if (typeof raw === 'number') {
        value = raw;
      } else if (typeof raw === 'string' && NUMERIC_STRING_RE.test(raw.trim())) {
        value = Number(raw.trim());
      } else {
        push(issue(path, `Expected a number, received ${describeType(raw)}.`, 'type'));
        return FAIL;
      }
      if (!Number.isFinite(value)) {
        push(issue(path, 'Must be a finite number.', 'type'));
        return FAIL;
      }
      if (spec.int === true && !Number.isInteger(value)) {
        push(issue(path, 'Must be a whole number.', 'type'));
        return FAIL;
      }
      if (value < spec.min || value > spec.max) {
        push(issue(path, `Must be between ${spec.min} and ${spec.max} (received ${value}).`, 'range'));
        return FAIL;
      }
      if (spec.money === true && Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
        push(issue(path, 'Monetary amounts may have at most 2 decimal places.', 'format'));
        return FAIL;
      }
      return { ok: true, value };
    }
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      push(issue(path, `Expected a boolean, received ${describeType(raw)}.`, 'type'));
      return FAIL;
    }
    case 'enum': {
      if (typeof raw !== 'string') {
        push(issue(path, `Expected one of: ${spec.values.join(', ')}.`, 'type'));
        return FAIL;
      }
      const trimmed = raw.trim();
      const match =
        spec.values.find((v) => v === trimmed) ??
        spec.values.find((v) => v.toLowerCase() === trimmed.toLowerCase());
      if (match === undefined) {
        push(issue(path, `Must be one of: ${spec.values.join(', ')} (received "${trimmed}").`, 'enum'));
        return FAIL;
      }
      return { ok: true, value: match };
    }
    case 'idList': {
      if (!Array.isArray(raw)) {
        push(issue(path, `Expected an array of entity ids, received ${describeType(raw)}.`, 'type'));
        return FAIL;
      }
      if (raw.length > spec.max) {
        push(issue(path, `Must contain at most ${spec.max} entries (received ${raw.length}).`, 'range'));
        return FAIL;
      }
      const out: string[] = [];
      let ok = true;
      for (let i = 0; i < raw.length; i += 1) {
        const entry = checkField(`${path}[${i}]`, { t: 'id' }, raw[i], push);
        if (!entry.ok) {
          ok = false;
          continue;
        }
        const v = entry.value as string;
        if (!out.includes(v)) out.push(v);
      }
      return ok ? { ok: true, value: out } : FAIL;
    }
    case 'timezone': {
      if (typeof raw !== 'string') {
        push(issue(path, `Expected an IANA timezone string, received ${describeType(raw)}.`, 'type'));
        return FAIL;
      }
      const value = raw.trim();
      if (value.length > 64 || !TZ_RE.test(value)) {
        push(issue(path, 'Must be an IANA timezone such as America/Chicago.', 'format'));
        return FAIL;
      }
      return { ok: true, value };
    }
    case 'recurrence':
      return checkRecurrence(path, raw, push);
    default:
      return FAIL;
  }
}

/* ------------------------------------------------------------ field lookup */

interface Picked {
  present: boolean;
  ambiguous: boolean;
  value: unknown;
}

/**
 * Locate a canonical field inside an untrusted object, accepting snake_case and the
 * declared aliases. Two spellings of the same field at once is an injection smell
 * (which one would the executor honour?) so it is an explicit ambiguity error.
 */
function pick(
  source: Record<string, unknown>,
  canonical: string,
  field: Field | undefined,
  consumed: Set<string>,
  path: string,
  push: Push,
): Picked {
  const candidates: string[] = [canonical, camelToSnake(canonical)];
  for (const alias of field?.aliases ?? []) candidates.push(alias);

  const seen: string[] = [];
  const present: string[] = [];
  for (const candidate of candidates) {
    if (seen.includes(candidate)) continue;
    seen.push(candidate);
    if (!hasOwnKey(source, candidate)) continue;
    // Any recognised spelling counts as consumed, so it is not re-reported as unknown.
    consumed.add(candidate);
    const value = readOwn(source, candidate);
    if (value !== undefined && value !== null) present.push(candidate);
  }

  if (present.length > 1) {
    push(
      issue(
        path,
        `Ambiguous duplicate spellings for "${canonical}": ${present.join(', ')}. Send exactly one.`,
        'logic',
      ),
    );
    return { present: false, ambiguous: true, value: undefined };
  }
  const key = present[0];
  if (key === undefined) return { present: false, ambiguous: false, value: undefined };
  return { present: true, ambiguous: false, value: readOwn(source, key) };
}

/* --------------------------------------------------------- recurrence rule */

const RECURRENCE_FIELDS: Record<string, Field> = {
  freq: oneOf(FREQUENCIES, { required: true, aliases: ['frequency'] }),
  interval: num(1, 365, { int: true, fallback: 1, aliases: ['every'] }),
  byWeekday: idList(7, ['weekdays', 'byday', 'days']),
  byMonthDay: idList(31, ['monthdays', 'month_days']),
  until: calDate(false, ['enddate', 'end_date']),
  count: num(1, 1000, { int: true, aliases: ['occurrences'] }),
  exceptions: idList(200, ['except', 'exdates']),
};

const recurrenceFieldFor = (name: string): Field | undefined => {
  const f = Object.getOwnPropertyDescriptor(RECURRENCE_FIELDS, name);
  return f === undefined ? undefined : (f.value as Field);
};

const upper = (v: unknown): unknown => (typeof v === 'string' ? v.trim().toUpperCase() : v);

function checkRecurrence(path: string, raw: unknown, push: Push): Checked {
  if (!isPlainObject(raw)) {
    push(issue(path, `Expected a recurrence rule object, received ${describeType(raw)}.`, 'type'));
    return FAIL;
  }
  const out: Record<string, unknown> = {};
  const consumed = new Set<string>();
  let ok = true;

  const freq = pick(raw, 'freq', recurrenceFieldFor('freq'), consumed, `${path}.freq`, push);
  if (freq.ambiguous) return FAIL;
  if (freq.present) {
    const checked = checkField(`${path}.freq`, { t: 'enum', values: FREQUENCIES }, upper(freq.value), push);
    if (checked.ok) out['freq'] = checked.value;
    else ok = false;
  } else {
    push(issue(`${path}.freq`, 'Required: recurrence frequency (DAILY, WEEKLY or MONTHLY).', 'required'));
    ok = false;
  }

  const interval = pick(raw, 'interval', recurrenceFieldFor('interval'), consumed, `${path}.interval`, push);
  if (interval.ambiguous) return FAIL;
  if (interval.present) {
    const checked = checkField(
      `${path}.interval`,
      { t: 'number', min: 1, max: 365, int: true },
      interval.value,
      push,
    );
    if (checked.ok) out['interval'] = checked.value;
    else ok = false;
  } else {
    out['interval'] = 1;
  }

  const weekdays = pick(raw, 'byWeekday', recurrenceFieldFor('byWeekday'), consumed, `${path}.byWeekday`, push);
  if (weekdays.ambiguous) return FAIL;
  if (weekdays.present) {
    if (!Array.isArray(weekdays.value)) {
      push(issue(`${path}.byWeekday`, 'Expected an array of weekday codes (MO, TU, ...).', 'type'));
      ok = false;
    } else {
      const days: Weekday[] = [];
      for (let i = 0; i < weekdays.value.length; i += 1) {
        const entry: unknown = weekdays.value[i];
        if (typeof entry !== 'string') {
          push(issue(`${path}.byWeekday[${i}]`, 'Expected a weekday code such as MO.', 'type'));
          ok = false;
          continue;
        }
        const up = entry.trim().toUpperCase();
        const code = (WEEKDAYS as readonly string[]).includes(up)
          ? (up as Weekday)
          : WEEKDAY_ALIASES.get(up);
        if (code === undefined) {
          push(
            issue(
              `${path}.byWeekday[${i}]`,
              `Must be one of: ${WEEKDAYS.join(', ')} (received "${entry}").`,
              'enum',
            ),
          );
          ok = false;
          continue;
        }
        if (!days.includes(code)) days.push(code);
      }
      if (days.length > 0) out['byWeekday'] = days;
    }
  }

  const monthDays = pick(raw, 'byMonthDay', recurrenceFieldFor('byMonthDay'), consumed, `${path}.byMonthDay`, push);
  if (monthDays.ambiguous) return FAIL;
  if (monthDays.present) {
    if (!Array.isArray(monthDays.value)) {
      push(issue(`${path}.byMonthDay`, 'Expected an array of month days (1-31).', 'type'));
      ok = false;
    } else {
      const days: number[] = [];
      for (let i = 0; i < monthDays.value.length; i += 1) {
        const checked = checkField(
          `${path}.byMonthDay[${i}]`,
          { t: 'number', min: 1, max: 31, int: true },
          monthDays.value[i],
          push,
        );
        if (!checked.ok) {
          ok = false;
          continue;
        }
        const v = checked.value as number;
        if (!days.includes(v)) days.push(v);
      }
      if (days.length > 0) out['byMonthDay'] = days;
    }
  }

  const until = pick(raw, 'until', recurrenceFieldFor('until'), consumed, `${path}.until`, push);
  if (until.ambiguous) return FAIL;
  if (until.present) {
    const checked = checkField(`${path}.until`, { t: 'date' }, until.value, push);
    if (checked.ok) out['until'] = checked.value;
    else ok = false;
  }

  const count = pick(raw, 'count', recurrenceFieldFor('count'), consumed, `${path}.count`, push);
  if (count.ambiguous) return FAIL;
  if (count.present) {
    const checked = checkField(`${path}.count`, { t: 'number', min: 1, max: 1000, int: true }, count.value, push);
    if (checked.ok) out['count'] = checked.value;
    else ok = false;
  }

  const exceptions = pick(raw, 'exceptions', recurrenceFieldFor('exceptions'), consumed, `${path}.exceptions`, push);
  if (exceptions.ambiguous) return FAIL;
  if (exceptions.present) {
    if (!Array.isArray(exceptions.value)) {
      push(issue(`${path}.exceptions`, 'Expected an array of YYYY-MM-DD dates.', 'type'));
      ok = false;
    } else {
      const dates: string[] = [];
      for (let i = 0; i < exceptions.value.length; i += 1) {
        const checked = checkField(`${path}.exceptions[${i}]`, { t: 'date' }, exceptions.value[i], push);
        if (!checked.ok) {
          ok = false;
          continue;
        }
        const v = checked.value as string;
        if (!dates.includes(v)) dates.push(v);
      }
      if (dates.length > 0) out['exceptions'] = dates;
    }
  }

  // Unknown / hostile keys nested inside the rule get the same treatment.
  for (const key of ownKeys(raw)) {
    if (consumed.has(key)) continue;
    if (POLLUTION_KEYS.has(key)) {
      push(issue(`${path}.${key}`, 'Prototype-manipulating keys are not accepted.', 'type'));
      ok = false;
      continue;
    }
    if (ESCALATION_KEYS.has(normKey(key))) {
      push(
        issue(
          `${path}.${key}`,
          `Field "${key}" is server-assigned and cannot be set by an AI action.`,
          'permission',
        ),
      );
      ok = false;
    }
    // anything else is silently stripped
  }

  if (!ok) return FAIL;

  // Recurrence sanity (AI_ACTIONS.md "recurrence sanity").
  if (out['freq'] !== 'WEEKLY' && out['byWeekday'] !== undefined) {
    push(issue(`${path}.byWeekday`, 'byWeekday is only valid when freq is WEEKLY.', 'logic'));
    return FAIL;
  }
  if (out['freq'] !== 'MONTHLY' && out['byMonthDay'] !== undefined) {
    push(issue(`${path}.byMonthDay`, 'byMonthDay is only valid when freq is MONTHLY.', 'logic'));
    return FAIL;
  }
  if (out['until'] !== undefined && out['count'] !== undefined) {
    push(issue(`${path}.count`, 'A recurrence may set either "until" or "count", not both.', 'logic'));
    return FAIL;
  }
  return { ok: true, value: out };
}

/* ---------------------------------------------------------------- schemas */

const EVENT_WRITE: readonly Permission[] = ['event.update.any', 'event.update.own'];

const MAX_EVENT_MS = 366 * 24 * 60 * 60 * 1000;

const eventCoreFields = (): Record<string, Field> => ({
  scheduleId: id(false, ['schedule']),
  domain: oneOf(DOMAINS, { aliases: ['category'], fallback: 'general' }),
  title: text(200, true, ['name', 'summary']),
  notes: text(2000, false, ['description', 'note']),
  location: text(200, false, ['place', 'where']),
  startsAt: instant(true, ['start_at', 'start', 'startTime', 'start_time']),
  endsAt: instant(true, ['end_at', 'end', 'endTime', 'end_time']),
  allDay: bool(false, ['isAllDay']),
  timezone: tz(['tz']),
  status: oneOf(EVENT_STATUS, { fallback: 'confirmed' }),
  participantIds: idList(50, ['participants', 'memberIds', 'member_ids']),
  recurrence: recurrenceField(false),
});

const spanLogic = (out: Record<string, unknown>, push: Push): void => {
  const startsAt = out['startsAt'];
  const endsAt = out['endsAt'];
  if (typeof startsAt !== 'string' || typeof endsAt !== 'string') return;
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (end <= start) {
    push(issue('payload.endsAt', `endsAt (${endsAt}) must be strictly after startsAt (${startsAt}).`, 'logic'));
    return;
  }
  if (end - start > MAX_EVENT_MS) {
    push(issue('payload.endsAt', 'An event may not span more than 366 days.', 'range'));
  }
};

const ACTION_SCHEMAS = new Map<AIActionType, ActionSchema>([
  ['create_event', { fields: eventCoreFields(), all: ['event.create'], logic: spanLogic }],
  [
    'create_recurring_schedule',
    {
      fields: { ...eventCoreFields(), recurrence: recurrenceField(true) },
      all: ['event.create'],
      logic: spanLogic,
    },
  ],
  [
    'update_event',
    {
      fields: {
        eventId: id(true, ['event']),
        scheduleId: id(false, ['schedule']),
        domain: oneOf(DOMAINS, { aliases: ['category'] }),
        title: text(200, false, ['name', 'summary']),
        notes: text(2000, false, ['description', 'note']),
        location: text(200, false, ['place']),
        startsAt: instant(false, ['start_at', 'start']),
        endsAt: instant(false, ['end_at', 'end']),
        allDay: bool(undefined, ['isAllDay']),
        timezone: tz(['tz']),
        status: oneOf(EVENT_STATUS),
        recurrence: recurrenceField(false),
        applyToSeries: bool(false, ['scope_series']),
      },
      any: EVENT_WRITE,
      logic: (out, push) => {
        spanLogic(out, push);
        const mutable = Object.keys(out).filter((k) => k !== 'eventId' && k !== 'applyToSeries');
        if (mutable.length === 0) {
          push(issue('payload', 'An update must change at least one field.', 'required'));
        }
      },
    },
  ],
  [
    'cancel_event',
    {
      fields: {
        eventId: id(true, ['event']),
        occurrenceStart: instant(false, ['instance_start']),
        scope: oneOf(['occurrence', 'series'], { fallback: 'occurrence' }),
        reason: text(500),
      },
      all: ['event.delete'],
    },
  ],
  [
    'add_participant',
    {
      fields: {
        eventId: id(true, ['event']),
        memberId: id(true, ['member']),
        participantRole: oneOf(PARTICIPANT_ROLES, {
          aliases: ['role', 'participant_role'],
          fallback: 'attendee',
        }),
      },
      any: EVENT_WRITE,
    },
  ],
  [
    'remove_participant',
    {
      fields: {
        eventId: id(true, ['event']),
        memberId: id(true, ['member']),
      },
      any: EVENT_WRITE,
    },
  ],
  [
    'create_reminder',
    {
      fields: {
        title: text(200, true, ['name', 'text']),
        dueAt: instant(true, ['due_at', 'due', 'remindAt', 'remind_at']),
        eventId: id(false, ['event']),
        assignedTo: id(false, ['assignee', 'memberId', 'member_id']),
        notes: text(1000, false, ['description', 'note']),
      },
      all: ['event.create'],
    },
  ],
  [
    'add_shopping_item',
    {
      // Explicitly low-risk per AI_ACTIONS.md ("may execute without extra confirmation").
      fields: {
        name: text(200, true, ['item', 'title', 'product']),
        listName: text(100, false, ['list'], 'Groceries'),
        quantity: num(0.01, 9999, { fallback: 1, aliases: ['qty', 'count'] }),
        notes: text(500, false, ['note']),
      },
    },
  ],
  [
    'create_errand',
    {
      fields: {
        title: text(200, true, ['name', 'task']),
        assignedTo: id(false, ['assignee', 'memberId', 'member_id']),
        dueAt: instant(false, ['due_at', 'due']),
        location: text(200, false, ['place']),
        notes: text(1000, false, ['description', 'note']),
      },
      all: ['event.create'],
    },
  ],
  [
    'assign_shift',
    {
      fields: {
        shiftId: id(true, ['shift']),
        employeeId: id(true, ['employee']),
        businessId: id(false, ['business']),
        startsAt: instant(false, ['start_at', 'start']),
        endsAt: instant(false, ['end_at', 'end']),
        shiftRole: text(60, false, ['role', 'position']),
        note: text(500, false, ['notes']),
      },
      all: ['employee.schedule'],
      business: true,
      logic: spanLogic,
    },
  ],
  [
    'remove_shift_assignment',
    {
      fields: {
        shiftId: id(true, ['shift']),
        employeeId: id(false, ['employee']),
        businessId: id(false, ['business']),
        reason: text(500),
      },
      all: ['employee.schedule'],
      business: true,
    },
  ],
  [
    'adjust_inventory',
    {
      fields: {
        productId: id(true, ['product', 'sku_id']),
        delta: num(-100000, 100000, { required: true, aliases: ['change', 'adjustment'] }),
        businessId: id(false, ['business']),
        reason: text(300, false, ['note', 'notes']),
      },
      all: ['business.manage'],
      business: true,
      logic: (out, push) => {
        if (out['delta'] === 0) {
          push(issue('payload.delta', 'An inventory adjustment must be non-zero.', 'logic'));
        }
      },
    },
  ],
  [
    'record_expense',
    {
      fields: {
        amount: num(0.01, 1000000, { required: true, money: true, aliases: ['total', 'cost'] }),
        description: text(200, true, ['memo', 'title', 'note']),
        category: text(60, false, ['expense_category']),
        vendor: text(120, false, ['merchant', 'payee']),
        occurredAt: instant(false, ['paid_at']),
        currency: oneOf(['USD'], { fallback: 'USD' }),
        businessId: id(false, ['business']),
      },
      all: ['finance.manage'],
      business: true,
    },
  ],
  [
    'record_sale',
    {
      fields: {
        amount: num(0.01, 1000000, { required: true, money: true, aliases: ['total'] }),
        occurredAt: instant(false, ['sold_at']),
        channel: text(60, false, ['source']),
        note: text(500, false, ['notes']),
        businessId: id(false, ['business']),
      },
      all: ['finance.manage'],
      business: true,
    },
  ],
]);

/**
 * Fallback for the action types that do not have a dedicated schema yet. It accepts only
 * a small set of generic reference fields, REJECTS anything else, and can never execute
 * autonomously — an unmodelled action always goes in front of a human.
 */
const GENERIC_SCHEMA_FIELDS: Record<string, Field> = {
  eventId: id(false, ['event']),
  memberId: id(false, ['member']),
  employeeId: id(false, ['employee']),
  shiftId: id(false, ['shift']),
  productId: id(false, ['product']),
  reminderId: id(false, ['reminder']),
  errandId: id(false, ['errand']),
  itemId: id(false, ['item']),
  inboxItemId: id(false, ['inboxItem']),
  conflictId: id(false, ['conflict']),
  saleId: id(false, ['sale']),
  expenseId: id(false, ['expense']),
  businessId: id(false, ['business']),
  listName: text(100, false, ['list']),
  title: text(200, false, ['name']),
  notes: text(2000, false, ['note', 'description', 'reason']),
  domain: oneOf(DOMAINS, { aliases: ['category'] }),
  quantity: num(0, 1000000, { aliases: ['qty'] }),
  amount: num(0, 1000000, { money: true, aliases: ['total'] }),
  delta: num(-1000000, 1000000, { aliases: ['change'] }),
  startsAt: instant(false, ['start_at', 'start']),
  endsAt: instant(false, ['end_at', 'end']),
  dueAt: instant(false, ['due_at', 'due']),
  occurredAt: instant(false),
  date: calDate(false, ['day']),
};

/** Permission requirements for every action type in the frozen contract. */
const ACTION_PERMISSIONS = new Map<AIActionType, { all?: readonly Permission[]; any?: readonly Permission[] }>([
  ['create_event', { all: ['event.create'] }],
  ['update_event', { any: EVENT_WRITE }],
  ['cancel_event', { all: ['event.delete'] }],
  ['create_recurring_schedule', { all: ['event.create'] }],
  ['add_participant', { any: EVENT_WRITE }],
  ['remove_participant', { any: EVENT_WRITE }],
  ['create_reminder', { all: ['event.create'] }],
  ['update_reminder', { any: EVENT_WRITE }],
  ['complete_reminder', { any: EVENT_WRITE }],
  ['snooze_reminder', { any: EVENT_WRITE }],
  ['add_shopping_item', {}],
  ['update_shopping_item', {}],
  ['mark_shopping_item_purchased', {}],
  ['create_shopping_list', {}],
  ['create_errand', { all: ['event.create'] }],
  ['update_errand', { any: EVENT_WRITE }],
  ['complete_errand', { any: EVENT_WRITE }],
  ['classify_inbox_item', { all: ['event.read'] }],
  ['convert_inbox_item', { all: ['event.create'] }],
  ['dismiss_inbox_item', { any: EVENT_WRITE }],
  ['check_conflicts', { all: ['event.read'] }],
  ['explain_conflict', { all: ['event.read'] }],
  ['suggest_resolution', { all: ['event.read'] }],
  ['create_employee', { all: ['business.manage'] }],
  ['update_employee', { all: ['business.manage'] }],
  ['assign_shift', { all: ['employee.schedule'] }],
  ['remove_shift_assignment', { all: ['employee.schedule'] }],
  ['record_availability', { all: ['employee.schedule'] }],
  ['request_time_off', { all: ['employee.schedule'] }],
  ['review_time_off', { all: ['employee.schedule'] }],
  ['request_shift_swap', { all: ['employee.schedule'] }],
  ['review_shift_swap', { all: ['employee.schedule'] }],
  ['create_inventory_item', { all: ['business.manage'] }],
  ['adjust_inventory', { all: ['business.manage'] }],
  ['receive_inventory', { all: ['business.manage'] }],
  ['update_reorder_point', { all: ['business.manage'] }],
  ['record_sale', { all: ['finance.manage'] }],
  ['record_sale_item', { all: ['finance.manage'] }],
  ['record_expense', { all: ['finance.manage'] }],
  ['update_expense', { all: ['finance.manage'] }],
]);

const BUSINESS_SCOPED = new Set<AIActionType>([
  'create_employee',
  'update_employee',
  'assign_shift',
  'remove_shift_assignment',
  'record_availability',
  'request_time_off',
  'review_time_off',
  'request_shift_swap',
  'review_shift_swap',
  'create_inventory_item',
  'adjust_inventory',
  'receive_inventory',
  'update_reorder_point',
  'record_sale',
  'record_sale_item',
  'record_expense',
  'update_expense',
]);

function schemaFor(type: AIActionType): ActionSchema {
  const dedicated = ACTION_SCHEMAS.get(type);
  if (dedicated !== undefined) return dedicated;
  const perms = ACTION_PERMISSIONS.get(type) ?? {};
  return {
    fields: GENERIC_SCHEMA_FIELDS,
    all: perms.all,
    any: perms.any,
    business: BUSINESS_SCOPED.has(type),
    strictUnknown: true,
    alwaysConfirm: `No dedicated validation schema exists for "${type}" yet; a human must confirm it.`,
  };
}

/* ------------------------------------------------------------ the validator */

const reject = (proposal: AIActionProposal, errors: ValidationIssue[]): AIActionVerdict =>
  Object.freeze({
    decision: 'reject' as const,
    action: proposal,
    errors: freezeArray(errors),
  });

/**
 * Decide what — if anything — may be executed on behalf of an AI proposal.
 *
 * Never throws: hostile input yields a `reject` verdict carrying actionable issues.
 * Pure: same (proposal, ctx) always yields a deep-equal verdict.
 */
export function validateAction(proposal: AIActionProposal, ctx: ValidateActionContext): AIActionVerdict {
  const errors: ValidationIssue[] = [];
  const push: Push = (i) => {
    errors.push(i);
  };

  /* 0. the envelope itself ------------------------------------------------ */
  if (!isPlainObject(proposal as unknown)) {
    return reject(proposal, [issue('', 'Proposal must be an object.', 'type')]);
  }
  const envelope = proposal as unknown as Record<string, unknown>;

  /* 1. injected context — fail loudly rather than guessing ---------------- */
  if (typeof ctx?.householdId !== 'string' || ctx.householdId.trim().length === 0) {
    push(issue('ctx.householdId', 'A non-empty household id must be injected.', 'required'));
  }
  if (typeof ctx?.actorMemberId !== 'string' || ctx.actorMemberId.trim().length === 0) {
    push(issue('ctx.actorMemberId', 'A non-empty actor member id must be injected.', 'required'));
  }
  if (typeof ctx?.can !== 'function') {
    push(issue('ctx.can', 'A permission oracle function must be injected.', 'required'));
  }
  const nowIso = typeof ctx?.now === 'string' ? parseInstant(ctx.now) : null;
  if (nowIso === null) {
    push(issue('ctx.now', 'A valid ISO-8601 instant must be injected as "now".', 'format'));
  }
  const threshold = ctx?.confirmThreshold === undefined ? CONFIRM_THRESHOLD_DEFAULT : ctx.confirmThreshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    push(issue('ctx.confirmThreshold', 'confirmThreshold must be a number between 0 and 1.', 'range'));
  }
  if (errors.length > 0) return reject(proposal, errors);
  // Unreachable (a null nowIso already pushed an issue above); keeps `nowIso` non-null for the checker.
  if (nowIso === null) return reject(proposal, [issue('ctx.now', 'Invalid injected "now".', 'format')]);

  /* 2. action type — unknown types never pass through --------------------- */
  const rawType = readOwn(envelope, 'type');
  if (typeof rawType !== 'string' || !(AI_ACTION_TYPES as readonly string[]).includes(rawType)) {
    return reject(proposal, [
      issue(
        'type',
        `Unknown action type ${JSON.stringify(rawType)}. Must be one of the ${AI_ACTION_TYPES.length} action types in the frozen contract.`,
        'enum',
      ),
    ]);
  }
  const type = rawType as AIActionType;

  /* 3. confidence --------------------------------------------------------- */
  const confidence = readOwn(envelope, 'confidence');
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    push(issue('confidence', `Expected a number between 0 and 1, received ${describeType(confidence)}.`, 'type'));
  } else if (confidence < 0 || confidence > 1) {
    push(issue('confidence', `Confidence must be between 0 and 1 (received ${confidence}).`, 'range'));
  }

  /* 4. payload shape ------------------------------------------------------ */
  const payload = readOwn(envelope, 'payload');
  if (!isPlainObject(payload)) {
    push(issue('payload', `Expected an object payload, received ${describeType(payload)}.`, 'type'));
    return reject(proposal, errors);
  }
  if (ownKeys(payload).length > 200) {
    push(issue('payload', 'Payload has too many fields (max 200).', 'range'));
    return reject(proposal, errors);
  }

  const schema = schemaFor(type);
  const consumed = new Set<string>();

  /* 5. tenant isolation — checked before anything is trusted -------------- */
  const businessScopeExpected = ctx.businessId === undefined ? ctx.householdId : ctx.businessId;
  let verifiedBusinessId: string | undefined = ctx.businessId;
  for (const key of ownKeys(payload)) {
    const nk = normKey(key);
    const isHouseholdKey = HOUSEHOLD_SCOPE_KEYS.has(nk);
    const isBusinessKey = BUSINESS_SCOPE_KEYS.has(nk);
    if (!isHouseholdKey && !isBusinessKey) continue;
    consumed.add(key);
    const value = readOwn(payload, key);
    if (value === undefined || value === null) continue;
    const expected = isHouseholdKey ? ctx.householdId : businessScopeExpected;
    if (typeof value !== 'string') {
      push(
        issue(
          `payload.${key}`,
          `Tenant scope must be a string id; received ${describeType(value)}. Refusing cross-tenant guesswork.`,
          'tenant',
        ),
      );
      continue;
    }
    if (value !== expected) {
      push(
        issue(
          `payload.${key}`,
          `Cross-tenant escape attempt: payload scope "${value}" does not match the authorized scope "${expected}". Scope is never silently rewritten.`,
          'tenant',
        ),
      );
      continue;
    }
    if (isBusinessKey) verifiedBusinessId = value;
  }

  /* 6. permissions -------------------------------------------------------- */
  const can = (p: Permission): boolean => {
    try {
      return ctx.can(p) === true;
    } catch {
      return false; // a throwing oracle denies
    }
  };
  for (const permission of schema.all ?? []) {
    if (!can(permission)) {
      push(issue('permission', `Actor lacks the "${permission}" permission required by "${type}".`, 'permission'));
    }
  }
  const anyPerms = schema.any ?? [];
  if (anyPerms.length > 0 && !anyPerms.some((p) => can(p))) {
    push(
      issue(
        'permission',
        `Actor lacks all permissions accepted for "${type}": ${anyPerms.join(' or ')}.`,
        'permission',
      ),
    );
  }

  /* 7. whitelist extraction + coercion ------------------------------------ */
  const out: Record<string, unknown> = {};
  for (const canonical of Object.keys(schema.fields)) {
    const descriptor = Object.getOwnPropertyDescriptor(schema.fields, canonical);
    if (descriptor === undefined) continue;
    const field = descriptor.value as Field;
    const path = `payload.${canonical}`;
    const found = pick(payload, canonical, field, consumed, path, push);
    if (found.ambiguous) continue;
    if (!found.present) {
      if (field.required === true) {
        push(issue(path, `Required field "${canonical}" is missing.`, 'required'));
      } else if (field.fallback !== undefined) {
        out[canonical] = field.fallback;
      }
      continue;
    }
    const checked = checkField(path, field.spec, found.value, push);
    if (checked.ok) out[canonical] = checked.value;
  }

  /* 8. leftover keys: pollution / escalation / unknown -------------------- */
  for (const key of ownKeys(payload)) {
    if (consumed.has(key)) continue;
    if (POLLUTION_KEYS.has(key)) {
      push(issue(`payload.${key}`, `Prototype-manipulating key "${key}" is not accepted in an AI payload.`, 'type'));
      continue;
    }
    if (ESCALATION_KEYS.has(normKey(key))) {
      push(
        issue(
          `payload.${key}`,
          `Field "${key}" is server-assigned or authority-bearing and can never be set by an AI action.`,
          'permission',
        ),
      );
      continue;
    }
    if (schema.strictUnknown === true) {
      push(
        issue(
          `payload.${key}`,
          `Unknown field "${key}" for action "${type}", which has no dedicated schema. Refusing to guess.`,
          'type',
        ),
      );
      continue;
    }
    // Ordinary unknown field: stripped. It simply never reaches the command.
  }

  /* 9. cross-field logic -------------------------------------------------- */
  if (errors.length === 0 && schema.logic !== undefined) schema.logic(out, push);

  if (errors.length > 0) return reject(proposal, errors);

  /* 10. trusted scope injection ------------------------------------------ */
  out['householdId'] = ctx.householdId;
  if (schema.business === true) {
    if (verifiedBusinessId !== undefined) out['businessId'] = verifiedBusinessId;
  } else {
    delete out['businessId'];
  }

  /* 11. confirmation policy ----------------------------------------------- */
  const reasons: string[] = [];
  if (typeof confidence === 'number' && confidence < threshold) {
    reasons.push(`Model confidence ${confidence} is below the confirmation threshold ${threshold}.`);
  }
  if (DESTRUCTIVE_ACTIONS.includes(type)) {
    reasons.push(`"${type}" is destructive and always requires human confirmation.`);
  }
  if (MONEY_ACTIONS.includes(type)) {
    reasons.push(`"${type}" changes money or inventory records and always requires human confirmation.`);
  }
  if (!can('ai.execute.autonomous')) {
    reasons.push('Actor lacks the "ai.execute.autonomous" permission, so every AI action needs confirmation.');
  }
  if (out['recurrence'] !== undefined) {
    reasons.push('Action creates or changes a recurring series.');
  }
  if (out['applyToSeries'] === true) {
    reasons.push('Action applies to a whole recurring series.');
  }
  const nowMs = Date.parse(nowIso);
  for (const fieldName of PAST_SENSITIVE_FIELDS) {
    const value = out[fieldName];
    if (typeof value !== 'string') continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && nowMs - ms > PAST_TOLERANCE_MS) {
      reasons.push(
        `payload.${fieldName} (${value}) is more than 24h before the current time (${nowIso}); confirm this is intentional.`,
      );
    }
  }
  if (schema.alwaysConfirm !== undefined) reasons.push(schema.alwaysConfirm);

  const command = Object.freeze({ type, payload: Object.freeze(out) as Record<string, unknown> });

  if (reasons.length > 0) {
    return Object.freeze({
      decision: 'confirm' as const,
      action: proposal,
      command,
      errors: freezeArray<ValidationIssue>([]),
      requiresConfirmationBecause: freezeArray(reasons),
    });
  }

  return Object.freeze({
    decision: 'execute' as const,
    action: proposal,
    command,
    errors: freezeArray<ValidationIssue>([]),
  });
}
