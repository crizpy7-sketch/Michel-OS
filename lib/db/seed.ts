/**
 * Seed data — one real family week, not lorem.
 *
 * The screens are only honest if the data underneath them has the shapes that
 * actually cause trouble: a recurring practice that collides with a dentist
 * appointment, a shop shift that lands on top of a school pickup, a shopping
 * list mid-week, a product under its reorder point. Empty tables make every
 * layout look fine.
 */
import { randomUUID } from 'node:crypto';
import type { SqliteRepository } from './sqlite.ts';
import type { EventParticipant, EventRecord } from '../contracts/index.ts';

export const HOUSEHOLD_ID = 'f1a5c0de-0000-4000-8000-000000000001';
export const BUSINESS_ID = 'b1a5c0de-0000-4000-8000-000000000002';

export const MEMBERS = {
  michel: 'mem-michel',
  sam: 'mem-sam',
  ana: 'mem-ana',
  noor: 'mem-noor',
  riley: 'mem-riley',
} as const;

/** Monday of the seeded week, in UTC. The app renders relative to this. */
export const WEEK_START = '2026-09-07';

const iso = (day: number, hour: number, minute = 0): string => {
  const d = new Date(Date.UTC(2026, 8, 7 + day, hour, minute, 0));
  return d.toISOString();
};

