# Contract change requests

`lib/contracts/index.ts` is frozen and hash-pinned (`tools/swarm/contract.lock`).
Agents building in parallel cannot edit it — a change to a shared shape
invalidates work that siblings are doing *right now*, and the breakage surfaces
somewhere other than where it was caused.

So agents raise change requests instead. The orchestrator batches them, decides,
and re-freezes at a new version between parallel phases. Nothing here is applied
mid-flight.

---

## Applied in contract v1.1

The six requests below were batched into one re-freeze between Phase C and
Phase C2, exactly as this process intends: nothing was applied mid-flight, and
`tools/swarm/contract.lock` now pins `1.1.0-frozen`. Each one is followed by
what actually shipped.

### CR-001 · No reminder-scoped permission
**Raised by:** Household/Auth Agent (E) · **Status:** applied in v1.1

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

**Shipped:** `reminder.complete.own`, `reminder.snooze.own` and a
`reminder.manage.any` for the adult who needs to close a child's reminder.
`AuthorizeResource` gained `assignedTo`, and the child's `event.update.own` —
the stand-in that prompted this request — is gone. Reminder ownership is proven
by assignment only: a matching `createdBy` is explicitly not accepted, which is
its own test.

### CR-002 · `event.delete` is not own/any split
**Raised by:** Household/Auth Agent (E) · **Status:** applied in v1.1

Every other event verb splits `.own` / `.any`; delete does not. The consequence
is that a teen cannot delete an event they created themselves — the matrix has
to deny delete outright rather than scope it. Split it in v1.1 for symmetry.

**Shipped:** `event.delete.own` / `event.delete.any`; the teen holds `.own`.
The AI validator's `cancel_event` maps to `.any`, which preserves the v1.0
behaviour exactly — the oracle has no row, so it could not honour a `.own`
grant even if one were given.

### CR-004 · `Conflict.occurrenceRefs` cannot name a shift
**Raised by:** Conflict Engine Agent (G) · **Status:** applied in v1.1

`work` and `employee` conflicts are about shifts, but `occurrenceRefs` is shaped
`{ eventId, occurrenceStart }` with no shift-shaped variant. The engine encodes a
shift as `{ eventId: shift.id, occurrenceStart: shift.startsAt }`, which means a
consumer that assumes every `eventId` resolves to an `Event` will miss.

**Decision:** deferred. This is a genuine sharp edge and it is now the loudest
undocumented assumption in the system — every UI or AI consumer of `Conflict`
has to know it. v1.1 should widen the ref to a discriminated union
(`{ kind: 'event' | 'shift', id, startsAt }`). Until then it is documented here
and in the engine.

**Shipped:** exactly that union, as `ConflictRef`. The conflict id payload is
versioned to `v: 2` because the ref key changed shape. A side effect worth
naming: an event id and a shift id that happen to be the same string used to
dedupe into a single ref, and now do not.

### CR-005 · `Occurrence` has no location
**Raised by:** Conflict Engine Agent (G) · **Status:** applied in v1.1

`travel` conflicts can therefore only detect time-tightness, not that the two
events are in different places — so the check is a heuristic and is scored
`info` rather than `warning`. Carrying `location` onto `Occurrence` in v1.1 would
make it a real check.

**Shipped:** `Occurrence.location`, carried through overrides by the recurrence
engine. `travel` now has three outcomes: same place is silent, two known and
different places is a `warning`, an unknown place keeps the v1.0 `info`.
Location matching is exact rather than fuzzy on purpose — guessing that "Mercy
Clinic" and "Mercy Clinic North" are one building would suppress a real
conflict, and a missed conflict is worse than a redundant one.

### CR-006 · `RecurrenceRule` has no week-start (WKST)
**Raised by:** Core Scheduling Agent (F) · **Status:** applied in v1.1

Interval anchoring for `every N weeks` depends on which day starts the week.
The engine defaults to Monday (the RFC 5545 default) so "every 2 weeks on
Mon+Fri" does not drift with the series start weekday. A household in a
Sunday-first locale would want the other answer. Add `weekStart?: Weekday` in
v1.1.

**Shipped:** `RecurrenceRule.weekStart`. Absent or unusable values fall back to
Monday, so no existing series moved. Note that a single-weekday rule cannot
tell the two readings apart — it takes a pair straddling the week boundary, and
that is what the test uses.

