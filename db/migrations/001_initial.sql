-- Michel-OS — initial schema, derived from lib/contracts/index.ts v1.1.0-frozen.
--
-- Rules this file follows, all of them consequences of decisions already made
-- elsewhere in the repository:
--
--   1. The contracts are the source of truth. Every table here mirrors a frozen
--      interface. The database does not invent shapes, and every CHECK
--      constraint enumerating strings mirrors a frozen union type exactly. If
--      the two ever disagree, a test fails rather than a user seeing it.
--   2. Tenancy is structural. Every row that belongs to a household carries
--      `household_id`, and every foreign key cascades from it. There is no
--      table you can reach that does not tell you whose it is.
--   3. Money is BIGINT minor units. Never a float, never NUMERIC-with-scale
--      guesswork. `_cents` is in every column name that holds money.
--   4. Instants are TIMESTAMPTZ. Local calendar dates that are genuinely
--      date-only (recurrence UNTIL, exception dates) are DATE.
--
-- ARCHITECTURE.md §8 requires row-level security. RLS lands in 002 so this file
-- stays readable as pure structure; the kernel in domains/household is still
-- the access decision, and RLS is defence in depth behind it (ADR-001).

-- No extensions. `gen_random_uuid()` has been core Postgres since 13, so
-- requiring pgcrypto would buy nothing and would make the schema depend on an
-- extension that is absent from some images (PGlite among them) — meaning the
-- schema under test would not be the schema in production.

/* ------------------------------------------------------------- households */

create table household (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null check (length(trim(name)) > 0),
  timezone    text        not null,
  created_at  timestamptz not null default now()
);

-- A login. Separate from `member` because a person can belong to more than one
-- household, and because a managed child profile has a member row and no login
-- at all (contracts: `Member.userId` is nullable).
--
-- Email uniqueness is case-insensitive via a functional index rather than the
-- `citext` extension: citext is not present in every Postgres image and PGlite
-- does not ship it, so an extension dependency here would mean the schema
-- tested in CI was not the schema running in production.
create table app_user (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  display_name   text not null check (length(trim(display_name)) > 0),
  password_hash  text not null,
  created_at     timestamptz not null default now()
);
create unique index app_user_email_key on app_user (lower(email));

create table member (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  user_id       uuid references app_user(id) on delete set null,
  display_name  text not null check (length(trim(display_name)) > 0),
  role          text not null check (role in ('owner','adult','teen','child','employee','viewer')),
  color         text not null default 'slate',
  active        boolean not null default true
);
create index member_household_idx on member (household_id);
-- One membership per person per household. Managed profiles (user_id null) are
-- exempt, which is why this is a partial index rather than a plain unique.
create unique index member_user_household_key
  on member (household_id, user_id) where user_id is not null;

-- A household must always have at least one owner. Enforced in the repository
-- layer on demotion/deactivation; recorded here so the intent is discoverable
-- from the schema alone.
comment on table member is
  'A person in a household. At least one active owner must exist at all times.';

