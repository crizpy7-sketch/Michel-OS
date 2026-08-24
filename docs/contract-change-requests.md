# Contract change requests

`lib/contracts/index.ts` is frozen and hash-pinned (`tools/swarm/contract.lock`).
Agents building in parallel cannot edit it — a change to a shared shape
invalidates work that siblings are doing *right now*, and the breakage surfaces
somewhere other than where it was caused.

So agents raise change requests instead. The orchestrator batches them, decides,
and re-freezes at a new version between parallel phases. Nothing here is applied
mid-flight.

---

## Open — deferred to contract v1.1

### CR-001 · No reminder-scoped permission
**Raised by:** Household/Auth Agent (E) · **Status:** deferred, worked around

`PERMISSIONS` has no reminder verb, so "a child may complete their own
reminders" has to be expressed as `event.update.own` — the narrowest available
token. Because `child` holds no `event.create`, the `.own` gate means the
practical blast radius is close to zero, but the mapping is a lie about intent.

Compounding it: `Reminder` uses `assignedTo`, not `createdBy`, so the `.own`
ownership test in `authorize` cannot see reminder assignment at all. The
reminders module must layer its own assignee check on top.

**Decision:** add `reminder.complete.own` (and likely `reminder.snooze.own`) in
v1.1, together with an `assignedTo` arm in the `authorize` resource shape.
Deferring rather than patching mid-phase, because widening the `resource` type
touches every caller the other three agents are writing against.

### CR-002 · `event.delete` is not own/any split
**Raised by:** Household/Auth Agent (E) · **Status:** deferred

Every other event verb splits `.own` / `.any`; delete does not. The consequence
is that a teen cannot delete an event they created themselves — the matrix has
to deny delete outright rather than scope it. Split it in v1.1 for symmetry.

### CR-004 · `Conflict.occurrenceRefs` cannot name a shift
**Raised by:** Conflict Engine Agent (G) · **Status:** deferred, worked around

`work` and `employee` conflicts are about shifts, but `occurrenceRefs` is shaped
`{ eventId, occurrenceStart }` with no shift-shaped variant. The engine encodes a
shift as `{ eventId: shift.id, occurrenceStart: shift.startsAt }`, which means a
consumer that assumes every `eventId` resolves to an `Event` will miss.

**Decision:** deferred. This is a genuine sharp edge and it is now the loudest
undocumented assumption in the system — every UI or AI consumer of `Conflict`
has to know it. v1.1 should widen the ref to a discriminated union
(`{ kind: 'event' | 'shift', id, startsAt }`). Until then it is documented here
and in the engine.

### CR-005 · `Occurrence` has no location
**Raised by:** Conflict Engine Agent (G) · **Status:** deferred

`travel` conflicts can therefore only detect time-tightness, not that the two
events are in different places — so the check is a heuristic and is scored
`info` rather than `warning`. Carrying `location` onto `Occurrence` in v1.1 would
make it a real check.

### CR-006 · `RecurrenceRule` has no week-start (WKST)
**Raised by:** Core Scheduling Agent (F) · **Status:** deferred

Interval anchoring for `every N weeks` depends on which day starts the week.
The engine defaults to Monday (the RFC 5545 default) so "every 2 weeks on
Mon+Fri" does not drift with the series start weekday. A household in a
Sunday-first locale would want the other answer. Add `weekStart?: Weekday` in
v1.1.

### CR-007 · No signal that expansion hit the cap
**Raised by:** Core Scheduling Agent (F) · **Status:** deferred

`expandOccurrences` truncates silently at `DEFAULT_MAX_OCCURRENCES` (1000). The
UI cannot tell a series that genuinely ends from one that was cut off, so it
cannot show a "more occurrences exist" affordance. Needs either a richer return
shape or a flag on the last `Occurrence` — both are contract changes.

---

## Resolved by orchestrator ruling (no contract change)

### CR-003 · Directional spec gaps in the role matrix
**Raised by:** Household/Auth Agent (E) · **Ruling:** accept the agent's call

Two role assignments where the brief was directional rather than explicit, both
resolved toward least privilege and both upheld:

- `adult` gets `finance.read` but **not** `employee.schedule`. Scheduling
  another person's paid shifts is a business-operator action, not a household
  one.
- `viewer` gets `event.read` only, not `business.read`. A read-only guest of the
  family calendar has no business seeing the shop's books.

Both are restated independently in `tests/unit/permissions.test.ts`, so flipping
the matrix without updating the expectation fails loudly instead of silently
widening access.
