-- Michel-OS — initial Postgres schema for Supabase.
--
-- Status: written and reviewable, NOT yet applied. Provisioning a Supabase
-- project needs credentials this environment does not have, so the app ships
-- against the local SQLite store behind lib/db/repository.ts. This file is the
-- other implementation of that seam, and it is the one that carries real
-- row-level security.
--
-- ARCHITECTURE.md §8 is the requirement being met here: tenant isolation,
-- row-level security, server-side permission checks, no trusting
-- client-provided roles. The application layer already refuses cross-tenant
-- reads; RLS makes that refusal true even if the application layer is wrong.

create extension if not exists "pgcrypto";

/* ------------------------------------------------------------ enums ---- */

create type member_role as enum ('owner', 'adult', 'teen', 'child', 'employee', 'viewer');
create type domain_key as enum (
  'appointments','practice','competition','games','school','errands',
  'shopping','reminders','work','shia-baby','inbox','general'
);
create type event_status as enum ('confirmed','tentative','cancelled');
create type participant_role as enum ('attendee','responsible','optional');
create type reminder_status as enum ('pending','sent','completed','snoozed','dismissed');
create type shopping_status as enum ('needed','purchased','removed');
create type errand_status as enum ('open','in_progress','done','cancelled');
create type inbox_status as enum ('unclassified','classified','converted','dismissed');
create type shift_status as enum ('draft','published','swapped','cancelled');

/* -------------------------------------------------------- household ---- */

create table households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  timezone    text not null default 'UTC',
  created_at  timestamptz not null default now()
);

create table members (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,
  display_name  text not null,
  role          member_role not null default 'adult',
  color         text not null default 'graphite',
  active        boolean not null default true
);
create index members_household_idx on members(household_id);
create unique index members_user_household_idx on members(user_id, household_id) where user_id is not null;

/**
 * The tenancy predicate every policy is built on: which households does the
 * calling user belong to? SECURITY DEFINER plus a pinned search_path so the
 * function cannot be shadowed, and STABLE so the planner can cache it per
 * statement instead of re-running it per row.
 */
create or replace function household_ids_for_current_user()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from members where user_id = auth.uid() and active
$$;

create or replace function is_household_member(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from members
    where household_id = target and user_id = auth.uid() and active
  )
$$;

/**
 * Role of the calling user inside a household. Read from the members table,
 * never from a JWT claim the client could shape — ARCHITECTURE.md §8's
 * "no trusting client-provided roles", enforced in the database.
 */
create or replace function role_in_household(target uuid)
returns member_role
language sql
stable
security definer
set search_path = public
as $$
  select role from members
  where household_id = target and user_id = auth.uid() and active
  limit 1
$$;

/* ------------------------------------------------------- scheduling ---- */

create table schedules (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  domain        domain_key not null,
  name          text not null,
  color         text not null default 'graphite',
  archived      boolean not null default false
);
create index schedules_household_idx on schedules(household_id);

create table events (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households(id) on delete cascade,
  schedule_id    uuid not null references schedules(id) on delete cascade,
  domain         domain_key not null,
  title          text not null,
  notes          text,
  location       text,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  all_day        boolean not null default false,
  timezone       text not null default 'UTC',
  status         event_status not null default 'confirmed',
  created_by     uuid not null references members(id) on delete restrict,
  recurrence     jsonb,
  series_id      uuid references events(id) on delete cascade,
  recurrence_id  timestamptz,
  constraint events_time_order check (ends_at >= starts_at)
);
create index events_household_start_idx on events(household_id, starts_at);
create index events_series_idx on events(series_id) where series_id is not null;

create table event_participants (
  event_id   uuid not null references events(id) on delete cascade,
  member_id  uuid not null references members(id) on delete cascade,
  role       participant_role not null default 'attendee',
  primary key (event_id, member_id)
);

create table reminders (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  event_id      uuid references events(id) on delete set null,
  title         text not null,
  due_at        timestamptz not null,
  assigned_to   uuid references members(id) on delete set null,
  status        reminder_status not null default 'pending'
);
create index reminders_household_due_idx on reminders(household_id, due_at);

