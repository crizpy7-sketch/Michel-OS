/**
 * Row ⇄ contract mapping (Agent B2).
 *
 * Postgres speaks `snake_case`, `Date` and `null`. The frozen contracts speak
 * `camelCase`, ISO instants and *absent* optional keys. This file is the only
 * place that translation happens, so a column rename has one blast radius.
 *
 * Two rules that look fussy and are not:
 *
 *   1. **An absent optional is omitted, never set to `undefined`.** The domain
 *      tier is full of `assert.deepEqual` and byte-identical determinism
 *      checks, and `{ a: 1 }` is not deep-strict-equal to `{ a: 1, b: undefined }`.
 *      Every mapper here builds optionals with a conditional spread for that
 *      reason — the same discipline `expandOccurrences` already follows.
 *   2. **Instants are ISO strings with milliseconds, always.** `Date.toISOString()`
 *      guarantees the shape the contracts document. Handing a `Date` object out
 *      of this layer would let one escape into a conflict id hash, and the ids
 *      would stop being reproducible.
 */

import type {
  Availability,
  Business,
  DomainKey,
  Employee,
  Errand,
  ErrandStatus,
  EventRecord,
  Expense,
  Household,
  InboxItem,
  InboxStatus,
  InventoryMovement,
  Member,
  MovementKind,
  Notification,
  NotificationChannel,
  NotificationKind,
  Product,
  RecurrenceRule,
  Reminder,
  ReminderStatus,
  Role,
  Sale,
  Schedule,
  SearchDocument,
  SearchEntity,
  Shift,
  ShiftStatus,
  ShiftSwap,
  ShoppingItem,
  ShoppingStatus,
  SwapStatus,
  TimeOffRequest,
  TimeOffStatus,
  Weekday,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------- primitives */

/** A timestamptz column as a contract `Instant`. */
export function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  // A NOT NULL timestamptz cannot actually be missing; if it is, the row is
  // corrupt and a thrown error is better than a silently wrong date.
  throw new Error(`expected a timestamp, received ${JSON.stringify(value)}`);
}

/** A nullable timestamptz. Returns undefined so callers can spread it away. */
export function maybeInstant(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : instant(value);
}

/** A date column (no time) as YYYY-MM-DD. */
export function calendarDate(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) {
    // A DATE comes back at UTC midnight; formatting in UTC keeps the same day.
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') return value.slice(0, 10);
  return undefined;
}

