/**
 * Michel-OS — Personal organization (Agent I).
 *
 * PRODUCT_SPEC §3 draws a line that the UI must never blur, so this module
 * encodes it:
 *
 *   Shopping   things to BUY.       "we need milk"
 *   Errands    trips to TAKE.       "return the package"
 *   Reminders  things to REMEMBER.  "call the insurance company"
 *
 * The three share one shape of decision — a state machine plus an authorization
 * check — so they share one implementation, not three near-copies that drift.
 *
 * Design rules, all of them load-bearing:
 *
 *   - Every mutation goes through `authorize()` from the household kernel.
 *     This module never decides access itself; contract v1.1 gave reminders
 *     their own verbs (CR-001) precisely so that it would not have to.
 *   - Pure. Every function takes the current row and returns the next one.
 *     No clock, no ids invented here: the caller injects `now` and any new id,
 *     because a hidden clock makes an audit log a lie.
 *   - Transitions are a table, not a pile of `if`s. An illegal transition is a
 *     rejected `Result`, never a silently-ignored no-op — "mark purchased"
 *     twice must not look like success the second time.
 *   - Nothing is deleted. `removed` / `cancelled` / `dismissed` are terminal
 *     states, so a shared family list keeps its history.
 */

import { authorize } from '../household/permissions.ts';
import {
  err,
  ok,
  type Errand,
  type ErrandStatus,
  type Instant,
  type Member,
  type Permission,
  type Reminder,
  type ReminderStatus,
  type Result,
  type ShoppingItem,
  type ShoppingStatus,
  type UUID,
  type ValidationIssue,
} from '../../lib/contracts/index.ts';

/* ---------------------------------------------------------------- helpers */

function issue(path: string, message: string, code: ValidationIssue['code']): ValidationIssue {
  return { path, message, code };
}

function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A single tenancy + permission gate, shared by all three lists.
 *
 * `assignedTo` is threaded through so the kernel can answer `.own` questions
 * about reminders itself. That is the whole point of CR-001: if this module
 * decided assignment locally, the household would have two access rules that
 * could disagree.
 */
function gate(
  actor: Member,
  householdId: UUID,
  permission: Permission,
  resource: { householdId: UUID; createdBy?: UUID; assignedTo?: UUID },
): ValidationIssue | null {
  const verdict = authorize({ member: actor, householdId, permission, resource });
  if (verdict.allowed) return null;
  return issue('actor', verdict.reason, verdict.code === 'tenant' ? 'tenant' : 'permission');
}

/**
 * Build a state machine from a transition table.
 *
 * Returning the legal targets in the rejection message is deliberate: a caller
 * that gets "cannot go from purchased to purchased" can fix its own bug, and
 * the set of legal moves is not a secret worth withholding.
 */
function transition<S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
  label: string,
): (from: S, to: S) => ValidationIssue | null {
  return (from: S, to: S): ValidationIssue | null => {
    const allowed = table[from];
    if (allowed === undefined) {
      return issue('status', `Unknown ${label} status "${String(from)}".`, 'enum');
    }
    if (!allowed.includes(to)) {
      return issue(
        'status',
        allowed.length === 0
          ? `A ${label} that is "${from}" is finished and cannot change again.`
          : `A ${label} cannot go from "${from}" to "${to}" (allowed: ${allowed.join(', ')}).`,
        'logic',
      );
    }
    return null;
  };
}

/* --------------------------------------------------------------- shopping */

/**
 * `purchased` is not terminal: putting something back on the list is a real
 * family workflow ("we bought the wrong size"). `removed` is terminal — that is
 * the deliberate act of saying we do not need this at all.
 */
const SHOPPING_TRANSITIONS: Readonly<Record<ShoppingStatus, readonly ShoppingStatus[]>> = Object.freeze({
  needed: ['purchased', 'removed'],
  purchased: ['needed', 'removed'],
  removed: [],
});

const shoppingStep = transition(SHOPPING_TRANSITIONS, 'shopping item');

export interface AddShoppingItemInput {
  id: UUID;
  householdId: UUID;
  actor: Member;
  name: string;
  listName?: string;
  quantity?: number;
  category?: string;
  store?: string;
}

export const DEFAULT_SHOPPING_LIST = 'Household';

