# Delivery status — PRODUCT_SPEC §14

PRODUCT_SPEC §7 (Definition of done) is deliberately hard to satisfy:

> A feature is not done merely because UI renders.
> Done means: frontend exists, backend exists where needed, persistence works,
> permissions work, validation works, tests exist, responsive behavior verified,
> error/loading/empty states exist, no obvious console/server errors.

By that standard **no V1 acceptance criterion is complete**, because this
repository has no frontend and no persistence layer. What it has is the tier
underneath both: the domain logic, the contracts they agree on, and an
adversarial harness that keeps them honest. This page says exactly which part of
each criterion is standing and which is not, so that nobody has to infer it from
a green test run.

Three things are true of every row below:

- **Permissions and validation are done.** Every mutation in every module goes
  through the same `authorize()` kernel, and every AI-originated payload goes
  through the same validator. There is no second access rule anywhere.
- **Persistence is not started.** Every module is pure: it takes rows and
  returns rows. Nothing writes. Wiring these to Supabase (ARCHITECTURE.md §1)
  means writing repositories and RLS policies, not changing this logic.
- **Frontend is not started.** The mini-app shell, the design system, the
  responsive behaviour in UI_RESPONSIVE_SPEC.md and the icon integration in
  ASSET_MAP.md are Agents C/D and the Mini-App group, none of which have run.

---

## Status key

| | meaning |
| --- | --- |
| **logic** | the rules exist, are tested, and are enforced through the kernel |
| **partial** | some of the rules exist; what is missing is named in the row |
| **none** | no code for this yet |

---

## The 29 criteria

| # | Criterion | Domain logic | Where it lives | What is still missing |
| --- | --- | --- | --- | --- |
| 1 | authenticate | **none** | — | Supabase Auth; the kernel consumes a `Member`, it does not establish one |
| 2 | create/join household | **partial** | `domains/household/permissions.ts` | `household.manage` is enforced; invitations and the join flow are unwritten |
| 3 | add members | **partial** | `domains/household/permissions.ts` | `member.manage` is enforced; member CRUD and the managed-profile flow are unwritten |
| 4 | create appointments | **logic** | `recurrence.ts`, `ai/inbox.ts`, `ai/validator.ts` | persistence + UI |
| 5 | create recurring practices | **logic** | `recurrence.ts` (`weekStart`, exceptions, overrides) | persistence + UI |
| 6 | create games | **logic** | same engine; `domain: 'games'` | persistence + UI |
| 7 | create competitions | **logic** | same engine; `domain: 'competition'` | persistence + UI |
| 8 | create school events | **logic** | same engine; `domain: 'school'` | persistence + UI |
| 9 | create work schedules | **logic** | `recurrence.ts` + `shia-baby/staffing.ts` | persistence + UI |
| 10 | create errands | **logic** | `personal/lists.ts` | persistence + UI |
| 11 | create shopping items | **logic** | `personal/lists.ts` (+ store grouping) | persistence + UI |
| 12 | create reminders | **logic** | `personal/lists.ts` (snooze, recurrence, assignment) | persistence + UI |
| 13 | use Inbox | **logic** | `ai/inbox.ts` | persistence + UI |
| 14 | view All Schedules | **partial** | `recurrence.ts` expands any window | the Today/Day/Week/Month/Agenda views and the filter set are UI work |
| 15 | detect conflicts | **logic** | `scheduling/conflicts.ts` — all five levels | persistence + UI |
| 16 | receive conflict explanations | **logic** | `conflicts.ts` (`explainConflict`) | UI |
| 17 | AI natural-language entry | **logic** | `ai/inbox.ts` → `ai/validator.ts` | a model call is optional, not required — the deterministic router is the floor |
| 18 | preview AI actions | **logic** | `validator.ts` returns `confirm` + `requiresConfirmationBecause` | the confirmation sheet is UI |
| 19 | create Shia Baby employees | **partial** | `staffing.ts` enforces `business.manage` | employee CRUD is unwritten; assignment and review are done |
| 20 | assign shifts | **logic** | `staffing.ts` | persistence + UI |
| 21 | track availability | **logic** | `staffing.ts` (`Availability`, negative windows win) | persistence + UI |
| 22 | track inventory | **logic** | `shia-baby/ledger.ts` (append-only movements) | persistence + UI |
| 23 | record sales | **logic** | `ledger.ts` (+ implied stock movements) | persistence + UI |
| 24 | record expenses | **logic** | `ledger.ts` | receipt attachments need Storage; the `Attachment` contract exists |
| 25 | view Tax Set-Aside estimate | **logic** | `ledger.ts` (label + disclaimer are asserted by the security probe) | UI |
| 26 | receive low-stock warnings | **logic** | `ledger.ts` → `platform/notifications.ts` | delivery adapters; the in-app record is done |
| 27 | view Morning Brief | **logic** | `ai/brief.ts` | UI |
| 28 | search system-wide | **logic** | `platform/search.ts` | domains must push documents at write time — that is repository work |
| 29 | comfortable on mobile / iPad / desktop | **none** | — | entirely UI: Agents C, D and N, against UI_RESPONSIVE_SPEC.md |

---

## What that adds up to

| | count |
| --- | --- |
| criteria with complete, tested, permission-enforced domain logic | 21 |
| criteria partially covered (the named gap is auth, CRUD or view logic) | 5 |
| criteria with nothing yet (authentication, responsive UI) | 3 |

Every one of the 29 still needs the persistence and frontend tiers before it can
be called done under §7.

---

## What runs today

```
npm run swarm      # delivery %, dependency graph, last gauntlet verdict
npm run gauntlet   # nine challengers, 46 runtime probe checks
npm test           # 381 unit + integration tests
```

The same gauntlet runs in CI on every push
(`.github/workflows/gauntlet.yml`), so none of the numbers above depend on
somebody having remembered to run it locally.

## The next phases, in dependency order

1. **Persistence (Agent B-backend).** Supabase migrations for the frozen v1.1
   contracts, plus RLS that mirrors `ROLE_MATRIX` rather than reimplementing it.
   The kernel stays the only place access is decided; RLS is defence in depth
   behind it, not a second opinion.
2. **Search indexing.** Repositories push `SearchDocument`s on write. Search
   deliberately cannot read domain tables, so this cannot be skipped.
3. **Design system + shell (Agents C, D).** Tokens, navigation, and the mini-app
   grid, against UI_RESPONSIVE_SPEC.md and ASSET_MAP.md.
4. **Mini-apps (Agent group I).** Each one is a view over the shared engines —
   PRODUCT_SPEC §2's "mini-apps are domain experiences, not separate
   incompatible calendars".
5. **Contract v1.2.** CR-009 through CR-012 are already recorded in
   `docs/contract-change-requests.md`; CR-010 in particular (per-member row
   visibility) is a permission-model change that later tiers will want settled
   before they build against the current all-or-nothing `event.read`.
