/**
 * Local SQLite implementation of the Repository seam.
 *
 * Uses node:sqlite, which ships inside Node 22 — no native module, no install,
 * no service to provision. That is what lets the app actually run today while
 * supabase/migrations/0001_init.sql waits for credentials.
 *
 * Tenancy discipline: every statement that touches a household-scoped table
 * carries `household_id = ?` in its WHERE clause. Not because the UI is
 * expected to misbehave, but because a store that *can* return another
 * family's rows will eventually be asked to.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AuditLog, Business, Employee, Errand, EventParticipant, EventRecord, Expense,
  Household, InboxItem, Member, Product, RecurrenceRule, Reminder, Sale,
  Schedule, Shift, ShoppingItem, UUID,
} from '../contracts/index.ts';
import type { EventWithParticipants, Repository } from './repository.ts';

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const strOrUndef = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const bool = (v: unknown): boolean => num(v) === 1;

export class SqliteRepository implements Repository {
  readonly #db: DatabaseSync;

  constructor(location = ':memory:') {
    this.#db = new DatabaseSync(location);
    const here = dirname(fileURLToPath(import.meta.url));
    this.#db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  }

  /** Escape hatch for the seeder only. Screens must use the typed methods. */
  get raw(): DatabaseSync {
    return this.#db;
  }

  #all(sql: string, ...params: unknown[]): Row[] {
    return this.#db.prepare(sql).all(...(params as never[])) as Row[];
  }

  #get(sql: string, ...params: unknown[]): Row | undefined {
    return this.#db.prepare(sql).get(...(params as never[])) as Row | undefined;
  }

  #run(sql: string, ...params: unknown[]): void {
    this.#db.prepare(sql).run(...(params as never[]));
  }

  /* -------------------------------------------------------- household */

  getHousehold(householdId: UUID): Household | null {
    const r = this.#get('SELECT * FROM households WHERE id = ?', householdId);
    if (!r) return null;
    return { id: str(r.id), name: str(r.name), timezone: str(r.timezone), createdAt: str(r.created_at) };
  }

  listMembers(householdId: UUID): Member[] {
    return this.#all('SELECT * FROM members WHERE household_id = ? ORDER BY display_name', householdId).map(
      (r): Member => ({
        id: str(r.id),
        householdId: str(r.household_id),
        userId: strOrNull(r.user_id),
        displayName: str(r.display_name),
        role: str(r.role) as Member['role'],
        color: str(r.color),
        active: bool(r.active),
      }),
    );
  }

  getMember(householdId: UUID, memberId: UUID): Member | null {
    return this.listMembers(householdId).find((m) => m.id === memberId) ?? null;
  }

  /* ------------------------------------------------------- scheduling */

  listSchedules(householdId: UUID): Schedule[] {
    return this.#all('SELECT * FROM schedules WHERE household_id = ? ORDER BY name', householdId).map(
      (r): Schedule => ({
        id: str(r.id),
        householdId: str(r.household_id),
        domain: str(r.domain) as Schedule['domain'],
        name: str(r.name),
        color: str(r.color),
        archived: bool(r.archived),
      }),
    );
  }

  #toEvent(r: Row): EventRecord {
    const recurrenceRaw = strOrUndef(r.recurrence);
    let recurrence: RecurrenceRule | undefined;
    if (recurrenceRaw) {
      try {
        recurrence = JSON.parse(recurrenceRaw) as RecurrenceRule;
      } catch {
        recurrence = undefined; // corrupt rule degrades to a one-off, never throws
      }
    }
    return {
      id: str(r.id),
      householdId: str(r.household_id),
      scheduleId: str(r.schedule_id),
      domain: str(r.domain) as EventRecord['domain'],
      title: str(r.title),
      notes: strOrUndef(r.notes),
      location: strOrUndef(r.location),
      startsAt: str(r.starts_at),
      endsAt: str(r.ends_at),
      allDay: bool(r.all_day),
      timezone: str(r.timezone),
      status: str(r.status) as EventRecord['status'],
      createdBy: str(r.created_by),
      recurrence,
      seriesId: strOrUndef(r.series_id),
      recurrenceId: strOrUndef(r.recurrence_id),
    };
  }

  listEvents(householdId: UUID, opts: { domain?: string; seriesId?: UUID } = {}): EventRecord[] {
    let sql = 'SELECT * FROM events WHERE household_id = ?';
    const params: unknown[] = [householdId];
    if (opts.domain) {
      sql += ' AND domain = ?';
      params.push(opts.domain);
    }
    if (opts.seriesId) {
      sql += ' AND series_id = ?';
      params.push(opts.seriesId);
    }
    sql += ' ORDER BY starts_at';
    return this.#all(sql, ...params).map((r) => this.#toEvent(r));
  }

  getEvent(householdId: UUID, eventId: UUID): EventWithParticipants | null {
    const r = this.#get('SELECT * FROM events WHERE household_id = ? AND id = ?', householdId, eventId);
    if (!r) return null;
    const participants = this.#all(
      `SELECT p.* FROM event_participants p
       JOIN events e ON e.id = p.event_id
       WHERE p.event_id = ? AND e.household_id = ?`,
      eventId,
      householdId,
    ).map((p): EventParticipant => ({
      eventId: str(p.event_id),
      memberId: str(p.member_id),
      role: str(p.role) as EventParticipant['role'],
    }));
    return { event: this.#toEvent(r), participants };
  }

  listParticipants(householdId: UUID): EventParticipant[] {
    return this.#all(
      `SELECT p.* FROM event_participants p
       JOIN events e ON e.id = p.event_id
       WHERE e.household_id = ?`,
      householdId,
    ).map((p): EventParticipant => ({
      eventId: str(p.event_id),
      memberId: str(p.member_id),
      role: str(p.role) as EventParticipant['role'],
    }));
  }

  insertEvent(householdId: UUID, event: EventRecord, participants: EventParticipant[]): EventRecord {
    this.#run(
      `INSERT INTO events (id, household_id, schedule_id, domain, title, notes, location,
        starts_at, ends_at, all_day, timezone, status, created_by, recurrence, series_id, recurrence_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      event.id,
      householdId, // tenant comes from the caller's scope, never from the payload
      event.scheduleId,
      event.domain,
      event.title,
      event.notes ?? null,
      event.location ?? null,
      event.startsAt,
      event.endsAt,
      event.allDay ? 1 : 0,
      event.timezone,
      event.status,
      event.createdBy,
      event.recurrence ? JSON.stringify(event.recurrence) : null,
      event.seriesId ?? null,
      event.recurrenceId ?? null,
    );
    for (const p of participants) {
      this.#run(
        'INSERT OR REPLACE INTO event_participants (event_id, member_id, role) VALUES (?,?,?)',
        event.id,
        p.memberId,
        p.role,
      );
    }
    return { ...event, householdId };
  }

  updateEvent(householdId: UUID, eventId: UUID, patch: Partial<EventRecord>): EventRecord | null {
    const existing = this.#get('SELECT * FROM events WHERE household_id = ? AND id = ?', householdId, eventId);
    if (!existing) return null;

    const columns: Record<string, string> = {
      title: 'title', notes: 'notes', location: 'location', startsAt: 'starts_at',
      endsAt: 'ends_at', status: 'status', scheduleId: 'schedule_id', domain: 'domain',
      allDay: 'all_day', timezone: 'timezone',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      const value = (patch as Record<string, unknown>)[key];
      sets.push(`${column} = ?`);
      params.push(key === 'allDay' ? (value ? 1 : 0) : (value ?? null));
    }
    if ('recurrence' in patch) {
      sets.push('recurrence = ?');
      params.push(patch.recurrence ? JSON.stringify(patch.recurrence) : null);
    }
    if (sets.length === 0) return this.#toEvent(existing);

    params.push(householdId, eventId);
    this.#run(`UPDATE events SET ${sets.join(', ')} WHERE household_id = ? AND id = ?`, ...params);
    const updated = this.#get('SELECT * FROM events WHERE household_id = ? AND id = ?', householdId, eventId);
    return updated ? this.#toEvent(updated) : null;
  }

  cancelEvent(householdId: UUID, eventId: UUID): boolean {
    const before = this.#get('SELECT id FROM events WHERE household_id = ? AND id = ?', householdId, eventId);
    if (!before) return false;
    this.#run("UPDATE events SET status = 'cancelled' WHERE household_id = ? AND id = ?", householdId, eventId);
    return true;
  }

  /* ------------------------------------------- personal organisation */

  listReminders(householdId: UUID): Reminder[] {
    return this.#all('SELECT * FROM reminders WHERE household_id = ? ORDER BY due_at', householdId).map(
      (r): Reminder => ({
        id: str(r.id),
        householdId: str(r.household_id),
        eventId: strOrUndef(r.event_id),
        title: str(r.title),
        dueAt: str(r.due_at),
        assignedTo: strOrUndef(r.assigned_to),
        status: str(r.status) as Reminder['status'],
      }),
    );
  }

  insertReminder(householdId: UUID, reminder: Reminder): Reminder {
    this.#run(
      'INSERT INTO reminders (id, household_id, event_id, title, due_at, assigned_to, status) VALUES (?,?,?,?,?,?,?)',
      reminder.id, householdId, reminder.eventId ?? null, reminder.title,
      reminder.dueAt, reminder.assignedTo ?? null, reminder.status,
    );
    return { ...reminder, householdId };
  }

  updateReminderStatus(householdId: UUID, reminderId: UUID, status: Reminder['status']): boolean {
    const found = this.#get('SELECT id FROM reminders WHERE household_id = ? AND id = ?', householdId, reminderId);
    if (!found) return false;
    this.#run('UPDATE reminders SET status = ? WHERE household_id = ? AND id = ?', status, householdId, reminderId);
    return true;
  }

  listShoppingItems(householdId: UUID): ShoppingItem[] {
    return this.#all('SELECT * FROM shopping_items WHERE household_id = ? ORDER BY list_name, name', householdId).map(
      (r): ShoppingItem => ({
        id: str(r.id),
        householdId: str(r.household_id),
        listName: str(r.list_name),
        name: str(r.name),
        quantity: num(r.quantity),
        status: str(r.status) as ShoppingItem['status'],
      }),
    );
  }

  insertShoppingItem(householdId: UUID, item: ShoppingItem): ShoppingItem {
    this.#run(
      'INSERT INTO shopping_items (id, household_id, list_name, name, quantity, status) VALUES (?,?,?,?,?,?)',
      item.id, householdId, item.listName, item.name, item.quantity, item.status,
    );
    return { ...item, householdId };
  }

  updateShoppingStatus(householdId: UUID, itemId: UUID, status: ShoppingItem['status']): boolean {
    const found = this.#get('SELECT id FROM shopping_items WHERE household_id = ? AND id = ?', householdId, itemId);
    if (!found) return false;
    this.#run('UPDATE shopping_items SET status = ? WHERE household_id = ? AND id = ?', status, householdId, itemId);
    return true;
  }

  listErrands(householdId: UUID): Errand[] {
    return this.#all('SELECT * FROM errands WHERE household_id = ? ORDER BY COALESCE(due_at, title)', householdId).map(
      (r): Errand => ({
        id: str(r.id),
        householdId: str(r.household_id),
        title: str(r.title),
        assignedTo: strOrUndef(r.assigned_to),
        dueAt: strOrUndef(r.due_at),
        status: str(r.status) as Errand['status'],
      }),
    );
  }

  insertErrand(householdId: UUID, errand: Errand): Errand {
    this.#run(
      'INSERT INTO errands (id, household_id, title, assigned_to, due_at, status) VALUES (?,?,?,?,?,?)',
      errand.id, householdId, errand.title, errand.assignedTo ?? null, errand.dueAt ?? null, errand.status,
    );
    return { ...errand, householdId };
  }

  updateErrandStatus(householdId: UUID, errandId: UUID, status: Errand['status']): boolean {
    const found = this.#get('SELECT id FROM errands WHERE household_id = ? AND id = ?', householdId, errandId);
    if (!found) return false;
    this.#run('UPDATE errands SET status = ? WHERE household_id = ? AND id = ?', status, householdId, errandId);
    return true;
  }

  listInbox(householdId: UUID): InboxItem[] {
    return this.#all('SELECT * FROM inbox_items WHERE household_id = ? ORDER BY captured_at DESC', householdId).map(
      (r): InboxItem => ({
        id: str(r.id),
        householdId: str(r.household_id),
        rawText: str(r.raw_text),
        capturedBy: str(r.captured_by),
        capturedAt: str(r.captured_at),
        suggestedDomain: strOrUndef(r.suggested_domain) as InboxItem['suggestedDomain'],
        status: str(r.status) as InboxItem['status'],
      }),
    );
  }

  insertInboxItem(householdId: UUID, item: InboxItem): InboxItem {
    this.#run(
      'INSERT INTO inbox_items (id, household_id, raw_text, captured_by, captured_at, suggested_domain, status) VALUES (?,?,?,?,?,?,?)',
      item.id, householdId, item.rawText, item.capturedBy, item.capturedAt,
      item.suggestedDomain ?? null, item.status,
    );
    return { ...item, householdId };
  }

  updateInboxStatus(householdId: UUID, itemId: UUID, status: InboxItem['status'], suggestedDomain?: string): boolean {
    const found = this.#get('SELECT id FROM inbox_items WHERE household_id = ? AND id = ?', householdId, itemId);
    if (!found) return false;
    this.#run(
      'UPDATE inbox_items SET status = ?, suggested_domain = COALESCE(?, suggested_domain) WHERE household_id = ? AND id = ?',
      status, suggestedDomain ?? null, householdId, itemId,
    );
    return true;
  }

  /* --------------------------------------------------------- business */

  getBusiness(householdId: UUID): Business | null {
    const r = this.#get('SELECT * FROM businesses WHERE household_id = ?', householdId);
    if (!r) return null;
    return {
      id: str(r.id),
      householdId: str(r.household_id),
      name: str(r.name),
      timezone: str(r.timezone),
      taxSetAsideRate: num(r.tax_set_aside_rate),
    };
  }

  listEmployees(businessId: UUID): Employee[] {
    return this.#all('SELECT * FROM employees WHERE business_id = ? ORDER BY display_name', businessId).map(
      (r): Employee => ({
        id: str(r.id),
        businessId: str(r.business_id),
        memberId: strOrNull(r.member_id),
        displayName: str(r.display_name),
        hourlyRate: num(r.hourly_rate),
        active: bool(r.active),
      }),
    );
  }

  listShifts(businessId: UUID): Shift[] {
    return this.#all('SELECT * FROM shifts WHERE business_id = ? ORDER BY starts_at', businessId).map(
      (r): Shift => ({
        id: str(r.id),
        businessId: str(r.business_id),
        employeeId: strOrNull(r.employee_id),
        startsAt: str(r.starts_at),
        endsAt: str(r.ends_at),
        status: str(r.status) as Shift['status'],
        role: strOrUndef(r.role),
      }),
    );
  }

  insertShift(businessId: UUID, shift: Shift): Shift {
    this.#run(
      'INSERT INTO shifts (id, business_id, employee_id, starts_at, ends_at, status, role) VALUES (?,?,?,?,?,?,?)',
      shift.id, businessId, shift.employeeId ?? null, shift.startsAt, shift.endsAt, shift.status, shift.role ?? null,
    );
    return { ...shift, businessId };
  }

  assignShift(businessId: UUID, shiftId: UUID, employeeId: UUID | null): boolean {
    const found = this.#get('SELECT id FROM shifts WHERE business_id = ? AND id = ?', businessId, shiftId);
    if (!found) return false;
    this.#run('UPDATE shifts SET employee_id = ? WHERE business_id = ? AND id = ?', employeeId, businessId, shiftId);
    return true;
  }

  listProducts(businessId: UUID): Product[] {
    return this.#all('SELECT * FROM products WHERE business_id = ? ORDER BY name', businessId).map(
      (r): Product => ({
        id: str(r.id),
        businessId: str(r.business_id),
        sku: str(r.sku),
        name: str(r.name),
        quantityOnHand: num(r.quantity_on_hand),
        reorderPoint: num(r.reorder_point),
        unitCost: num(r.unit_cost),
        unitPrice: num(r.unit_price),
      }),
    );
  }

  adjustInventory(businessId: UUID, productId: UUID, delta: number): Product | null {
    const found = this.#get('SELECT * FROM products WHERE business_id = ? AND id = ?', businessId, productId);
    if (!found) return null;
    const next = Math.max(0, num(found.quantity_on_hand) + delta);
    this.#run('UPDATE products SET quantity_on_hand = ? WHERE business_id = ? AND id = ?', next, businessId, productId);
    return this.listProducts(businessId).find((p) => p.id === productId) ?? null;
  }

  listSales(businessId: UUID): Sale[] {
    return this.#all('SELECT * FROM sales WHERE business_id = ? ORDER BY occurred_at DESC', businessId).map(
      (r): Sale => ({
        id: str(r.id),
        businessId: str(r.business_id),
        occurredAt: str(r.occurred_at),
        total: num(r.total),
        taxCollected: num(r.tax_collected),
        note: strOrUndef(r.note),
      }),
    );
  }

  listExpenses(businessId: UUID): Expense[] {
    return this.#all('SELECT * FROM expenses WHERE business_id = ? ORDER BY occurred_at DESC', businessId).map(
      (r): Expense => ({
        id: str(r.id),
        businessId: str(r.business_id),
        occurredAt: str(r.occurred_at),
        vendor: str(r.vendor),
        category: str(r.category),
        amount: num(r.amount),
        description: strOrUndef(r.description),
      }),
    );
  }

  insertExpense(businessId: UUID, expense: Expense): Expense {
    this.#run(
      'INSERT INTO expenses (id, business_id, occurred_at, vendor, category, amount, description) VALUES (?,?,?,?,?,?,?)',
      expense.id, businessId, expense.occurredAt, expense.vendor, expense.category,
      expense.amount, expense.description ?? null,
    );
    return { ...expense, businessId };
  }

  /* ------------------------------------------------------------ audit */

  appendAudit(entry: AuditLog): void {
    this.#run(
      'INSERT INTO audit_log (id, household_id, actor_member_id, action, entity, entity_id, at, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?)',
      entry.id, entry.householdId, entry.actorMemberId, entry.action, entry.entity,
      entry.entityId, entry.at,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    );
  }

  listAudit(householdId: UUID, limit = 50): AuditLog[] {
    return this.#all('SELECT * FROM audit_log WHERE household_id = ? ORDER BY at DESC LIMIT ?', householdId, limit).map(
      (r): AuditLog => ({
        id: str(r.id),
        householdId: str(r.household_id),
        actorMemberId: strOrNull(r.actor_member_id),
        action: str(r.action),
        entity: str(r.entity),
        entityId: str(r.entity_id),
        at: str(r.at),
      }),
    );
  }
}
