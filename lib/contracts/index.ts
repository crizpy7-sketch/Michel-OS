/**
 * FROZEN SHARED CONTRACTS — Michel-OS / Family Scheduling OS
 *
 * Owner: Lead Orchestrator ONLY.
 * Per SWARM_ORCHESTRATION.md §3: "Agents must not rewrite shared contracts."
 * Any swarm agent needing a change must raise a blocker, not edit this file.
 *
 * Frozen set (ARCHITECTURE.md §5): Household, User, Member, Schedule, Event,
 * EventParticipant, RecurrenceRule, Reminder, Conflict, Business, Employee,
 * Shift, Product, ShoppingItem, Errand, InboxItem, AIAction, AuditLog.
 *
 * v1.1 extends that set for the Phase C-2 domains: Availability,
 * TimeOffRequest, ShiftSwap, InventoryMovement, Sale, SaleItem, Expense,
 * Notification, SearchDocument, SearchHit, Attachment, MorningBrief.
 */

export const CONTRACT_VERSION = '1.1.0-frozen';

/**
 * v1.1 re-freeze (orchestrator ruling, docs/contract-change-requests.md):
 * closes CR-001, CR-002, CR-004, CR-005, CR-006, CR-007, and adds the shapes
 * the Phase C-2 agents (I personal, J staffing/ledger, K platform) build
 * against. Frozen between phases, never mid-flight.
 */

/* ------------------------------------------------------------------ ids */

export type UUID = string;
/** ISO-8601 UTC instant, e.g. 2026-08-24T14:00:00.000Z */
export type Instant = string;
/** Calendar date, YYYY-MM-DD, no timezone. */
export type CalendarDate = string;
/** IANA timezone, e.g. America/Chicago */
export type TimeZone = string;

/* ------------------------------------------------------- household + auth */

