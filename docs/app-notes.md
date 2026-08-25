# App notes — what is real, and what is standing in

The product spec describes a finished system. This document says exactly where
the shipped app matches it and where something is standing in for a piece that
needs credentials, a vendor, or a decision that is not mine to make.

Read this before believing a screenshot.

---

## Standing in

### Persistence is SQLite, not Supabase
**Spec:** `ARCHITECTURE.md §1` — Supabase, PostgreSQL, Supabase Auth, Storage.
**Shipped:** `node:sqlite`, in-process, seeded at boot.

Provisioning a Supabase project requires credentials this environment does not
have. Rather than block the app, both implementations exist:

- `lib/db/sqlite.ts` — what runs today.
- `supabase/migrations/0001_init.sql` — the real Postgres schema with row-level
  security, written and reviewable, **not yet applied**.

They meet at `lib/db/repository.ts`. Every screen reads and writes through that
interface, so moving to Supabase is one new implementation and zero screen
changes. That claim is structural, not a promise: no screen imports a driver.

**What this costs you today:** data resets when the process restarts (unless
`MICHEL_DB` points at a file), and RLS is not actually enforcing anything —
tenant isolation currently rests on the application layer alone, which is
exactly the arrangement the migration exists to fix.

### The "AI" is a deterministic parser, not a language model
**Spec:** `PRODUCT_SPEC.md §1` — "one AI scheduling brain".
**Shipped:** `domains/ai/parser.ts`, a rule-based grammar.

It handles the phrasings families actually use — "Ana has practice every
Tuesday and Thursday from 6 to 8", "we need milk", "remind me to call insurance
Friday" — and reports honest confidence. It does not understand language it was
not written for, and it will not improvise.

The architecture is what makes this swappable rather than a dead end: whatever
sits in that seat only *proposes*. `domains/ai/validator.ts` decides. Replacing
the parser with a model call leaves the permission checks, tenant checks,
confirmation policy, and audit trail exactly where they are.

Low confidence is load-bearing, not decoration: a guessed hour or an
unrecognised person drops it below the threshold, which routes the proposal to
a confirmation prompt instead of letting it execute.

### There is no identity provider
**Spec:** Supabase Auth.
**Shipped:** the acting member is held in a cookie and defaults to the owner.

The cookie names *which member is acting*; it can never grant a capability. It
can only select among members that already belong to the household, and an
unknown value falls back to the owner. Every permission answer still comes from
the frozen role matrix keyed on the member row read from the database — so
`ARCHITECTURE.md §8`'s "no trusting client-provided roles" holds.

This exists so the permission system is demonstrable: switch to the child or
the employee and watch the app actually refuse things.

**What this costs you today:** anyone who can reach the app can act as anyone in
the household. This is a demo affordance and must not survive contact with real
users.

---

## Real

- **The scheduling engines.** Recurrence expansion, override handling, DST, and
  conflict detection are the same modules the gauntlet verifies — 200+ tests,
  determinism probes, a 5,000-occurrence performance probe.
- **The authorization kernel.** Deny-by-default role matrix, tenancy checked
  before permission, employee walled off from the family calendar.
- **The write path.** Every mutation in the product — form or AI — goes through
  `lib/actions.ts`: schema validation, permission check, tenant check,
  confirmation policy, deterministic command, audit entry.
- **The artwork.** The eight approved icons are the supplied PNGs. The five
  pending ones are marked `artStatus: 'pending'` and render as visibly
  provisional, per `ASSET_MAP.md`'s instruction not to ship placeholders as
  final.
- **The responsive work.** Verified by the browser probe at the seven widths
  `UI_RESPONSIVE_SPEC.md §1` enumerates, not by eyeballing one window.

---

## Not built

Named plainly so nobody has to discover them by clicking:

- Attachments and file storage (`ARCHITECTURE.md §4` cross-cutting).
- Notifications beyond in-app reminder records — no push, email, or SMS.
- Global search.
- Shift swaps and time-off request review flows (the data model supports them;
  the screens do not exist).
- Sales entry — sales are seeded and reported, not recorded through the UI.
- External calendar, POS, payroll and school-system integrations. These were
  explicitly out of scope for V1 and the boundaries are left clean for them.

---

## Tax Set-Aside

`PRODUCT_SPEC.md §8` is specific about this and it is worth repeating: the
figure shown is a **set-aside estimate**, not a tax liability, and the screen
says so. It is arithmetic on recorded sales at a configured rate. It is not
accounting, not advice, and not connected to any authoritative source.
