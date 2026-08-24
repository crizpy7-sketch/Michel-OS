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
 */

export const CONTRACT_VERSION = '1.0.0-frozen';

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
  'event.delete',
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

export interface Conflict {
  id: string; // deterministic hash — same inputs must yield same id
  householdId: UUID;
  kind: ConflictKind;
  severity: Severity;
  memberIds: UUID[];
  occurrenceRefs: Array<{ eventId: UUID; occurrenceStart: Instant }>;
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

export interface Product {
  id: UUID;
  businessId: UUID;
  sku: string;
  name: string;
  quantityOnHand: number;
  reorderPoint: number;
  unitCost: number;
  unitPrice: number;
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