export const ROLES = ['owner', 'adult', 'teen', 'child', 'employee', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface Household {
  id: UUID;
  name: string;
  timezone: TimeZone;
  createdAt: Instant;
}

export interface User {
  id: UUID;
  email: string;
  displayName: string;
  createdAt: Instant;
}

export interface Member {
  id: UUID;
  householdId: UUID;
  userId: UUID | null; // null = managed profile (young child) with no login
  displayName: string;
  role: Role;
  color: string; // design-system token key
  active: boolean;
}

export const PERMISSIONS = [
  'event.read',
  'event.create',
  'event.update.own',
  'event.update.any',
  'event.delete.own',
  'event.delete.any',
  'reminder.complete.own',
  'reminder.snooze.own',
  'reminder.manage.any',
  'member.manage',
  'household.manage',
  'business.read',
  'business.manage',
  'employee.schedule',
  'finance.read',
  'finance.manage',
  'ai.propose',
  'ai.execute.autonomous',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/* ------------------------------------------------------------ scheduling */

export const DOMAINS = [
  'appointments',
  'practice',
  'competition',
  'games',
  'school',
  'errands',
  'shopping',
  'reminders',
  'work',
  'shia-baby',
  'inbox',
  'general',
] as const;
export type DomainKey = (typeof DOMAINS)[number];

export interface Schedule {
  id: UUID;
  householdId: UUID;
  domain: DomainKey;
  name: string;
  color: string;
  archived: boolean;
}

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** RFC-5545-shaped subset. ARCHITECTURE.md §7. */
export interface RecurrenceRule {
  freq: Frequency;
  interval: number; // >= 1, "every N"
  byWeekday?: Weekday[]; // WEEKLY only
  byMonthDay?: number[]; // MONTHLY only, 1..31
  until?: CalendarDate;
  count?: number;
  /** Occurrence start dates that are cancelled outright. */
  exceptions?: CalendarDate[];
  /**
   * CR-006. Which day starts the week, for `every N weeks` interval anchoring.
   * Defaults to the RFC 5545 default, Monday, when omitted.
   */
  weekStart?: Weekday;
}

export const EVENT_STATUS = ['confirmed', 'tentative', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUS)[number];

export interface EventBase {
  id: UUID;
  householdId: UUID;
  scheduleId: UUID;
  domain: DomainKey;
  title: string;
  notes?: string;
  location?: string;
  startsAt: Instant;
  endsAt: Instant;
  allDay: boolean;
  timezone: TimeZone;
  status: EventStatus;
  createdBy: UUID; // member id
  recurrence?: RecurrenceRule;
  /** Set on a materialised override of a recurring series. */
  seriesId?: UUID;
  /** The original occurrence start this override replaces. */
  recurrenceId?: Instant;
}

export type EventRecord = EventBase;

/** A single expanded instance produced by the recurrence engine. */
export interface Occurrence {
  eventId: UUID;
  seriesId: UUID | null;
  occurrenceStart: Instant;
  occurrenceEnd: Instant;
  title: string;
  domain: DomainKey;
  status: EventStatus;
  participantIds: UUID[];
  isOverride: boolean;
  /** CR-005. Carried from the event so `travel` conflicts can compare places. */
  location?: string;
}

/**
 * CR-007. `expandOccurrences` truncates at a cap; a caller that gets exactly
 * `maxOccurrences` rows cannot otherwise tell a series that ended from one that
 * was cut off, so it cannot offer a "more occurrences exist" affordance.
 */
export interface ExpansionResult {
  occurrences: Occurrence[];
  /** True when the cap stopped the expansion before the rule ran out. */
  truncated: boolean;
  /** The cap that was in force for this expansion. */
  maxOccurrences: number;
}

export const PARTICIPANT_ROLES = ['attendee', 'responsible', 'optional'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export interface EventParticipant {
  eventId: UUID;
  memberId: UUID;
  role: ParticipantRole;
}

export const REMINDER_STATUS = ['pending', 'sent', 'completed', 'snoozed', 'dismissed'] as const;
export type ReminderStatus = (typeof REMINDER_STATUS)[number];

export interface Reminder {
  id: UUID;
  householdId: UUID;
  eventId?: UUID;
  title: string;
  dueAt: Instant;
  assignedTo?: UUID;
  status: ReminderStatus;
  /** Set while `status === 'snoozed'`; the instant the reminder comes back. */
  snoozedUntil?: Instant;
  /** PRODUCT_SPEC §3 Reminders: "recurring reminders". */
  recurrence?: RecurrenceRule;
  /** Set when a completed reminder has already spawned its next occurrence. */
  completedAt?: Instant;
}

/* -------------------------------------------------------- conflict engine */

export const CONFLICT_KINDS = [
  'overlap',            // same member, two overlapping occurrences
  'responsibility',     // nobody responsible / responsible party double-booked
  'work',               // collides with a work shift
  'employee',           // employee assigned to overlapping shifts or unavailable
  'travel',             // back-to-back at different locations
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export const SEVERITIES = ['info', 'warning', 'blocking'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * CR-004. A `work` or `employee` conflict is about a Shift, not an Event, so a
 * ref must say which table its id belongs to. In v1.0 a shift was smuggled
 * through as `{ eventId: shift.id }` and every consumer had to know; the tag
 * makes it impossible to resolve a shift id against the events table by
 * accident.
 */
export type ConflictRef =
  | { kind: 'event'; id: UUID; startsAt: Instant }
  | { kind: 'shift'; id: UUID; startsAt: Instant };

export interface Conflict {
  id: string; // deterministic hash — same inputs must yield same id
  householdId: UUID;
  kind: ConflictKind;
  severity: Severity;
  memberIds: UUID[];
  occurrenceRefs: ConflictRef[];
  window: { startsAt: Instant; endsAt: Instant };
  explanation: string;
  resolution?: { resolvedBy: UUID; resolvedAt: Instant; note?: string };
}

/* -------------------------------------------------- shia baby (business) */

export interface Business {
  id: UUID;
  householdId: UUID;
  name: string;
  timezone: TimeZone;
  taxSetAsideRate: number; // 0..1
}

export interface Employee {
  id: UUID;
  businessId: UUID;
  memberId: UUID | null;
  displayName: string;
  hourlyRate: number;
  active: boolean;
}

export const SHIFT_STATUS = ['draft', 'published', 'swapped', 'cancelled'] as const;
export type ShiftStatus = (typeof SHIFT_STATUS)[number];

export interface Shift {
  id: UUID;
  businessId: UUID;
  employeeId: UUID | null;
  startsAt: Instant;
  endsAt: Instant;
  status: ShiftStatus;
  role?: string;
}

/** A recurring weekly availability window an employee declares. */
export interface Availability {
  id: UUID;
  businessId: UUID;
  employeeId: UUID;
  weekday: Weekday;
  /** Local minutes from midnight in the business timezone, 0..1440. */
  startMinute: number;
  endMinute: number;
  /** `false` marks a window the employee is explicitly NOT available for. */
  available: boolean;
  /** Soft cap the scheduler tries to respect across the week. */
  preferredWeeklyHours?: number;
}

export const TIME_OFF_STATUS = ['requested', 'approved', 'denied', 'cancelled'] as const;
export type TimeOffStatus = (typeof TIME_OFF_STATUS)[number];

export interface TimeOffRequest {
  id: UUID;
  businessId: UUID;
  employeeId: UUID;
  startsAt: Instant;
  endsAt: Instant;
  status: TimeOffStatus;
  reason?: string;
  reviewedBy?: UUID; // member id
}

export const SWAP_STATUS = ['requested', 'accepted', 'approved', 'declined', 'cancelled'] as const;
export type SwapStatus = (typeof SWAP_STATUS)[number];

export interface ShiftSwap {
  id: UUID;
  businessId: UUID;
  shiftId: UUID;
  fromEmployeeId: UUID;
  /** null until a colleague picks the shift up. */
  toEmployeeId: UUID | null;
  status: SwapStatus;
  reviewedBy?: UUID; // member id
}

export interface Product {
  id: UUID;
  businessId: UUID;
  sku: string;
  name: string;
  quantityOnHand: number;
  reorderPoint: number;
  unitCost: number;
  unitPrice: number;
  category?: string;
  barcode?: string;
  supplier?: string;
}

export const MOVEMENT_KINDS = ['receive', 'sale', 'adjustment', 'shrinkage', 'return'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/**
 * Inventory is an append-only ledger, not a mutable counter: `quantityOnHand`
 * is a projection of these rows, so a miscount can be corrected by adding a
 * compensating row rather than by overwriting history.
 */
export interface InventoryMovement {
  id: UUID;
  businessId: UUID;
  productId: UUID;
  kind: MovementKind;
  /** Signed. `receive` is positive, `sale`/`shrinkage` negative. */
  quantityDelta: number;
  at: Instant;
  unitCost?: number;
  note?: string;
}

export interface SaleItem {
  productId: UUID;
  quantity: number;
  /** Price actually charged per unit, in whole cents. */
  unitPriceCents: number;
}

export interface Sale {
  id: UUID;
  businessId: UUID;
  at: Instant;
  items: SaleItem[];
  /** Sales tax collected, in whole cents. Absent when not tracked at the till. */
  taxCollectedCents?: number;
  channel?: string;
}

export interface Expense {
  id: UUID;
  businessId: UUID;
  at: Instant;
  vendor: string;
  category: string;
  amountCents: number;
  description?: string;
  receiptAttachmentId?: UUID;
}

/* --------------------------------------------- personal organization */

export const SHOPPING_STATUS = ['needed', 'purchased', 'removed'] as const;
export type ShoppingStatus = (typeof SHOPPING_STATUS)[number];

export interface ShoppingItem {
  id: UUID;
  householdId: UUID;
  listName: string;
  name: string;
  quantity: number;
  status: ShoppingStatus;
  /** groceries | household | kids | clothing | school | business | home | hardware */
  category?: string;
  /** PRODUCT_SPEC §3: "AI may group by store". */
  store?: string;
}

export const ERRAND_STATUS = ['open', 'in_progress', 'done', 'cancelled'] as const;
export type ErrandStatus = (typeof ERRAND_STATUS)[number];

export interface Errand {
  id: UUID;
  householdId: UUID;
  title: string;
  assignedTo?: UUID;
  dueAt?: Instant;
  status: ErrandStatus;
  /** Where the errand has to be run — errands are physical trips. */
  location?: string;
}

export const INBOX_STATUS = ['unclassified', 'classified', 'converted', 'dismissed'] as const;
export type InboxStatus = (typeof INBOX_STATUS)[number];

export interface InboxItem {
  id: UUID;
  householdId: UUID;
  rawText: string;
  capturedBy: UUID;
  capturedAt: Instant;
  suggestedDomain?: DomainKey;
  status: InboxStatus;
}

/* ------------------------------------------------------------- ai layer */

/** AI_ACTIONS.md — the LLM proposes; the validator decides. */
export const AI_ACTION_TYPES = [
  'create_event', 'update_event', 'cancel_event', 'create_recurring_schedule',
  'add_participant', 'remove_participant',
  'create_reminder', 'update_reminder', 'complete_reminder', 'snooze_reminder',
  'add_shopping_item', 'update_shopping_item', 'mark_shopping_item_purchased', 'create_shopping_list',
  'create_errand', 'update_errand', 'complete_errand',
  'classify_inbox_item', 'convert_inbox_item', 'dismiss_inbox_item',
  'check_conflicts', 'explain_conflict', 'suggest_resolution',
  'create_employee', 'update_employee', 'assign_shift', 'remove_shift_assignment',
  'record_availability', 'request_time_off', 'review_time_off',
  'request_shift_swap', 'review_shift_swap',
  'create_inventory_item', 'adjust_inventory', 'receive_inventory', 'update_reorder_point',
  'record_sale', 'record_sale_item',
  'record_expense', 'update_expense',
] as const;
export type AIActionType = (typeof AI_ACTION_TYPES)[number];

export interface AIActionProposal {
  type: AIActionType;
  /** Raw, UNTRUSTED payload as produced by the model. */
  payload: Record<string, unknown>;
  confidence: number; // 0..1
  rationale?: string;
}

export const AI_DECISIONS = ['execute', 'confirm', 'reject'] as const;
export type AIDecision = (typeof AI_DECISIONS)[number];

export interface AIActionVerdict {
  decision: AIDecision;
  action: AIActionProposal;
  /** Populated only when decision === 'execute' | 'confirm'. */
  command?: { type: AIActionType; payload: Record<string, unknown> };
  errors: ValidationIssue[];
  requiresConfirmationBecause?: string[];
}

export interface AIAction {
  id: UUID;
  householdId: UUID;
  actorMemberId: UUID;
  proposal: AIActionProposal;
  verdict: AIDecision;
  executedAt?: Instant;
}

/* -------------------------------------------- cross-cutting platform */

export const NOTIFICATION_KINDS = [
  'reminder_due',
  'conflict_detected',
  'low_stock',
  'shift_published',
  'time_off_reviewed',
  'swap_requested',
  'inbox_needs_review',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_CHANNELS = ['in_app', 'push', 'email', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * ARCHITECTURE.md §9: V1 delivers the in-app centre and scheduled reminder
 * records; push/email/SMS are adapters bolted onto the same record later, so
 * the channel lives on the notification rather than in a separate table.
 */
export interface Notification {
  id: UUID;
  householdId: UUID;
  /** Who should see it. A household-wide notice has no recipient. */
  recipientMemberId: UUID | null;
  kind: NotificationKind;
  channel: NotificationChannel;
  title: string;
  body: string;
  /** When it becomes visible / deliverable. */
  deliverAt: Instant;
  readAt?: Instant;
  /** What it is about, so the UI can deep-link. */
  subject?: { entity: string; id: string };
  /** Stable across regeneration: same source facts must not re-notify. */
  dedupeKey: string;
}

export const SEARCH_ENTITIES = [
  'event', 'reminder', 'errand', 'shopping_item', 'inbox_item',
  'member', 'employee', 'product', 'expense',
] as const;
export type SearchEntity = (typeof SEARCH_ENTITIES)[number];

/** What an owning domain hands the indexer. Domains push; search never reads their tables. */
export interface SearchDocument {
  entity: SearchEntity;
  id: string;
  householdId: UUID;
  title: string;
  body?: string;
  domain?: DomainKey;
  /** Sort key for recency weighting and for tie-breaking. */
  at?: Instant;
  /** Members this row concerns; used to scope results a viewer may not see. */
  memberIds?: UUID[];
  /** Set for business rows so a household-only role cannot see the shop. */
  businessId?: UUID;
}

export interface SearchHit {
  entity: SearchEntity;
  id: string;
  title: string;
  score: number;
  domain?: DomainKey;
  at?: Instant;
  /** The matched span, with the query terms marked by `[[` … `]]`. */
  snippet: string;
}

export interface Attachment {
  id: UUID;
  householdId: UUID;
  entity: string;
  entityId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  uploadedBy: UUID;
  uploadedAt: Instant;
  /** Storage key, never a public URL — signing happens server-side. */
  storageKey: string;
}

/* ---------------------------------------------------------- morning brief */

/** PRODUCT_SPEC §10. Assembled by the AI layer, rendered by the shell. */
export interface MorningBrief {
  householdId: UUID;
  /** Local date the brief is for, in the household timezone. */
  date: CalendarDate;
  greeting: string;
  today: Occurrence[];
  tomorrow: Occurrence[];
  conflicts: Conflict[];
  reminders: Reminder[];
  errands: Errand[];
  shoppingCount: number;
  /** Shia Baby coverage problems worth waking up to. */
  staffingWarnings: string[];
  /** The next competition or game, when one is close enough to matter. */
  headline?: { title: string; startsAt: Instant; domain: DomainKey };
}

/* ------------------------------------------------------------ audit + io */

export interface AuditLog {
  id: UUID;
  householdId: UUID;
  actorMemberId: UUID | null;
  action: string;
  entity: string;
  entityId: string;
  at: Instant;
  before?: unknown;
  after?: unknown;
}

export interface ValidationIssue {
  path: string;
  message: string;
  code: 'required' | 'type' | 'range' | 'enum' | 'format' | 'permission' | 'tenant' | 'logic';
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
export const err = <T,>(issues: ValidationIssue[]): Result<T> => ({ ok: false, issues });