create table shopping_items (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  list_name     text not null default 'Groceries',
  name          text not null,
  quantity      numeric not null default 1 check (quantity >= 0),
  status        shopping_status not null default 'needed'
);
create index shopping_household_idx on shopping_items(household_id);

create table errands (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  title         text not null,
  assigned_to   uuid references members(id) on delete set null,
  due_at        timestamptz,
  status        errand_status not null default 'open'
);
create index errands_household_idx on errands(household_id);

create table inbox_items (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references households(id) on delete cascade,
  raw_text          text not null,
  captured_by       uuid not null references members(id) on delete cascade,
  captured_at       timestamptz not null default now(),
  suggested_domain  domain_key,
  status            inbox_status not null default 'unclassified'
);
create index inbox_household_idx on inbox_items(household_id);

/* -------------------------------------------------------- Shia Baby ---- */

create table businesses (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references households(id) on delete cascade,
  name                text not null,
  timezone            text not null default 'UTC',
  tax_set_aside_rate  numeric not null default 0 check (tax_set_aside_rate between 0 and 1)
);
create index businesses_household_idx on businesses(household_id);

create table employees (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  member_id     uuid references members(id) on delete set null,
  display_name  text not null,
  hourly_rate   numeric not null default 0 check (hourly_rate >= 0),
  active        boolean not null default true
);
create index employees_business_idx on employees(business_id);

create table shifts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  employee_id  uuid references employees(id) on delete set null,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  status       shift_status not null default 'draft',
  role         text,
  constraint shifts_time_order check (ends_at > starts_at)
);
create index shifts_business_start_idx on shifts(business_id, starts_at);

create table products (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade,
  sku               text not null,
  name              text not null,
  quantity_on_hand  numeric not null default 0 check (quantity_on_hand >= 0),
  reorder_point     numeric not null default 0 check (reorder_point >= 0),
  unit_cost         numeric not null default 0 check (unit_cost >= 0),
  unit_price        numeric not null default 0 check (unit_price >= 0),
  unique (business_id, sku)
);

create table sales (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete cascade,
  occurred_at    timestamptz not null default now(),
  total          numeric not null check (total >= 0),
  tax_collected  numeric not null default 0 check (tax_collected >= 0),
  note           text
);
create index sales_business_at_idx on sales(business_id, occurred_at desc);

create table expenses (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  occurred_at  timestamptz not null default now(),
  vendor       text not null,
  category     text not null,
  amount       numeric not null check (amount >= 0),
  description  text
);
create index expenses_business_at_idx on expenses(business_id, occurred_at desc);

/* ------------------------------------------------------------ audit ---- */

create table audit_log (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references households(id) on delete cascade,
  actor_member_id  uuid references members(id) on delete set null,
  action           text not null,
  entity           text not null,
  entity_id        text not null,
  at               timestamptz not null default now(),
  before_json      jsonb,
  after_json       jsonb
);
create index audit_household_at_idx on audit_log(household_id, at desc);

/* -------------------------------------------------- row-level security */

alter table households        enable row level security;
alter table members           enable row level security;
alter table schedules         enable row level security;
alter table events            enable row level security;
alter table event_participants enable row level security;
alter table reminders         enable row level security;
alter table shopping_items    enable row level security;
alter table errands           enable row level security;
alter table inbox_items       enable row level security;
alter table businesses        enable row level security;
alter table employees         enable row level security;
alter table shifts            enable row level security;
alter table products          enable row level security;
alter table sales             enable row level security;
alter table expenses          enable row level security;
alter table audit_log         enable row level security;

-- Household-scoped tables: membership is the whole predicate.
create policy households_read on households
  for select using (is_household_member(id));

create policy members_read on members
  for select using (is_household_member(household_id));

create policy members_write on members
  for all using (role_in_household(household_id) in ('owner','adult'))
  with check (role_in_household(household_id) in ('owner','adult'));