create table invitation (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  -- The token is stored hashed. A leaked database backup must not be a set of
  -- working invitation links.
  token_hash    text not null unique,
  role          text not null check (role in ('owner','adult','teen','child','employee','viewer')),
  email         text,
  created_by    uuid not null references member(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  accepted_by   uuid references member(id) on delete set null
);
create index invitation_household_idx on invitation (household_id);

-- Sessions are rows so that "sign out everywhere" is a DELETE, and so a stolen
-- cookie can be revoked. The cookie carries an opaque id; the secret half is
-- hashed here, never stored in the clear.
create table session (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app_user(id) on delete cascade,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  user_agent    text
);
create index session_user_idx on session (user_id);
create index session_expiry_idx on session (expires_at);

/* -------------------------------------------------------------- scheduling */

create table schedule (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  domain        text not null check (domain in (
                  'appointments','practice','competition','games','school','errands',
                  'shopping','reminders','work','shia-baby','inbox','general')),
  name          text not null,
  color         text not null default 'slate',
  archived      boolean not null default false
);
create index schedule_household_idx on schedule (household_id);

create table event (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  schedule_id   uuid not null references schedule(id) on delete cascade,
  domain        text not null check (domain in (
                  'appointments','practice','competition','games','school','errands',
                  'shopping','reminders','work','shia-baby','inbox','general')),
  title         text not null check (length(trim(title)) > 0),
  notes         text,
  location      text,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  all_day       boolean not null default false,
  timezone      text not null,
  status        text not null default 'confirmed' check (status in ('confirmed','tentative','cancelled')),
  created_by    uuid not null references member(id) on delete restrict,

  -- RecurrenceRule, flattened. Kept as columns rather than JSON so the CHECKs
  -- above can actually constrain it and so `until`/`count` are queryable.
  rrule_freq        text check (rrule_freq in ('DAILY','WEEKLY','MONTHLY')),
  rrule_interval    integer check (rrule_interval >= 1),
  rrule_by_weekday  text[],
  rrule_by_monthday integer[],
  rrule_until       date,
  rrule_count       integer check (rrule_count >= 1),
  rrule_week_start  text check (rrule_week_start in ('SU','MO','TU','WE','TH','FR','SA')),

  -- Override of a single occurrence in a series.
  series_id     uuid references event(id) on delete cascade,
  recurrence_id timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A zero-length event is a data error, not a valid row.
  constraint event_span_valid check (ends_at > starts_at),
  -- Either the whole rule is present or none of it is; a freq with no interval
  -- is the kind of half-written rule that silently expands wrong.
  constraint event_rrule_coherent check (
    (rrule_freq is null and rrule_interval is null) or
    (rrule_freq is not null and rrule_interval is not null)
  ),
  -- An override must say which occurrence it replaces.
  constraint event_override_coherent check (
    (series_id is null and recurrence_id is null) or
    (series_id is not null and recurrence_id is not null)
  )
);
create index event_household_idx on event (household_id);
create index event_window_idx on event (household_id, starts_at, ends_at);
create index event_series_idx on event (series_id) where series_id is not null;
create index event_domain_idx on event (household_id, domain);

-- Dates removed from a series (contracts: RecurrenceRule.exceptions).
create table event_exception (
  event_id        uuid not null references event(id) on delete cascade,
  exception_date  date not null,
  primary key (event_id, exception_date)
);

create table event_participant (
  event_id   uuid not null references event(id) on delete cascade,
  member_id  uuid not null references member(id) on delete cascade,
  role       text not null default 'attendee' check (role in ('attendee','responsible','optional')),
  primary key (event_id, member_id)
);
create index event_participant_member_idx on event_participant (member_id);

create table reminder (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  event_id      uuid references event(id) on delete cascade,
  title         text not null check (length(trim(title)) > 0),
  due_at        timestamptz not null,
  assigned_to   uuid references member(id) on delete set null,
  status        text not null default 'pending'
                check (status in ('pending','sent','completed','snoozed','dismissed')),
  snoozed_until timestamptz,
  completed_at  timestamptz,
  rrule_freq     text check (rrule_freq in ('DAILY','WEEKLY','MONTHLY')),
  rrule_interval integer check (rrule_interval >= 1),
  rrule_until    date,
  created_at    timestamptz not null default now(),
  -- A snoozed reminder without a wake time never comes back; that is a bug,
  -- not a state.
  constraint reminder_snooze_coherent check (
    status <> 'snoozed' or snoozed_until is not null
  )
);
create index reminder_household_idx on reminder (household_id);
create index reminder_due_idx on reminder (household_id, due_at);
create index reminder_assignee_idx on reminder (assigned_to) where assigned_to is not null;

/* -------------------------------------------------- personal organization */

create table shopping_item (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  list_name     text not null default 'Household',
  name          text not null check (length(trim(name)) > 0),
  quantity      integer not null default 1 check (quantity >= 1),
  status        text not null default 'needed' check (status in ('needed','purchased','removed')),
  category      text,
  store         text,
  created_at    timestamptz not null default now()
);
create index shopping_household_idx on shopping_item (household_id, status);

create table errand (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  title         text not null check (length(trim(title)) > 0),
  assigned_to   uuid references member(id) on delete set null,
  due_at        timestamptz,
  location      text,
  status        text not null default 'open' check (status in ('open','in_progress','done','cancelled')),
  created_at    timestamptz not null default now()
);
create index errand_household_idx on errand (household_id, status);

create table inbox_item (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references household(id) on delete cascade,
  raw_text          text not null check (length(trim(raw_text)) > 0),
  captured_by       uuid not null references member(id) on delete cascade,
  captured_at       timestamptz not null default now(),
  suggested_domain  text check (suggested_domain in (
                      'appointments','practice','competition','games','school','errands',
                      'shopping','reminders','work','shia-baby','inbox','general')),
  status            text not null default 'unclassified'
                    check (status in ('unclassified','classified','converted','dismissed')),
  -- What the classifier proposed, kept for the confirmation screen and for
  -- auditing what the AI layer suggested versus what a human accepted.
  proposal          jsonb,
  converted_to      text,
  converted_id      uuid
);
create index inbox_household_idx on inbox_item (household_id, status);

/* ------------------------------------------------------ shia baby business */

create table business (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references household(id) on delete cascade,
  name                text not null check (length(trim(name)) > 0),
  timezone            text not null,
  tax_set_aside_rate  numeric(6,5) not null default 0
                      check (tax_set_aside_rate >= 0 and tax_set_aside_rate <= 1),
  created_at          timestamptz not null default now()
);
create index business_household_idx on business (household_id);

create table employee (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references business(id) on delete cascade,
  member_id    uuid references member(id) on delete set null,
  display_name text not null check (length(trim(display_name)) > 0),
  hourly_rate_cents bigint not null default 0 check (hourly_rate_cents >= 0),
  active       boolean not null default true
);
create index employee_business_idx on employee (business_id);

create table availability (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references business(id) on delete cascade,
  employee_id  uuid not null references employee(id) on delete cascade,
  weekday      text not null check (weekday in ('SU','MO','TU','WE','TH','FR','SA')),
  start_minute integer not null check (start_minute >= 0 and start_minute <= 1440),
  end_minute   integer not null check (end_minute >= 0 and end_minute <= 1440),
  available    boolean not null default true,
  preferred_weekly_hours numeric(5,2),
  constraint availability_window_valid check (end_minute > start_minute)
);
create index availability_employee_idx on availability (employee_id);

create table shift (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references business(id) on delete cascade,
  employee_id  uuid references employee(id) on delete set null,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  status       text not null default 'draft' check (status in ('draft','published','swapped','cancelled')),
  role         text,
  constraint shift_span_valid check (ends_at > starts_at)
);
create index shift_business_idx on shift (business_id, starts_at);
create index shift_employee_idx on shift (employee_id) where employee_id is not null;

create table time_off_request (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references business(id) on delete cascade,
  employee_id  uuid not null references employee(id) on delete cascade,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  status       text not null default 'requested'
               check (status in ('requested','approved','denied','cancelled')),
  reason       text,
  reviewed_by  uuid references member(id) on delete set null,
  constraint time_off_span_valid check (ends_at > starts_at)
);
create index time_off_business_idx on time_off_request (business_id, status);

create table shift_swap (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references business(id) on delete cascade,
  shift_id          uuid not null references shift(id) on delete cascade,
  from_employee_id  uuid not null references employee(id) on delete cascade,
  to_employee_id    uuid references employee(id) on delete set null,
  status            text not null default 'requested'
                    check (status in ('requested','accepted','approved','declined','cancelled')),
  reviewed_by       uuid references member(id) on delete set null,
  -- A shift cannot be swapped to the person giving it up.
  constraint shift_swap_distinct check (to_employee_id is null or to_employee_id <> from_employee_id)
);
create index shift_swap_business_idx on shift_swap (business_id, status);

create table product (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references business(id) on delete cascade,
  sku               text not null,
  name              text not null check (length(trim(name)) > 0),
  quantity_on_hand  integer not null default 0,   -- may go negative: a shop can oversell
  reorder_point     integer not null default 0 check (reorder_point >= 0),
  unit_cost_cents   bigint not null default 0 check (unit_cost_cents >= 0),
  unit_price_cents  bigint not null default 0 check (unit_price_cents >= 0),
  category          text,
  barcode           text,
  supplier          text,
  unique (business_id, sku)
);
create index product_business_idx on product (business_id);

-- Append-only. Corrections are compensating rows, never updates (contracts:
-- InventoryMovement, and the ledger module's whole design).
create table inventory_movement (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references business(id) on delete cascade,
  product_id      uuid not null references product(id) on delete cascade,
  kind            text not null check (kind in ('receive','sale','adjustment','shrinkage','return')),
  quantity_delta  integer not null check (quantity_delta <> 0),
  at              timestamptz not null,
  unit_cost_cents bigint check (unit_cost_cents >= 0),
  note            text
);
create index inventory_movement_product_idx on inventory_movement (product_id, at);

create table sale (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references business(id) on delete cascade,
  at                  timestamptz not null,
  tax_collected_cents bigint check (tax_collected_cents >= 0),
  channel             text
);
create index sale_business_idx on sale (business_id, at);

create table sale_item (
  sale_id          uuid not null references sale(id) on delete cascade,
  line_no          integer not null,
  product_id       uuid not null references product(id) on delete restrict,
  quantity         integer not null check (quantity >= 1),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  primary key (sale_id, line_no)
);

create table expense (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references business(id) on delete cascade,
  at                     timestamptz not null,
  vendor                 text not null check (length(trim(vendor)) > 0),
  category               text not null check (length(trim(category)) > 0),
  amount_cents           bigint not null check (amount_cents > 0),
  description            text,
  receipt_attachment_id  uuid
);
create index expense_business_idx on expense (business_id, at);

-- How much has actually been moved into the set-aside account. The estimate is
-- computed, never stored; only the real transfers live here.
create table tax_reserve_entry (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references business(id) on delete cascade,
  at           timestamptz not null,
  amount_cents bigint not null,
  note         text
);
create index tax_reserve_business_idx on tax_reserve_entry (business_id, at);

/* ----------------------------------------------------- cross-cutting */

create table attachment (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  entity        text not null,
  entity_id     text not null,
  filename      text not null,
  content_type  text not null,
  byte_size     bigint not null check (byte_size >= 0),
  uploaded_by   uuid not null references member(id) on delete cascade,
  uploaded_at   timestamptz not null default now(),
  storage_key   text not null unique
);
create index attachment_entity_idx on attachment (household_id, entity, entity_id);

create table notification (
  id                   uuid primary key default gen_random_uuid(),
  household_id         uuid not null references household(id) on delete cascade,
  recipient_member_id  uuid references member(id) on delete cascade,
  kind                 text not null check (kind in (
                         'reminder_due','conflict_detected','low_stock','shift_published',
                         'time_off_reviewed','swap_requested','inbox_needs_review')),
  channel              text not null default 'in_app' check (channel in ('in_app','push','email','sms')),
  title                text not null,
  body                 text not null,
  deliver_at           timestamptz not null,
  read_at              timestamptz,
  subject_entity       text,
  subject_id           text,
  -- The anti-nagging guarantee, enforced by the database rather than by
  -- remembering to check: the same facts cannot produce a second row.
  dedupe_key           text not null,
  unique (household_id, dedupe_key)
);
create index notification_inbox_idx on notification (household_id, recipient_member_id, deliver_at);

-- Domains push here on write; search never reads their tables (Agent K's
-- design). `tsv` is maintained by a trigger so no caller can forget.
create table search_document (
  entity        text not null check (entity in (
                  'event','reminder','errand','shopping_item','inbox_item',
                  'member','employee','product','expense')),
  id            text not null,
  household_id  uuid not null references household(id) on delete cascade,
  title         text not null,
  body          text,
  domain        text,
  at            timestamptz,
  member_ids    uuid[],
  business_id   uuid,
  tsv           tsvector,
  primary key (entity, id)
);
create index search_household_idx on search_document (household_id);
create index search_tsv_idx on search_document using gin (tsv);

create or replace function search_document_tsv_update() returns trigger as $$
begin
  new.tsv :=
    setweight(to_tsvector('simple', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.body, '')), 'B');
  return new;
end;
$$ language plpgsql;

create trigger search_document_tsv
  before insert or update on search_document
  for each row execute function search_document_tsv_update();

create table audit_log (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references household(id) on delete cascade,
  actor_member_id  uuid references member(id) on delete set null,
  action           text not null,
  entity           text not null,
  entity_id        text not null,
  at               timestamptz not null default now(),
  before           jsonb,
  after            jsonb
);
create index audit_household_idx on audit_log (household_id, at desc);

-- Every AI proposal and what was decided about it. ARCHITECTURE.md §3 ends the
-- pipeline at "audit log"; this is that row, and it keeps the model's raw
-- output next to the verdict so a bad suggestion is reviewable after the fact.
create table ai_action (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references household(id) on delete cascade,
  actor_member_id  uuid not null references member(id) on delete cascade,
  proposal         jsonb not null,
  verdict          text not null check (verdict in ('execute','confirm','reject')),
  executed_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index ai_action_household_idx on ai_action (household_id, created_at desc);
