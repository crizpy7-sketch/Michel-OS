import 'server-only';

/**
 * The shared read model.
 *
 * Every screen that shows a schedule computes it the same way, through here.
 * If each screen expanded recurrence and detected conflicts on its own, the
 * home screen and the calendar would eventually disagree about what is
 * happening on Wednesday — and the family would trust neither.
 *
 * This module is the only place the two scheduling engines are called.
 */
import { getRepository, HOUSEHOLD_ID, BUSINESS_ID } from './db/index.ts';
import { expandOccurrences } from '../domains/scheduling/recurrence.ts';
import { detectConflicts } from '../domains/scheduling/conflicts.ts';
import type {
  Conflict, DomainKey, Errand, Member, Occurrence, Reminder, ShoppingItem, UUID,
} from './contracts/index.ts';

/** The seeded week. Real deployments would derive this from the current date. */
export const DEFAULT_WEEK = {
  from: '2026-09-07T00:00:00.000Z',
  to: '2026-09-14T00:00:00.000Z',
};

export interface Window {
  from: string;
  to: string;
}

export interface ScheduleView {
  occurrences: Occurrence[];
  conflicts: Conflict[];
  members: Member[];
  memberById: Map<UUID, Member>;
  /** Conflicts indexed by the occurrence they touch, for badge rendering. */
  conflictsByOccurrence: Map<string, Conflict[]>;
}

export const occurrenceKey = (eventId: string, start: string): string => `${eventId}@${start}`;

/**
 * Expand every event in the window, then run conflict detection across the
 * whole household at once. Conflicts are a property of the schedule, not of a
 * single mini-app, so they must be computed over everything — a practice only
 * collides with a dentist appointment if you look at both.
 */
export function getScheduleView(window: Window = DEFAULT_WEEK, opts: { domain?: DomainKey } = {}): ScheduleView {
  const repo = getRepository();
  const members = repo.listMembers(HOUSEHOLD_ID);
  const participants = repo.listParticipants(HOUSEHOLD_ID);
  const participantsByEvent = new Map<string, string[]>();
  for (const p of participants) {
    const list = participantsByEvent.get(p.eventId) ?? [];
    list.push(p.memberId);
    participantsByEvent.set(p.eventId, list);
  }

  const events = repo.listEvents(HOUSEHOLD_ID);
  const overrides = events.filter((e) => e.seriesId);

  const all: Occurrence[] = [];
  for (const event of events) {
    if (event.seriesId) continue; // materialised overrides are applied by the engine
    all.push(
      ...expandOccurrences(event, window, {
        participantIds: participantsByEvent.get(event.id) ?? [],
        overrides: overrides.filter((o) => o.seriesId === event.id),
      }),
    );
  }
  all.sort((a, b) => (a.occurrenceStart < b.occurrenceStart ? -1 : a.occurrenceStart > b.occurrenceStart ? 1 : 0));

  const business = repo.getBusiness(HOUSEHOLD_ID);
  const shifts = business ? repo.listShifts(BUSINESS_ID) : [];
  const employees = business ? repo.listEmployees(BUSINESS_ID) : [];
  const employeeMemberIds: Record<string, string> = {};
  for (const e of employees) if (e.memberId) employeeMemberIds[e.id] = e.memberId;

  const minorMemberIds = members.filter((m) => m.role === 'child').map((m) => m.id);

  const conflicts = detectConflicts({
    householdId: HOUSEHOLD_ID,
    occurrences: all,
    participants: participants.map((p) => ({ eventId: p.eventId, memberId: p.memberId, role: p.role })),
    shifts,
    employeeMemberIds,
    minorMemberIds,
    memberNames: Object.fromEntries(members.map((m) => [m.id, m.displayName])),
    timezone: 'America/Chicago',
  });

  const conflictsByOccurrence = new Map<string, Conflict[]>();
  for (const c of conflicts) {
    for (const ref of c.occurrenceRefs) {
      const key = occurrenceKey(ref.eventId, ref.occurrenceStart);
      const list = conflictsByOccurrence.get(key) ?? [];
      list.push(c);
      conflictsByOccurrence.set(key, list);
    }
  }

  const occurrences = opts.domain ? all.filter((o) => o.domain === opts.domain) : all;

  return {
    occurrences,
    conflicts,
    members,
    memberById: new Map(members.map((m) => [m.id, m])),
    conflictsByOccurrence,
  };
}

export interface MorningBrief {
  today: Occurrence[];
  tomorrow: Occurrence[];
  conflicts: Conflict[];
  reminders: Reminder[];
  errands: Errand[];
  shoppingCount: number;
  /** Published shifts with nobody assigned — PRODUCT_SPEC §10 staffing warnings. */
  unstaffedShifts: number;
  lowStockCount: number;
}

const dayOf = (instant: string): string => instant.slice(0, 10);

/** PRODUCT_SPEC §10. `asOf` is injected so the brief is testable and deterministic. */
export function getMorningBrief(asOf: string = DEFAULT_WEEK.from): MorningBrief {
  const repo = getRepository();
  const view = getScheduleView();
  const today = dayOf(asOf);
  const tomorrow = dayOf(new Date(new Date(asOf).getTime() + 86_400_000).toISOString());

  const business = repo.getBusiness(HOUSEHOLD_ID);
  const shifts = business ? repo.listShifts(BUSINESS_ID) : [];
  const products = business ? repo.listProducts(BUSINESS_ID) : [];

  return {
    today: view.occurrences.filter((o) => dayOf(o.occurrenceStart) === today),
    tomorrow: view.occurrences.filter((o) => dayOf(o.occurrenceStart) === tomorrow),
    conflicts: view.conflicts,
    reminders: repo.listReminders(HOUSEHOLD_ID).filter((r) => r.status === 'pending'),
    errands: repo.listErrands(HOUSEHOLD_ID).filter((e) => e.status !== 'done' && e.status !== 'cancelled'),
    shoppingCount: repo.listShoppingItems(HOUSEHOLD_ID).filter((i) => i.status === 'needed').length,
    unstaffedShifts: shifts.filter((s) => s.status === 'published' && s.employeeId === null).length,
    lowStockCount: products.filter((p) => p.quantityOnHand <= p.reorderPoint).length,
  };
}

export interface ShoppingView {
  lists: Array<{ name: string; items: ShoppingItem[] }>;
  neededCount: number;
}

export function getShoppingView(): ShoppingView {
  const items = getRepository().listShoppingItems(HOUSEHOLD_ID);
  const byList = new Map<string, ShoppingItem[]>();
  for (const item of items) {
    const list = byList.get(item.listName) ?? [];
    list.push(item);
    byList.set(item.listName, list);
  }
  return {
    lists: [...byList.entries()].map(([name, list]) => ({ name, items: list })).sort((a, b) => (a.name < b.name ? -1 : 1)),
    neededCount: items.filter((i) => i.status === 'needed').length,
  };
}
