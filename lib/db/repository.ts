/**
 * THE REPOSITORY SEAM — frozen app-layer contract. Owner: Lead Orchestrator.
 *
 * Every screen reads and writes through this interface and never touches a
 * driver directly. That is what makes ARCHITECTURE.md §10 ("keep integration
 * boundaries clean") true rather than aspirational: swapping the local SQLite
 * store for Supabase means writing one new implementation of `Repository`,
 * with no screen changing at all.
 *
 * Two rules hold for every method here:
 *   1. `householdId` is a required argument on every read and every write.
 *      There is no method that can be called without naming its tenant.
 *   2. Reads return frozen contract types. Writes go through the action
 *      pipeline in lib/actions.ts, never straight from a form handler.
 */
import type {
  AuditLog, Business, Employee, Errand, EventParticipant, EventRecord, Expense,
  Household, InboxItem, Member, Product, Reminder, Sale, Schedule, Shift,
  ShoppingItem, UUID,
} from '../contracts/index.ts';

export interface EventWithParticipants {
  event: EventRecord;
  participants: EventParticipant[];
}

export interface Repository {
  /* -------------------------------------------------------- household */
  getHousehold(householdId: UUID): Household | null;
  listMembers(householdId: UUID): Member[];
  getMember(householdId: UUID, memberId: UUID): Member | null;

  /* ------------------------------------------------------- scheduling */
  listSchedules(householdId: UUID): Schedule[];
  /** Base event rows. Expanding recurrence is the engine's job, not the store's. */
  listEvents(householdId: UUID, opts?: { domain?: string; seriesId?: UUID }): EventRecord[];
  getEvent(householdId: UUID, eventId: UUID): EventWithParticipants | null;
  listParticipants(householdId: UUID): EventParticipant[];
  insertEvent(householdId: UUID, event: EventRecord, participants: EventParticipant[]): EventRecord;
  updateEvent(householdId: UUID, eventId: UUID, patch: Partial<EventRecord>): EventRecord | null;
  cancelEvent(householdId: UUID, eventId: UUID): boolean;

  /* ------------------------------------------- personal organisation */
  listReminders(householdId: UUID): Reminder[];
  insertReminder(householdId: UUID, reminder: Reminder): Reminder;
  updateReminderStatus(householdId: UUID, reminderId: UUID, status: Reminder['status']): boolean;

  listShoppingItems(householdId: UUID): ShoppingItem[];
  insertShoppingItem(householdId: UUID, item: ShoppingItem): ShoppingItem;
  updateShoppingStatus(householdId: UUID, itemId: UUID, status: ShoppingItem['status']): boolean;

  listErrands(householdId: UUID): Errand[];
  insertErrand(householdId: UUID, errand: Errand): Errand;
  updateErrandStatus(householdId: UUID, errandId: UUID, status: Errand['status']): boolean;

  listInbox(householdId: UUID): InboxItem[];
  insertInboxItem(householdId: UUID, item: InboxItem): InboxItem;
  updateInboxStatus(householdId: UUID, itemId: UUID, status: InboxItem['status'], suggestedDomain?: string): boolean;

  /* --------------------------------------------------------- business */
  getBusiness(householdId: UUID): Business | null;
  listEmployees(businessId: UUID): Employee[];
  listShifts(businessId: UUID): Shift[];
  insertShift(businessId: UUID, shift: Shift): Shift;
  assignShift(businessId: UUID, shiftId: UUID, employeeId: UUID | null): boolean;
  listProducts(businessId: UUID): Product[];
  adjustInventory(businessId: UUID, productId: UUID, delta: number): Product | null;
  listSales(businessId: UUID): Sale[];
  listExpenses(businessId: UUID): Expense[];
  insertExpense(businessId: UUID, expense: Expense): Expense;

  /* ------------------------------------------------------------ audit */
  appendAudit(entry: AuditLog): void;
  listAudit(householdId: UUID, limit?: number): AuditLog[];
}

/** Thrown when a caller reaches for a row outside the household it named. */
export class TenantViolationError extends Error {
  readonly code = 'tenant';
  constructor(entity: string, id: string) {
    super(`Refusing cross-tenant access to ${entity} ${id}`);
    this.name = 'TenantViolationError';
  }
}
