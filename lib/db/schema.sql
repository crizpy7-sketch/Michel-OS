-- Michel-OS local schema (SQLite dialect, node:sqlite).
--
-- This mirrors supabase/migrations/0001_init.sql, which is the real Postgres
-- schema with row-level security. The duplication is deliberate and temporary:
-- the app has to run today, and provisioning Supabase needs credentials this
-- environment does not have. Both files are generated from the same frozen
-- contracts in lib/contracts/index.ts, and lib/db/repository.ts is the seam
-- that lets the Supabase adapter drop in without touching a single screen.
--
-- Tenancy is enforced in lib/db/sqlite.ts by requiring householdId on every
-- read and write. In Postgres it is enforced again by RLS, because the app
-- layer is not a security boundary you get to trust on its own.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS households (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  timezone    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id       TEXT,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL,
  color         TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS members_household ON members(household_id);

CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  domain        TEXT NOT NULL,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL,
  archived      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS schedules_household ON schedules(household_id);

CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  household_id   TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  schedule_id    TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  domain         TEXT NOT NULL,
  title          TEXT NOT NULL,
  notes          TEXT,
  location       TEXT,
  starts_at      TEXT NOT NULL,
  ends_at        TEXT NOT NULL,
  all_day        INTEGER NOT NULL DEFAULT 0,
  timezone       TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  recurrence     TEXT,            -- JSON RecurrenceRule
  series_id      TEXT,
  recurrence_id  TEXT
);
CREATE INDEX IF NOT EXISTS events_household_start ON events(household_id, starts_at);
CREATE INDEX IF NOT EXISTS events_series ON events(series_id);

CREATE TABLE IF NOT EXISTS event_participants (
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  PRIMARY KEY (event_id, member_id)
);

CREATE TABLE IF NOT EXISTS reminders (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  event_id      TEXT REFERENCES events(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  due_at        TEXT NOT NULL,
  assigned_to   TEXT REFERENCES members(id) ON DELETE SET NULL,
  status        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reminders_household_due ON reminders(household_id, due_at);

CREATE TABLE IF NOT EXISTS shopping_items (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  list_name     TEXT NOT NULL,
  name          TEXT NOT NULL,
  quantity      REAL NOT NULL DEFAULT 1,
  status        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shopping_household ON shopping_items(household_id);

CREATE TABLE IF NOT EXISTS errands (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  assigned_to   TEXT REFERENCES members(id) ON DELETE SET NULL,
  due_at        TEXT,
  status        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS errands_household ON errands(household_id);

CREATE TABLE IF NOT EXISTS inbox_items (
  id                TEXT PRIMARY KEY,
  household_id      TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  raw_text          TEXT NOT NULL,
  captured_by       TEXT NOT NULL,
  captured_at       TEXT NOT NULL,
  suggested_domain  TEXT,
  status            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_household ON inbox_items(household_id);

/* ------------------------------------------------------- Shia Baby ----- */

CREATE TABLE IF NOT EXISTS businesses (
  id                  TEXT PRIMARY KEY,
  household_id        TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  timezone            TEXT NOT NULL,
  tax_set_aside_rate  REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employees (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  member_id     TEXT REFERENCES members(id) ON DELETE SET NULL,
  display_name  TEXT NOT NULL,
  hourly_rate   REAL NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shifts (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  employee_id  TEXT REFERENCES employees(id) ON DELETE SET NULL,
  starts_at    TEXT NOT NULL,
  ends_at      TEXT NOT NULL,
  status       TEXT NOT NULL,
  role         TEXT
);
CREATE INDEX IF NOT EXISTS shifts_business_start ON shifts(business_id, starts_at);

CREATE TABLE IF NOT EXISTS products (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sku                TEXT NOT NULL,
  name               TEXT NOT NULL,
  quantity_on_hand   REAL NOT NULL DEFAULT 0,
  reorder_point      REAL NOT NULL DEFAULT 0,
  unit_cost          REAL NOT NULL DEFAULT 0,
  unit_price         REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS products_business ON products(business_id);

CREATE TABLE IF NOT EXISTS sales (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  occurred_at  TEXT NOT NULL,
  total        REAL NOT NULL,
  tax_collected REAL NOT NULL DEFAULT 0,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS sales_business_at ON sales(business_id, occurred_at);

CREATE TABLE IF NOT EXISTS expenses (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  occurred_at  TEXT NOT NULL,
  vendor       TEXT NOT NULL,
  category     TEXT NOT NULL,
  amount       REAL NOT NULL,
  description  TEXT
);
CREATE INDEX IF NOT EXISTS expenses_business_at ON expenses(business_id, occurred_at);

/* ------------------------------------------------------------ audit ---- */

CREATE TABLE IF NOT EXISTS audit_log (
  id               TEXT PRIMARY KEY,
  household_id     TEXT NOT NULL,
  actor_member_id  TEXT,
  action           TEXT NOT NULL,
  entity           TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  at               TEXT NOT NULL,
  before_json      TEXT,
  after_json       TEXT
);
CREATE INDEX IF NOT EXISTS audit_household_at ON audit_log(household_id, at);