export function seed(repo: SqliteRepository): void {
  const db = repo.raw;
  const now = new Date().toISOString();

  db.exec('BEGIN');

  db.prepare('INSERT INTO households (id, name, timezone, created_at) VALUES (?,?,?,?)').run(
    HOUSEHOLD_ID, 'The Michel Household', 'America/Chicago', now,
  );

  const members: Array<[string, string | null, string, string, string]> = [
    [MEMBERS.michel, 'user-michel', 'Michel', 'owner', 'plum'],
    [MEMBERS.sam, 'user-sam', 'Sam', 'adult', 'teal'],
    [MEMBERS.ana, 'user-ana', 'Ana', 'teen', 'amber'],
    [MEMBERS.noor, null, 'Noor', 'child', 'coral'],
    [MEMBERS.riley, 'user-riley', 'Riley', 'employee', 'slate'],
  ];
  for (const [id, userId, name, role, color] of members) {
    db.prepare(
      'INSERT INTO members (id, household_id, user_id, display_name, role, color, active) VALUES (?,?,?,?,?,?,1)',
    ).run(id, HOUSEHOLD_ID, userId, name, role, color);
  }

  const schedules: Array<[string, string, string, string]> = [
    ['sch-appointments', 'appointments', 'Appointments', 'coral'],
    ['sch-practice', 'practice', 'Practice', 'teal'],
    ['sch-competition', 'competition', 'Competition', 'plum'],
    ['sch-games', 'games', 'Games', 'amber'],
    ['sch-school', 'school', 'School', 'sky'],
    ['sch-work', 'work', 'Hubby Work', 'slate'],
    ['sch-shia', 'shia-baby', 'Shia Baby', 'gold'],
    ['sch-general', 'general', 'General', 'graphite'],
  ];
  for (const [id, domain, name, color] of schedules) {
    db.prepare('INSERT INTO schedules (id, household_id, domain, name, color, archived) VALUES (?,?,?,?,?,0)').run(
      id, HOUSEHOLD_ID, domain, name, color,
    );
  }

  const events: Array<{ e: Omit<EventRecord, 'householdId'>; p: Array<[string, EventParticipant['role']]> }> = [
    {
      // Recurring, and the source of this week's headline conflict.
      e: {
        id: 'evt-practice', scheduleId: 'sch-practice', domain: 'practice',
        title: 'Soccer practice', location: 'Riverside fields',
        notes: 'Shin guards + full water bottle. Coach Ellis.',
        startsAt: iso(0, 21), endsAt: iso(0, 22, 30), allDay: false,
        timezone: 'America/Chicago', status: 'confirmed', createdBy: MEMBERS.michel,
        recurrence: { freq: 'WEEKLY', interval: 1, byWeekday: ['MO', 'WE', 'FR'], until: '2026-11-27' },
      },
      p: [[MEMBERS.ana, 'attendee'], [MEMBERS.michel, 'responsible']],
    },
    {
      e: {
        id: 'evt-dentist', scheduleId: 'sch-appointments', domain: 'appointments',
        title: 'Dentist — Noor', location: 'Dr. Vance, Oak & 12th',
        notes: 'Six-month cleaning. Insurance card in the glovebox.',
        startsAt: iso(2, 21, 30), endsAt: iso(2, 22, 30), allDay: false,
        timezone: 'America/Chicago', status: 'confirmed', createdBy: MEMBERS.michel,
      },
      p: [[MEMBERS.noor, 'attendee'], [MEMBERS.michel, 'responsible']],
    },
    {
      e: {
        id: 'evt-game', scheduleId: 'sch-games', domain: 'games',
        title: 'Valley Cats vs. Northside', location: 'Valley Cats home field',
        notes: 'Home game. Arrive 45 min early for warm-up. Blue uniform.',
        startsAt: iso(5, 19), endsAt: iso(5, 21), allDay: false,
        timezone: 'America/Chicago', status: 'confirmed', createdBy: MEMBERS.sam,
      },
      p: [[MEMBERS.ana, 'attendee'], [MEMBERS.sam, 'responsible'], [MEMBERS.michel, 'attendee']],
    },
    {
      e: {
        id: 'evt-pickup', scheduleId: 'sch-school', domain: 'school',
        title: 'Early release — school pickup', location: 'Lincoln Elementary',
        startsAt: iso(2, 18), endsAt: iso(2, 18, 30), allDay: false,
        timezone: 'America/Chicago', status: 'confirmed', createdBy: MEMBERS.michel,
      },
      p: [[MEMBERS.noor, 'attendee'], [MEMBERS.sam, 'responsible']],
    },
    {
      e: {
        id: 'evt-jobsite', scheduleId: 'sch-work', domain: 'work',
        title: 'Jobsite — Harbor Point scaffold', location: 'Harbor Point, Bay 3',
        notes: 'Scaffold design review with the site engineer.',
        startsAt: iso(1, 13), endsAt: iso(1, 23), allDay: false,
        timezone: 'America/Chicago', status: 'confirmed', createdBy: MEMBERS.sam,
      },
      p: [[MEMBERS.sam, 'attendee']],
    },
    {
      e: {
        id: 'evt-recital', scheduleId: 'sch-competition', domain: 'competition',
        title: 'Regional cheer competition', location: 'Grand Center Arena',
        notes: 'Check-in 8:00. Packing list: uniform, bow, poms, tickets.',
        startsAt: iso(6, 14), endsAt: iso(6, 20), allDay: false,
        timezone: 'America/Chicago', status: 'confirmed', createdBy: MEMBERS.michel,
      },
      p: [[MEMBERS.ana, 'attendee'], [MEMBERS.michel, 'responsible']],
    },
  ];

  for (const { e, p } of events) {
    db.prepare(
      `INSERT INTO events (id, household_id, schedule_id, domain, title, notes, location,
        starts_at, ends_at, all_day, timezone, status, created_by, recurrence, series_id, recurrence_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
    ).run(
      e.id, HOUSEHOLD_ID, e.scheduleId, e.domain, e.title, e.notes ?? null, e.location ?? null,
      e.startsAt, e.endsAt, e.allDay ? 1 : 0, e.timezone, e.status, e.createdBy,
      e.recurrence ? JSON.stringify(e.recurrence) : null,
    );
    for (const [memberId, role] of p) {
      db.prepare('INSERT INTO event_participants (event_id, member_id, role) VALUES (?,?,?)').run(e.id, memberId, role);
    }
  }

  const reminders: Array<[string, string, string, string, string]> = [
    ['rem-uniform', 'Wash Ana’s competition uniform', iso(4, 23), MEMBERS.michel, 'pending'],
    ['rem-insurance', 'Call insurance about Noor’s dental coverage', iso(1, 15), MEMBERS.michel, 'pending'],
    ['rem-registration', 'Renew truck registration', iso(3, 16), MEMBERS.sam, 'pending'],
    ['rem-tablets', 'Charge tablets for the drive', iso(5, 2), MEMBERS.ana, 'completed'],
  ];
  for (const [id, title, dueAt, assigned, status] of reminders) {
    db.prepare(
      'INSERT INTO reminders (id, household_id, event_id, title, due_at, assigned_to, status) VALUES (?,?,NULL,?,?,?,?)',
    ).run(id, HOUSEHOLD_ID, title, dueAt, assigned, status);
  }

  const shopping: Array<[string, string, string, number, string]> = [
    ['shop-milk', 'Groceries', 'Milk', 2, 'needed'],
    ['shop-eggs', 'Groceries', 'Eggs', 1, 'needed'],
    ['shop-bread', 'Groceries', 'Sourdough', 1, 'purchased'],
    ['shop-tape', 'Business', 'Packing tape', 3, 'needed'],
    ['shop-bows', 'Business', 'Hair bows (assorted)', 24, 'needed'],
    ['shop-detergent', 'Household', 'Laundry detergent', 1, 'needed'],
  ];
  for (const [id, list, name, qty, status] of shopping) {
    db.prepare(
      'INSERT INTO shopping_items (id, household_id, list_name, name, quantity, status) VALUES (?,?,?,?,?,?)',
    ).run(id, HOUSEHOLD_ID, list, name, qty, status);
  }

  const errands: Array<[string, string, string | null, string | null, string]> = [
    ['err-pharmacy', 'Pharmacy pickup — Noor’s prescription', MEMBERS.michel, iso(1, 22), 'open'],
    ['err-return', 'Return the wrong-size shoes', MEMBERS.ana, iso(3, 22), 'open'],
    ['err-bank', 'Deposit Shia Baby weekend cash', MEMBERS.michel, iso(0, 17), 'done'],
  ];
  for (const [id, title, assigned, dueAt, status] of errands) {
    db.prepare(
      'INSERT INTO errands (id, household_id, title, assigned_to, due_at, status) VALUES (?,?,?,?,?,?)',
    ).run(id, HOUSEHOLD_ID, title, assigned, dueAt, status);
  }

  const inbox: Array<[string, string, string | null, string]> = [
    ['inb-1', 'we need milk', null, 'unclassified'],
    ['inb-2', 'Mateo plays Saturday at 4', 'games', 'classified'],
    ['inb-3', 'Riley cannot work Thursday', 'shia-baby', 'unclassified'],
  ];
  for (const [id, raw, domain, status] of inbox) {
    db.prepare(
      'INSERT INTO inbox_items (id, household_id, raw_text, captured_by, captured_at, suggested_domain, status) VALUES (?,?,?,?,?,?,?)',
    ).run(id, HOUSEHOLD_ID, raw, MEMBERS.michel, iso(0, 14), domain, status);
  }

  /* ------------------------------------------------------- Shia Baby */

  db.prepare(
    'INSERT INTO businesses (id, household_id, name, timezone, tax_set_aside_rate) VALUES (?,?,?,?,?)',
  ).run(BUSINESS_ID, HOUSEHOLD_ID, 'Shia Baby', 'America/Chicago', 0.0825);

  const employees: Array<[string, string | null, string, number]> = [
    ['emp-riley', MEMBERS.riley, 'Riley', 16.5],
    ['emp-dee', null, 'Dee', 15.0],
    ['emp-jo', null, 'Jo', 17.25],
  ];
  for (const [id, memberId, name, rate] of employees) {
    db.prepare(
      'INSERT INTO employees (id, business_id, member_id, display_name, hourly_rate, active) VALUES (?,?,?,?,?,1)',
    ).run(id, BUSINESS_ID, memberId, name, rate);
  }

  const shifts: Array<[string, string | null, number, number, number, string, string]> = [
    ['shf-mon-open', 'emp-dee', 0, 14, 19, 'published', 'Opening'],
    ['shf-mon-close', 'emp-jo', 0, 19, 24, 'published', 'Closing'],
    // Riley is on the floor while the school pickup needs a responsible adult.
    ['shf-wed-open', 'emp-riley', 2, 14, 20, 'published', 'Opening'],
    ['shf-wed-close', null, 2, 20, 24, 'draft', 'Closing'],
    ['shf-fri-open', 'emp-dee', 4, 14, 19, 'published', 'Opening'],
    ['shf-sat-open', 'emp-jo', 5, 15, 21, 'published', 'Opening'],
  ];
  for (const [id, employeeId, day, startHour, endHour, status, role] of shifts) {
    db.prepare(
      'INSERT INTO shifts (id, business_id, employee_id, starts_at, ends_at, status, role) VALUES (?,?,?,?,?,?,?)',
    ).run(id, BUSINESS_ID, employeeId, iso(day, startHour), iso(day, endHour), status, role);
  }

  const products: Array<[string, string, string, number, number, number, number]> = [
    ['prd-bow-1', 'SB-BOW-001', 'Signature bear bow — blush', 42, 12, 2.4, 8.0],
    ['prd-bow-2', 'SB-BOW-002', 'Signature bear bow — navy', 8, 12, 2.4, 8.0],
    ['prd-onesie', 'SB-ONE-010', 'Bear onesie 0–3m', 26, 10, 6.75, 22.0],
    ['prd-blanket', 'SB-BLK-004', 'Knit blanket — cream', 4, 6, 11.5, 38.0],
    ['prd-set', 'SB-SET-020', 'Welcome-home gift set', 15, 5, 14.0, 46.0],
  ];
  for (const [id, sku, name, qty, reorder, cost, price] of products) {
    db.prepare(
      'INSERT INTO products (id, business_id, sku, name, quantity_on_hand, reorder_point, unit_cost, unit_price) VALUES (?,?,?,?,?,?,?,?)',
    ).run(id, BUSINESS_ID, sku, name, qty, reorder, cost, price);
  }

  const sales: Array<[string, number, number, number, string]> = [
    ['sal-1', 0, 284.5, 23.47, 'Monday counter'],
    ['sal-2', 1, 196.0, 16.17, 'Tuesday counter'],
    ['sal-3', 2, 341.25, 28.15, 'Wednesday counter'],
    ['sal-4', 3, 158.75, 13.09, 'Thursday counter'],
    ['sal-5', 4, 402.0, 33.17, 'Friday counter'],
    ['sal-6', 5, 512.25, 42.26, 'Saturday market'],
  ];
  for (const [id, day, total, tax, note] of sales) {
    db.prepare(
      'INSERT INTO sales (id, business_id, occurred_at, total, tax_collected, note) VALUES (?,?,?,?,?,?)',
    ).run(id, BUSINESS_ID, iso(day, 23), total, tax, note);
  }

  const expenses: Array<[string, number, string, string, number, string]> = [
    ['exp-1', 0, 'Ribbon Supply Co.', 'Materials', 218.4, 'Bow ribbon restock'],
    ['exp-2', 2, 'City Utilities', 'Utilities', 96.15, 'Shop electricity'],
    ['exp-3', 3, 'Pack & Ship', 'Shipping', 64.8, 'Mailers and labels'],
    ['exp-4', 4, 'Market Fees', 'Fees', 45.0, 'Saturday market booth'],
  ];
  for (const [id, day, vendor, category, amount, description] of expenses) {
    db.prepare(
      'INSERT INTO expenses (id, business_id, occurred_at, vendor, category, amount, description) VALUES (?,?,?,?,?,?,?)',
    ).run(id, BUSINESS_ID, iso(day, 18), vendor, category, amount, description);
  }

  db.prepare(
    'INSERT INTO audit_log (id, household_id, actor_member_id, action, entity, entity_id, at, before_json, after_json) VALUES (?,?,?,?,?,?,?,NULL,NULL)',
  ).run(randomUUID(), HOUSEHOLD_ID, MEMBERS.michel, 'seed', 'household', HOUSEHOLD_ID, now);

  db.exec('COMMIT');
}
