# Family Scheduling OS — Architecture

## 1. Preferred stack

Frontend:
- Next.js
- TypeScript
- App Router
- Tailwind CSS
- shadcn/ui only where useful
- custom design system
- PWA

Backend:
- Supabase
- PostgreSQL
- Supabase Auth
- Supabase Storage
- Supabase Realtime where useful

Validation:
- Zod

Testing:
- unit tests
- integration tests
- Playwright E2E

## 2. Architectural principles

- One universal scheduling engine
- Mini-apps are domain experiences, not separate incompatible calendars
- Deterministic database mutations
- AI proposes, validator decides
- Strict tenant isolation
- Server-side authorization
- Explicit domain contracts
- Audit important changes
- Event relationships are generic, not hardcoded

## 3. AI action pipeline

User input
-> intent classification
-> structured action proposal
-> schema validation
-> permission validation
-> conflict analysis
-> user confirmation when required
-> deterministic command
-> database mutation
-> audit log

The LLM must never directly own calendar state.

## 4. Domain boundaries

### Household
- users
- members
- roles
- permissions
- invitations

### Scheduling
- schedules
- events
- participants
- recurrence
- reminders
- locations
- conflicts

### Personal organization
- errands
- shopping
- reminders
- inbox

### Shia Baby business
- business
- employees
- availability
- shifts
- time-off
- shift swaps
- inventory
- sales
- expenses
- tax set-aside

### AI
- intent parser
- structured action generator
- validation
- suggestions
- conflict explanation
- morning brief

### Cross-cutting
- search
- attachments
- notifications
- audit logging

## 5. Shared contracts to freeze before parallel work

The lead agent must freeze:
- Household
- User
- Member
- Schedule
- Event
- EventParticipant
- RecurrenceRule
- Reminder
- Conflict
- Business
- Employee
- Shift
- Product
- ShoppingItem
- Errand
- InboxItem
- AIAction
- AuditLog

No swarm agent may independently change shared contracts without orchestrator approval.

## 6. Suggested project structure

app/
  (auth)/
  (dashboard)/
  api/

components/
  design-system/
  navigation/
  schedules/
  business/
  ai/

domains/
  household/
  scheduling/
  appointments/
  school/
  practice/
  competition/
  games/
  errands/
  shopping/
  reminders/
  work/
  shia-baby/
  inbox/
  ai/

lib/
  db/
  auth/
  validation/
  dates/
  permissions/
  notifications/
  audit/

supabase/
  migrations/
  seed/

tests/
  unit/
  integration/
  e2e/

public/
  icons/

docs/

## 7. Recurrence

Support:
- daily
- weekly
- monthly
- selected weekdays
- every N weeks
- start/end dates
- recurrence exceptions
- canceled occurrence
- edited single occurrence
- edited future occurrences

Prefer an industry-standard recurrence representation where practical.

## 8. Security

Required:
- tenant/household isolation
- business isolation
- row-level security
- server-side permission checks
- secure storage policies
- no secret keys in client
- no trusting client-provided roles
- audit sensitive changes

## 9. Notifications abstraction

V1:
- in-app notification center
- scheduled reminder records

Future adapters:
- push
- email
- SMS

## 10. External integrations — keep adapter-ready

Do not block V1 on:
- Apple Calendar
- Google Calendar
- maps
- POS
- payroll
- accounting
- school SIS
- sports feeds
- SMS

Create clean integration boundaries so they can be added later.