/**
 * The family calendar. Note the employee exclusion: an employee of the Shia
 * Baby business is a member of the household row-wise, but must not see family
 * appointments. That privacy boundary is enforced in the role matrix
 * (domains/household/permissions.ts) and again here, because a boundary that
 * exists in only one layer is a boundary that will eventually be walked around.
 */
create policy schedules_read on schedules
  for select using (is_household_member(household_id) and role_in_household(household_id) <> 'employee');

create policy events_read on events
  for select using (is_household_member(household_id) and role_in_household(household_id) <> 'employee');

create policy events_write on events
  for all using (role_in_household(household_id) in ('owner','adult','teen'))
  with check (role_in_household(household_id) in ('owner','adult','teen'));

create policy participants_read on event_participants
  for select using (exists (
    select 1 from events e
    where e.id = event_participants.event_id
      and is_household_member(e.household_id)
      and role_in_household(e.household_id) <> 'employee'
  ));

create policy participants_write on event_participants
  for all using (exists (
    select 1 from events e
    where e.id = event_participants.event_id
      and role_in_household(e.household_id) in ('owner','adult','teen')
  ))
  with check (exists (
    select 1 from events e
    where e.id = event_participants.event_id
      and role_in_household(e.household_id) in ('owner','adult','teen')
  ));

create policy reminders_rw on reminders
  for all using (is_household_member(household_id) and role_in_household(household_id) <> 'employee')
  with check (is_household_member(household_id) and role_in_household(household_id) <> 'employee');

create policy shopping_rw on shopping_items
  for all using (is_household_member(household_id) and role_in_household(household_id) <> 'employee')
  with check (is_household_member(household_id) and role_in_household(household_id) <> 'employee');

create policy errands_rw on errands
  for all using (is_household_member(household_id) and role_in_household(household_id) <> 'employee')
  with check (is_household_member(household_id) and role_in_household(household_id) <> 'employee');

create policy inbox_rw on inbox_items
  for all using (is_household_member(household_id) and role_in_household(household_id) <> 'employee')
  with check (is_household_member(household_id) and role_in_household(household_id) <> 'employee');

-- Business tables: reachable by household membership through businesses.
create policy businesses_read on businesses
  for select using (is_household_member(household_id));

create policy businesses_write on businesses
  for all using (role_in_household(household_id) = 'owner')
  with check (role_in_household(household_id) = 'owner');

create or replace function business_household(target uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$ select household_id from businesses where id = target $$;

create policy employees_read on employees
  for select using (is_household_member(business_household(business_id)));
create policy employees_write on employees
  for all using (role_in_household(business_household(business_id)) = 'owner')
  with check (role_in_household(business_household(business_id)) = 'owner');

create policy shifts_read on shifts
  for select using (is_household_member(business_household(business_id)));
create policy shifts_write on shifts
  for all using (role_in_household(business_household(business_id)) in ('owner','employee'))
  with check (role_in_household(business_household(business_id)) in ('owner','employee'));

create policy products_read on products
  for select using (is_household_member(business_household(business_id)));
create policy products_write on products
  for all using (role_in_household(business_household(business_id)) = 'owner')
  with check (role_in_household(business_household(business_id)) = 'owner');

-- Money is owner-only, read included.
create policy sales_rw on sales
  for all using (role_in_household(business_household(business_id)) = 'owner')
  with check (role_in_household(business_household(business_id)) = 'owner');

create policy expenses_rw on expenses
  for all using (role_in_household(business_household(business_id)) = 'owner')
  with check (role_in_household(business_household(business_id)) = 'owner');

/**
 * Audit is append-only from the application's point of view: members may read
 * their household's history, and nobody gets an UPDATE or DELETE policy, so
 * those are denied by default. A log a caller can rewrite is not a log.
 */
create policy audit_read on audit_log
  for select using (is_household_member(household_id) and role_in_household(household_id) in ('owner','adult'));

create policy audit_append on audit_log
  for insert with check (is_household_member(household_id));