/**
 * Adding to the shopping list is an `event.create` action.
 *
 * Reusing the event verb rather than minting a `shopping.create` is a
 * deliberate contract decision: the same roles that may put something on the
 * family calendar may put milk on the list, and inventing a parallel verb would
 * mean two matrices to keep in sync. A viewer holds neither.
 */
export function addShoppingItem(input: AddShoppingItemInput): Result<ShoppingItem> {
  const issues: ValidationIssue[] = [];

  const denied = gate(input.actor, input.householdId, 'event.create', { householdId: input.householdId });
  if (denied) return err([denied]);

  const name = cleanText(input.name);
  if (name === null) issues.push(issue('name', 'A shopping item needs a name.', 'required'));

  const id = cleanText(input.id);
  if (id === null) issues.push(issue('id', 'A shopping item needs an id.', 'required'));

  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) {
    issues.push(issue('quantity', 'Quantity must be a whole number of at least 1.', 'range'));
  }

  if (issues.length > 0) return err(issues);

  const category = cleanText(input.category);
  const store = cleanText(input.store);
  return ok({
    id: id!,
    householdId: input.householdId,
    listName: cleanText(input.listName) ?? DEFAULT_SHOPPING_LIST,
    name: name!,
    quantity,
    status: 'needed',
    ...(category === null ? {} : { category }),
    ...(store === null ? {} : { store }),
  });
}

export function setShoppingStatus(
  item: ShoppingItem,
  next: ShoppingStatus,
  actor: Member,
): Result<ShoppingItem> {
  const denied = gate(actor, item.householdId, 'event.create', { householdId: item.householdId });
  if (denied) return err([denied]);

  const illegal = shoppingStep(item.status, next);
  if (illegal) return err([illegal]);

  return ok({ ...item, status: next });
}

/**
 * PRODUCT_SPEC §3: "AI may group by store."
 *
 * Grouping is deterministic and case-insensitive, and every group is sorted by
 * name, so two calls with the list in a different order produce byte-identical
 * output. Items with no store fall into one explicit bucket rather than
 * vanishing — an ungrouped item is still something you have to buy.
 */
export const UNGROUPED_STORE = 'Anywhere';

export interface StoreGroup {
  store: string;
  items: ShoppingItem[];
  totalQuantity: number;
}

export function groupByStore(items: readonly ShoppingItem[]): StoreGroup[] {
  const buckets = new Map<string, { label: string; items: ShoppingItem[] }>();

  for (const item of items) {
    if (item.status !== 'needed') continue; // a finished item is not a shopping trip
    const label = cleanText(item.store) ?? UNGROUPED_STORE;
    const key = label.toLowerCase();
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.items.push(item);
      // "Aldi" and "aldi" are one store, but which spelling labels the group
      // must not depend on which row happened to arrive first — that would make
      // the same list render two different ways.
      if (label < bucket.label) bucket.label = label;
    } else {
      buckets.set(key, { label, items: [item] });
    }
  }

  return [...buckets.values()]
    .map((bucket) => ({
      store: bucket.label,
      items: [...bucket.items].sort((a, b) =>
        a.name === b.name ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.name < b.name ? -1 : 1,
      ),
      totalQuantity: bucket.items.reduce((sum, i) => sum + i.quantity, 0),
    }))
    // The catch-all bucket sorts last; named stores sort alphabetically.
    .sort((a, b) => {
      if (a.store === UNGROUPED_STORE) return b.store === UNGROUPED_STORE ? 0 : 1;
      if (b.store === UNGROUPED_STORE) return -1;
      return a.store.toLowerCase() < b.store.toLowerCase() ? -1 : 1;
    });
}

/* ---------------------------------------------------------------- errands */

const ERRAND_TRANSITIONS: Readonly<Record<ErrandStatus, readonly ErrandStatus[]>> = Object.freeze({
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['done', 'open', 'cancelled'],
  done: [],
  cancelled: [],
});

const errandStep = transition(ERRAND_TRANSITIONS, 'errand');

export interface CreateErrandInput {
  id: UUID;
  householdId: UUID;
  actor: Member;
  title: string;
  assignedTo?: UUID;
  dueAt?: Instant;
  location?: string;
}