export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Include `key: value` only when the value is present. */
export function opt<K extends string, V>(key: K, value: V | undefined | null): Record<K, V> | Record<string, never> {
  return value === undefined || value === null ? {} : ({ [key]: value } as Record<K, V>);
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/* ------------------------------------------------------------- household */

export interface HouseholdRow {
  id: string;
  name: string;
  timezone: string;
  created_at: Date | string;
}

export const toHousehold = (r: HouseholdRow): Household => ({
  id: r.id,
  name: r.name,
  timezone: r.timezone,
  createdAt: instant(r.created_at),
});

export interface MemberRow {
  id: string;
  household_id: string;
  user_id: string | null;
  display_name: string;
  role: string;
  color: string;
  active: boolean;
}

export const toMember = (r: MemberRow): Member => ({
  id: r.id,
  householdId: r.household_id,
  userId: r.user_id,
  displayName: r.display_name,
  role: r.role as Role,
  color: r.color,
  active: r.active,
});

/* ------------------------------------------------------------ scheduling */

export interface ScheduleRow {
  id: string;
  household_id: string;
  domain: string;
  name: string;
  color: string;
  archived: boolean;
}

export const toSchedule = (r: ScheduleRow): Schedule => ({
  id: r.id,
  householdId: r.household_id,
  domain: r.domain as DomainKey,
  name: r.name,
  color: r.color,
  archived: r.archived,
});

export interface EventRow {
  id: string;
  household_id: string;
  schedule_id: string;
  domain: string;
  title: string;
  notes: string | null;
  location: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  all_day: boolean;
  timezone: string;
  status: string;
  created_by: string;
  rrule_freq: string | null;
  rrule_interval: number | null;
  rrule_by_weekday: string[] | null;
  rrule_by_monthday: number[] | null;
  rrule_until: Date | string | null;
  rrule_count: number | null;
  rrule_week_start: string | null;
  series_id: string | null;
  recurrence_id: Date | string | null;
  /** Joined in by the repository; not a column on `event`. */
  exceptions?: Array<Date | string> | null;
}

/**
 * Rebuild a `RecurrenceRule` from the flattened columns.
 *
 * Returns undefined when there is no rule, which is why `recurrence` is spread
 * conditionally onto the event rather than assigned: an `EventRecord` with
 * `recurrence: undefined` is not deep-equal to one without the key, and the
 * recurrence engine's tests compare expansions with deep equality.
 */
export function toRecurrence(r: EventRow): RecurrenceRule | undefined {
  if (r.rrule_freq === null || r.rrule_interval === null) return undefined;

  const exceptions = (r.exceptions ?? [])
    .map((d) => calendarDate(d))
    .filter((d): d is string => d !== undefined)
    .sort();

  return {
    freq: r.rrule_freq as RecurrenceRule['freq'],
    interval: r.rrule_interval,
    ...opt('byWeekday', r.rrule_by_weekday === null ? undefined : (r.rrule_by_weekday as Weekday[])),
    ...opt('byMonthDay', r.rrule_by_monthday === null ? undefined : r.rrule_by_monthday),
    ...opt('until', calendarDate(r.rrule_until)),
    ...opt('count', r.rrule_count === null ? undefined : r.rrule_count),
    ...opt('weekStart', r.rrule_week_start === null ? undefined : (r.rrule_week_start as Weekday)),
    ...(exceptions.length > 0 ? { exceptions } : {}),
  };
}

export const toEvent = (r: EventRow): EventRecord => ({
  id: r.id,
  householdId: r.household_id,
  scheduleId: r.schedule_id,
  domain: r.domain as DomainKey,
  title: r.title,
  ...opt('notes', text(r.notes)),
  ...opt('location', text(r.location)),
  startsAt: instant(r.starts_at),
  endsAt: instant(r.ends_at),
  allDay: r.all_day,
  timezone: r.timezone,
  status: r.status as EventRecord['status'],
  createdBy: r.created_by,
  ...opt('recurrence', toRecurrence(r)),
  ...opt('seriesId', r.series_id ?? undefined),
  ...opt('recurrenceId', maybeInstant(r.recurrence_id)),
});

export interface ReminderRow {
  id: string;
  household_id: string;
  event_id: string | null;
  title: string;
  due_at: Date | string;
  assigned_to: string | null;
  status: string;
  snoozed_until: Date | string | null;
  completed_at: Date | string | null;
  rrule_freq: string | null;
  rrule_interval: number | null;
  rrule_until: Date | string | null;
}

export const toReminder = (r: ReminderRow): Reminder => ({
  id: r.id,
  householdId: r.household_id,
  ...opt('eventId', r.event_id ?? undefined),
  title: r.title,
  dueAt: instant(r.due_at),
  ...opt('assignedTo', r.assigned_to ?? undefined),
  status: r.status as ReminderStatus,
  ...opt('snoozedUntil', maybeInstant(r.snoozed_until)),
  ...opt('completedAt', maybeInstant(r.completed_at)),
  ...opt(
    'recurrence',
    r.rrule_freq === null || r.rrule_interval === null
      ? undefined
      : {
          freq: r.rrule_freq as RecurrenceRule['freq'],
          interval: r.rrule_interval,
          ...opt('until', calendarDate(r.rrule_until)),
        },
  ),
});

/* --------------------------------------------------- personal organization */

export interface ShoppingItemRow {
  id: string;
  household_id: string;
  list_name: string;
  name: string;
  quantity: number;
  status: string;
  category: string | null;
  store: string | null;
}

export const toShoppingItem = (r: ShoppingItemRow): ShoppingItem => ({
  id: r.id,
  householdId: r.household_id,
  listName: r.list_name,
  name: r.name,
  quantity: num(r.quantity, 1),
  status: r.status as ShoppingStatus,
  ...opt('category', text(r.category)),
  ...opt('store', text(r.store)),
});

export interface ErrandRow {
  id: string;
  household_id: string;
  title: string;
  assigned_to: string | null;
  due_at: Date | string | null;
  location: string | null;
  status: string;
}

export const toErrand = (r: ErrandRow): Errand => ({
  id: r.id,
  householdId: r.household_id,
  title: r.title,
  ...opt('assignedTo', r.assigned_to ?? undefined),
  ...opt('dueAt', maybeInstant(r.due_at)),
  status: r.status as ErrandStatus,
  ...opt('location', text(r.location)),
});

export interface InboxItemRow {
  id: string;
  household_id: string;
  raw_text: string;
  captured_by: string;
  captured_at: Date | string;
  suggested_domain: string | null;
  status: string;
}

export const toInboxItem = (r: InboxItemRow): InboxItem => ({
  id: r.id,
  householdId: r.household_id,
  rawText: r.raw_text,
  capturedBy: r.captured_by,
  capturedAt: instant(r.captured_at),
  ...opt('suggestedDomain', (r.suggested_domain ?? undefined) as DomainKey | undefined),
  status: r.status as InboxStatus,
});

/* ------------------------------------------------------ shia baby business */

export interface BusinessRow {
  id: string;
  household_id: string;
  name: string;
  timezone: string;
  tax_set_aside_rate: number | string;
}

export const toBusiness = (r: BusinessRow): Business => ({
  id: r.id,
  householdId: r.household_id,
  name: r.name,
  timezone: r.timezone,
  taxSetAsideRate: num(r.tax_set_aside_rate),
});

export interface EmployeeRow {
  id: string;
  business_id: string;
  member_id: string | null;
  display_name: string;
  hourly_rate_cents: number | string;
  active: boolean;
}

export const toEmployee = (r: EmployeeRow): Employee => ({
  id: r.id,
  businessId: r.business_id,
  memberId: r.member_id,
  displayName: r.display_name,
  // The contract calls this `hourlyRate`; the column is explicit that it is
  // cents, because a column called `hourly_rate` holding cents is how a
  // hundred-fold pay error happens.
  hourlyRate: num(r.hourly_rate_cents),
  active: r.active,
});

export interface AvailabilityRow {
  id: string;
  business_id: string;
  employee_id: string;
  weekday: string;
  start_minute: number;
  end_minute: number;
  available: boolean;
  preferred_weekly_hours: number | string | null;
}

export const toAvailability = (r: AvailabilityRow): Availability => ({
  id: r.id,
  businessId: r.business_id,
  employeeId: r.employee_id,
  weekday: r.weekday as Weekday,
  startMinute: num(r.start_minute),
  endMinute: num(r.end_minute),
  available: r.available,
  ...opt(
    'preferredWeeklyHours',
    r.preferred_weekly_hours === null ? undefined : num(r.preferred_weekly_hours),
  ),
});

export interface ShiftRow {
  id: string;
  business_id: string;
  employee_id: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  status: string;
  role: string | null;
}

export const toShift = (r: ShiftRow): Shift => ({
  id: r.id,
  businessId: r.business_id,
  employeeId: r.employee_id,
  startsAt: instant(r.starts_at),
  endsAt: instant(r.ends_at),
  status: r.status as ShiftStatus,
  ...opt('role', text(r.role)),
});

export interface TimeOffRow {
  id: string;
  business_id: string;
  employee_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  status: string;
  reason: string | null;
  reviewed_by: string | null;
}

export const toTimeOff = (r: TimeOffRow): TimeOffRequest => ({
  id: r.id,
  businessId: r.business_id,
  employeeId: r.employee_id,
  startsAt: instant(r.starts_at),
  endsAt: instant(r.ends_at),
  status: r.status as TimeOffStatus,
  ...opt('reason', text(r.reason)),
  ...opt('reviewedBy', r.reviewed_by ?? undefined),
});

export interface ShiftSwapRow {
  id: string;
  business_id: string;
  shift_id: string;
  from_employee_id: string;
  to_employee_id: string | null;
  status: string;
  reviewed_by: string | null;
}

export const toShiftSwap = (r: ShiftSwapRow): ShiftSwap => ({
  id: r.id,
  businessId: r.business_id,
  shiftId: r.shift_id,
  fromEmployeeId: r.from_employee_id,
  toEmployeeId: r.to_employee_id,
  status: r.status as SwapStatus,
  ...opt('reviewedBy', r.reviewed_by ?? undefined),
});

export interface ProductRow {
  id: string;
  business_id: string;
  sku: string;
  name: string;
  quantity_on_hand: number;
  reorder_point: number;
  unit_cost_cents: number | string;
  unit_price_cents: number | string;
  category: string | null;
  barcode: string | null;
  supplier: string | null;
}

export const toProduct = (r: ProductRow): Product => ({
  id: r.id,
  businessId: r.business_id,
  sku: r.sku,
  name: r.name,
  quantityOnHand: num(r.quantity_on_hand),
  reorderPoint: num(r.reorder_point),
  unitCost: num(r.unit_cost_cents),
  unitPrice: num(r.unit_price_cents),
  ...opt('category', text(r.category)),
  ...opt('barcode', text(r.barcode)),
  ...opt('supplier', text(r.supplier)),
});

export interface MovementRow {
  id: string;
  business_id: string;
  product_id: string;
  kind: string;
  quantity_delta: number;
  at: Date | string;
  unit_cost_cents: number | string | null;
  note: string | null;
}

export const toMovement = (r: MovementRow): InventoryMovement => ({
  id: r.id,
  businessId: r.business_id,
  productId: r.product_id,
  kind: r.kind as MovementKind,
  quantityDelta: num(r.quantity_delta),
  at: instant(r.at),
  ...opt('unitCost', r.unit_cost_cents === null ? undefined : num(r.unit_cost_cents)),
  ...opt('note', text(r.note)),
});

export interface SaleRow {
  id: string;
  business_id: string;
  at: Date | string;
  tax_collected_cents: number | string | null;
  channel: string | null;
  /** Joined in by the repository. */
  items?: Array<{ product_id: string; quantity: number; unit_price_cents: number | string }>;
}

export const toSale = (r: SaleRow): Sale => ({
  id: r.id,
  businessId: r.business_id,
  at: instant(r.at),
  items: (r.items ?? []).map((i) => ({
    productId: i.product_id,
    quantity: num(i.quantity),
    unitPriceCents: num(i.unit_price_cents),
  })),
  ...opt('taxCollectedCents', r.tax_collected_cents === null ? undefined : num(r.tax_collected_cents)),
  ...opt('channel', text(r.channel)),
});

export interface ExpenseRow {
  id: string;
  business_id: string;
  at: Date | string;
  vendor: string;
  category: string;
  amount_cents: number | string;
  description: string | null;
  receipt_attachment_id: string | null;
}

export const toExpense = (r: ExpenseRow): Expense => ({
  id: r.id,
  businessId: r.business_id,
  at: instant(r.at),
  vendor: r.vendor,
  category: r.category,
  amountCents: num(r.amount_cents),
  ...opt('description', text(r.description)),
  ...opt('receiptAttachmentId', r.receipt_attachment_id ?? undefined),
});

/* ---------------------------------------------------------- cross-cutting */

export interface NotificationRow {
  id: string;
  household_id: string;
  recipient_member_id: string | null;
  kind: string;
  channel: string;
  title: string;
  body: string;
  deliver_at: Date | string;
  read_at: Date | string | null;
  subject_entity: string | null;
  subject_id: string | null;
  dedupe_key: string;
}

export const toNotification = (r: NotificationRow): Notification => ({
  id: r.id,
  householdId: r.household_id,
  recipientMemberId: r.recipient_member_id,
  kind: r.kind as NotificationKind,
  channel: r.channel as NotificationChannel,
  title: r.title,
  body: r.body,
  deliverAt: instant(r.deliver_at),
  ...opt('readAt', maybeInstant(r.read_at)),
  ...(r.subject_entity !== null && r.subject_id !== null
    ? { subject: { entity: r.subject_entity, id: r.subject_id } }
    : {}),
  dedupeKey: r.dedupe_key,
});

export interface SearchDocumentRow {
  entity: string;
  id: string;
  household_id: string;
  title: string;
  body: string | null;
  domain: string | null;
  at: Date | string | null;
  member_ids: string[] | null;
  business_id: string | null;
}

export const toSearchDocument = (r: SearchDocumentRow): SearchDocument => ({
  entity: r.entity as SearchEntity,
  id: r.id,
  householdId: r.household_id,
  title: r.title,
  ...opt('body', text(r.body)),
  ...opt('domain', (r.domain ?? undefined) as DomainKey | undefined),
  ...opt('at', maybeInstant(r.at)),
  ...opt('memberIds', r.member_ids === null ? undefined : r.member_ids),
  ...opt('businessId', r.business_id ?? undefined),
});