### CR-007 · No signal that expansion hit the cap
**Raised by:** Core Scheduling Agent (F) · **Status:** applied in v1.1

`expandOccurrences` truncates silently at `DEFAULT_MAX_OCCURRENCES` (1000). The
UI cannot tell a series that genuinely ends from one that was cut off, so it
cannot show a "more occurrences exist" affordance. Needs either a richer return
shape or a flag on the last `Occurrence` — both are contract changes.

**Shipped:** the richer return shape, as `expandOccurrencesDetailed` ->
`ExpansionResult { occurrences, truncated, maxOccurrences }`. The expansion now
stages exactly one row past the cap so that "there is more" is observable at
all; the list-only `expandOccurrences` still returns the same prefix it always
did.

---

## Resolved by orchestrator ruling (no contract change)

### CR-008 · Business scope is not the same tenant as household scope
**Raised by:** AI Scheduling Agent (H) · **Status:** resolved in the agent's design

The validator brief said a payload `businessId` differing from the request's
household scope is a cross-tenant escape. But in the frozen contract
`Business.id` is a distinct UUID from `Household.id`, so a literal reading
would reject every legitimate Shia Baby action — the brief was wrong, not the
contract.

**Ruling:** the agent's resolution stands. The default fails closed (a payload
`businessId` must match the injected scope when no business scope is supplied),
and an optional `ctx.businessId` supplies the real expected value when the
caller has resolved it. Business scope is the caller's to establish; the
validator's job is to refuse anything that does not match what it was told.
No contract change needed.

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

---

## Open — deferred to contract v1.2

Raised by the Phase C2 agents against v1.1. Same rule as before: recorded here,
batched, and applied only at the next re-freeze between phases.

### CR-009 · The business/household link is the caller's to assert
**Raised by:** Shia Baby Staffing Agent (J1) · **Status:** deferred, worked around

`Business` carries `householdId`, but `Shift`, `Employee`, `Availability`,
`TimeOffRequest` and `ShiftSwap` carry only `businessId`. So every staffing
function has to be handed the household separately for the permission check, and
nothing in the type system stops a caller pairing a `businessId` with the wrong
`householdId` — the two checks pass independently and the row is scheduled under
somebody else's authority.

The module fails closed on everything it can see (a row from another business is
dropped) and the security probe covers the case, but that is a runtime guard
standing in for a shape the contract could enforce. v1.2 should either thread
`householdId` onto the business-scoped rows or introduce a resolved
`BusinessScope { businessId, householdId }` that the caller obtains once and
passes as a unit.

### CR-010 · `SearchDocument.memberIds` is indexed but unenforced
**Raised by:** Search / Notifications Agent (K) · **Status:** deferred

The field exists so results can be scoped to the members a row concerns, but the
permission model has no per-row member visibility to check it against —
`event.read` is all-or-nothing across the household. So search currently filters
by household, by entity permission, and by business scope, and ignores
`memberIds` entirely rather than inventing a rule the kernel does not have.

This matters for a real case the product implies: a teen's private appointment
should not necessarily be visible to a sibling holding the same `event.read`.
That is a permission-model change, not a search change, so it belongs to Agent E
and to a contract version — not to a filter quietly added here.

### CR-011 · `Reminder` has no author
**Raised by:** Personal Organization Agent (I) · **Status:** deferred, worked around

CR-001 fixed the `.own` test for *assigned* reminders. An unassigned one still
has no owner at all — `Reminder` has no `createdBy` — so only a holder of
`reminder.manage.any` can ever act on it. In practice that means a teen can
create a reminder for themselves, leave it unassigned, and then be unable to
complete it. Adding `createdBy` to `Reminder` in v1.2 would close it, with the
ownership rule reading assignment first and authorship second.

### CR-012 · Money has no currency
**Raised by:** Shia Baby Ledger Agent (J2) · **Status:** deferred

Every amount is an integer of minor units — `amountCents`, `unitPriceCents`,
`taxCollectedCents` — but nothing records *which* currency, and `Business` has
no currency field. The names hard-code an assumption the contract never states.
For one shop in one country this is invisible; it stops being invisible the
first time a figure is rendered with a symbol, or a supplier invoices in another
currency. v1.2 should put `currency` on `Business` and let the field names drop
the unit.