export function createErrand(input: CreateErrandInput): Result<Errand> {
  const issues: ValidationIssue[] = [];

  const denied = gate(input.actor, input.householdId, 'event.create', { householdId: input.householdId });
  if (denied) return err([denied]);

  const title = cleanText(input.title);
  if (title === null) issues.push(issue('title', 'An errand needs a title.', 'required'));

  const id = cleanText(input.id);
  if (id === null) issues.push(issue('id', 'An errand needs an id.', 'required'));

  if (input.dueAt !== undefined && parseInstant(input.dueAt) === null) {
    issues.push(issue('dueAt', 'dueAt must be an ISO-8601 instant.', 'format'));
  }

  if (issues.length > 0) return err(issues);

  const assignedTo = cleanText(input.assignedTo);
  const location = cleanText(input.location);
  return ok({
    id: id!,
    householdId: input.householdId,
    title: title!,
    status: 'open',
    ...(assignedTo === null ? {} : { assignedTo }),
    ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
    ...(location === null ? {} : { location }),
  });
}

export function setErrandStatus(errand: Errand, next: ErrandStatus, actor: Member): Result<Errand> {
  // An errand is a task somebody owns, so the `.own` verb applies and the
  // kernel gets `assignedTo` to judge it with.
  const denied = gate(actor, errand.householdId, 'event.update.own', {
    householdId: errand.householdId,
    createdBy: errand.assignedTo,
    assignedTo: errand.assignedTo,
  });
  if (denied) return err([denied]);

  const illegal = errandStep(errand.status, next);
  if (illegal) return err([illegal]);

  return ok({ ...errand, status: next });
}

/**
 * PRODUCT_SPEC §12: "combine errands" is a resolution the AI may suggest.
 *
 * Grouping by location gives it something concrete to suggest, and only groups
 * of two or more are worth surfacing — telling a family that one errand can be
 * combined with itself is noise.
 */
export interface ErrandCluster {
  location: string;
  errands: Errand[];
}

export function clusterErrandsByLocation(errands: readonly Errand[]): ErrandCluster[] {
  const buckets = new Map<string, { label: string; errands: Errand[] }>();

  for (const errand of errands) {
    if (errand.status !== 'open' && errand.status !== 'in_progress') continue;
    const label = cleanText(errand.location);
    if (label === null) continue; // no place, nothing to combine
    const key = label.toLowerCase();
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.errands.push(errand);
      if (label < bucket.label) bucket.label = label; // canonical label, order-independent
    } else {
      buckets.set(key, { label, errands: [errand] });
    }
  }

  return [...buckets.values()]
    .filter((bucket) => bucket.errands.length > 1)
    .map((bucket) => ({
      location: bucket.label,
      errands: [...bucket.errands].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    }))
    .sort((a, b) => (a.location.toLowerCase() < b.location.toLowerCase() ? -1 : 1));
}

/* -------------------------------------------------------------- reminders */

/**
 * `sent` is a delivery fact, not a user action, so it sits between `pending`
 * and the states a person can put a reminder into. `completed` and `dismissed`
 * are terminal; `snoozed` always returns to `pending` when its time comes.
 */
const REMINDER_TRANSITIONS: Readonly<Record<ReminderStatus, readonly ReminderStatus[]>> = Object.freeze({
  pending: ['sent', 'completed', 'snoozed', 'dismissed'],
  sent: ['completed', 'snoozed', 'dismissed'],
  snoozed: ['pending', 'completed', 'dismissed'],
  completed: [],
  dismissed: [],
});

const reminderStep = transition(REMINDER_TRANSITIONS, 'reminder');

export interface CreateReminderInput {
  id: UUID;
  householdId: UUID;
  actor: Member;
  title: string;
  dueAt: Instant;
  assignedTo?: UUID;
  eventId?: UUID;
  recurrence?: Reminder['recurrence'];
}

export function createReminder(input: CreateReminderInput): Result<Reminder> {
  const issues: ValidationIssue[] = [];

  const denied = gate(input.actor, input.householdId, 'event.create', { householdId: input.householdId });
  if (denied) return err([denied]);

  const title = cleanText(input.title);
  if (title === null) issues.push(issue('title', 'A reminder needs a title.', 'required'));

  const id = cleanText(input.id);
  if (id === null) issues.push(issue('id', 'A reminder needs an id.', 'required'));

  if (parseInstant(input.dueAt) === null) {
    issues.push(issue('dueAt', 'A reminder needs a due instant in ISO-8601.', 'format'));
  }

  if (issues.length > 0) return err(issues);

  const assignedTo = cleanText(input.assignedTo);
  const eventId = cleanText(input.eventId);
  return ok({
    id: id!,
    householdId: input.householdId,
    title: title!,
    dueAt: input.dueAt,
    status: 'pending',
    ...(assignedTo === null ? {} : { assignedTo }),
    ...(eventId === null ? {} : { eventId }),
    ...(input.recurrence === undefined ? {} : { recurrence: input.recurrence }),
  });
}

/**
 * Complete a reminder.
 *
 * `now` is injected rather than read: `completedAt` ends up in the audit log,
 * and a value this module invented from the wall clock could not be reproduced
 * by a replay.
 *
 * A recurring reminder does not simply close. It completes, and the caller gets
 * a `next` row to persist alongside it — with a fresh id it supplies, because
 * this module does not invent identity either.
 */
export interface CompleteReminderOptions {
  now: Instant;
  /** Required only for a recurring reminder: the id its next occurrence takes. */
  nextId?: UUID;
}

export interface CompletedReminder {
  reminder: Reminder;
  /** The next occurrence of a recurring reminder, or null when the series ends. */
  next: Reminder | null;
}

export function completeReminder(
  reminder: Reminder,
  actor: Member,
  options: CompleteReminderOptions,
): Result<CompletedReminder> {
  const denied = gate(actor, reminder.householdId, 'reminder.complete.own', {
    householdId: reminder.householdId,
    assignedTo: reminder.assignedTo,
  });
  if (denied) return err([denied]);

  const illegal = reminderStep(reminder.status, 'completed');
  if (illegal) return err([illegal]);

  const nowMs = parseInstant(options.now);
  if (nowMs === null) {
    return err([issue('now', 'completeReminder needs the current instant in ISO-8601.', 'format')]);
  }

  const completed: Reminder = { ...reminder, status: 'completed', completedAt: options.now };
  delete completed.snoozedUntil;

  const nextDueAt = nextRecurrenceDue(reminder);
  if (nextDueAt === null) return ok({ reminder: completed, next: null });

  const nextId = cleanText(options.nextId);
  if (nextId === null) {
    return err([
      issue(
        'nextId',
        'This reminder recurs, so completing it needs an id for the next occurrence.',
        'required',
      ),
    ]);
  }

  const next: Reminder = { ...reminder, id: nextId, dueAt: nextDueAt, status: 'pending' };
  delete next.snoozedUntil;
  delete next.completedAt;

  return ok({ reminder: completed, next });
}

/**
 * When does a recurring reminder next come due?
 *
 * Deliberately narrower than the scheduling engine's recurrence: a reminder is
 * a single point in time, so only `freq` + `interval` matter, and `byWeekday` /
 * `byMonthDay` are the event engine's business. Returns null for a
 * non-recurring reminder, an uninterpretable rule, or a series that has hit its
 * `until` bound.
 */
function nextRecurrenceDue(reminder: Reminder): Instant | null {
  const rule = reminder.recurrence;
  if (rule === undefined || rule === null) return null;
  if (!Number.isInteger(rule.interval) || rule.interval < 1) return null;

  const dueMs = parseInstant(reminder.dueAt);
  if (dueMs === null) return null;

  const due = new Date(dueMs);
  let nextMs: number;
  if (rule.freq === 'DAILY') {
    nextMs = dueMs + rule.interval * 86_400_000;
  } else if (rule.freq === 'WEEKLY') {
    nextMs = dueMs + rule.interval * 7 * 86_400_000;
  } else if (rule.freq === 'MONTHLY') {
    // Month arithmetic in UTC, skipping (never clamping) a day the target month
    // does not have — the same rule the scheduling engine follows for
    // BYMONTHDAY, so "the 31st" behaves identically in both places.
    const target = new Date(due.getTime());
    target.setUTCMonth(target.getUTCMonth() + rule.interval);
    if (target.getUTCDate() !== due.getUTCDate()) return null;
    nextMs = target.getTime();
  } else {
    return null;
  }

  if (typeof rule.until === 'string' && rule.until.length > 0) {
    const untilMs = Date.parse(`${rule.until}T23:59:59.999Z`);
    if (Number.isFinite(untilMs) && nextMs > untilMs) return null;
  }

  return new Date(nextMs).toISOString();
}

export interface SnoozeReminderOptions {
  /** When the reminder should come back. */
  until: Instant;
  /** The instant the snooze is being requested, so "into the past" can be caught. */
  now: Instant;
}

export function snoozeReminder(
  reminder: Reminder,
  actor: Member,
  options: SnoozeReminderOptions,
): Result<Reminder> {
  const denied = gate(actor, reminder.householdId, 'reminder.snooze.own', {
    householdId: reminder.householdId,
    assignedTo: reminder.assignedTo,
  });
  if (denied) return err([denied]);

  const illegal = reminderStep(reminder.status, 'snoozed');
  if (illegal) return err([illegal]);

  const untilMs = parseInstant(options.until);
  const nowMs = parseInstant(options.now);
  if (untilMs === null || nowMs === null) {
    return err([issue('until', 'Snoozing needs both `until` and `now` as ISO-8601 instants.', 'format')]);
  }
  if (untilMs <= nowMs) {
    // A snooze into the past would fire again immediately — an infinite loop
    // dressed up as a user action.
    return err([issue('until', 'A reminder can only be snoozed to a future instant.', 'logic')]);
  }

  return { ok: true, value: { ...reminder, status: 'snoozed', snoozedUntil: options.until } };
}

export function dismissReminder(reminder: Reminder, actor: Member): Result<Reminder> {
  const denied = gate(actor, reminder.householdId, 'reminder.complete.own', {
    householdId: reminder.householdId,
    assignedTo: reminder.assignedTo,
  });
  if (denied) return err([denied]);

  const illegal = reminderStep(reminder.status, 'dismissed');
  if (illegal) return err([illegal]);

  const dismissed: Reminder = { ...reminder, status: 'dismissed' };
  delete dismissed.snoozedUntil;
  return ok(dismissed);
}

/**
 * Reminders that are due at `now`: pending ones past their due instant, and
 * snoozed ones whose snooze has run out.
 *
 * A snoozed reminder is judged by `snoozedUntil`, never by `dueAt` — otherwise
 * snoozing would do nothing at all for a reminder that is already overdue,
 * which is exactly when people snooze.
 */
export function dueReminders(reminders: readonly Reminder[], now: Instant): Reminder[] {
  const nowMs = parseInstant(now);
  if (nowMs === null) return [];

  return reminders
    .filter((reminder) => {
      if (reminder.status === 'snoozed') {
        const wake = parseInstant(reminder.snoozedUntil);
        return wake !== null && wake <= nowMs;
      }
      if (reminder.status !== 'pending' && reminder.status !== 'sent') return false;
      const due = parseInstant(reminder.dueAt);
      return due !== null && due <= nowMs;
    })
    .sort((a, b) => {
      const aKey = a.status === 'snoozed' ? (a.snoozedUntil ?? a.dueAt) : a.dueAt;
      const bKey = b.status === 'snoozed' ? (b.snoozedUntil ?? b.dueAt) : b.dueAt;
      if (aKey !== bKey) return aKey < bKey ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * Wake a snoozed reminder whose time has come.
 *
 * Separate from `dueReminders` on purpose: reading what is due is something the
 * UI does constantly, while writing a row back to `pending` is a mutation the
 * scheduler performs once. Conflating them would make a read silently write.
 */
export function wakeSnoozed(reminders: readonly Reminder[], now: Instant): Reminder[] {
  const nowMs = parseInstant(now);
  if (nowMs === null) return [...reminders];

  return reminders.map((reminder) => {
    if (reminder.status !== 'snoozed') return reminder;
    const wake = parseInstant(reminder.snoozedUntil);
    if (wake === null || wake > nowMs) return reminder;
    const woken: Reminder = { ...reminder, status: 'pending' };
    delete woken.snoozedUntil;
    return woken;
  });
}
