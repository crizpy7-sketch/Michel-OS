# Repair log — "the app is add-only"

**Live state for a swarm repair. If a session runs out of context, start here.**

Branch: `claude/michel-os-design-ux-hi7nfu` (restarted from `main` @ `b91e839`
after PR #15 merged). Deployed: auto-deploy timer is ACTIVE on the VPS and
follows `main`, so merging is deploying.

---

## The reported problem

> "The Shia baby mini app doesn't work, I can't remove test employee and some
> buttons don't work."

## What the triage actually found

Every route was crawled in a real browser, logged in, with JS errors and failed
network calls recorded. **Nothing crashes.** No JS errors, no 4xx/5xx on any of
16 routes. The complaint is not broken code — it is missing capability.

### Finding 1 — the app can create but almost never remove (systemic)

`server/api/routes.ts` contains exactly **one** `DELETE` route, for events.
Everything else is add-only:

| Screen | Has | Missing |
| --- | --- | --- |
| Shia Baby → Staffing | Add employee, availability, time off, assign shift, publish | remove employee, remove shift |
| Shia Baby → Inventory | Add product | remove/edit product |
| Shopping | Add, Got it | delete item, un-buy |
| Reminders | Add, Complete, Snooze | delete |
| Errands | Add, Done | delete |
| Household | Add profile, Create invitation | remove/deactivate person, revoke invitation |
| Notifications | *(zero controls)* | mark read — **the API endpoint exists and nothing calls it** |

This is the actual cause of "I can't remove test employee". It was never built.

### Finding 2 — a control that looks tappable and is not

`public/views/business.js` renders each employee row as a plain `<div>` ending
in a `›` chevron, with **no click handler**. A chevron is a promise that
something is behind it. Nothing is.

(The chevrons in `schedule.js` and `miniapp.js` sit inside real `<button>`
rows and are fine — an early grep flagged them on too small a context window.)

### Finding 3 — notifications is a dead screen

The crawl found **0 interactive controls** on `/notifications`, while
`routes.ts` exposes `POST /notifications/:id/read` and
`POST /notifications/refresh`. The backend is ready and the screen ignores it.

---

## The scope decision this forces

`CODEX_READ_ME_FIRST.md` freezes API semantics, and every change this session
has honoured that. **Removing an employee cannot be done in the presentation
layer** — it needs new `DELETE` routes and repository functions. The owner has
asked for it directly, so the freeze is being lifted deliberately and only for
additive removal endpoints. Rules that still hold:

- no change to recurrence, permissions, the conflict engine, Assistant
  validation, or Shia Baby coverage logic;
- deletes are **authorised** exactly like the existing event delete and must be
  household-scoped — a cross-tenant delete is the worst possible bug here;
- prefer **deactivate** over hard delete where history matters (an employee with
  worked shifts, a member on past events), so the ledger and audit stay honest;
- every new route needs tests, and `npm run gauntlet` must stay green.

---

## Order of work (why it is not "one agent per mini-app")

The naive split — an agent per mini-app — would have five agents editing
`server/api/routes.ts` and `server/db/repositories.ts` at once. This repository's
own swarm design exists to prevent exactly that ("an agent that quietly edits a
shared contract breaks every sibling"). So:

**Phase 1 (serial, one owner):** API — add the removal/read endpoints and
repository functions in a single pass, with tests.
Owns: `server/api/routes.ts`, `server/db/repositories.ts`, `tests/http/**`.

**Phase 2 (parallel, disjoint file ownership):** wire the UI, one agent per area.

| Agent | Owns | Job |
| --- | --- | --- |
| shia-baby | `public/views/business.js` | remove employee/shift/product; make the employee row do something or drop the chevron |
| lists | `public/views/lists.js` | delete + un-buy on shopping, delete on errands/reminders |
| household | `public/views/household.js`, `notifications.js`, `inbox.js` | remove/deactivate a person, revoke invitation, mark notifications read |
| schedule | `public/views/schedule.js`, `event.js`, `compose.js`, `miniapp.js` | confirm delete-event is reachable; no dead affordances |

**Phase 3:** orchestrator (the main session) re-runs the crawl, the gauntlet and
the full suite, then one PR.

---

## Status

- [x] Triage complete — findings above, evidence from a real browser crawl
- [x] Branch restarted from `main`
- [ ] Phase 1 — API removal endpoints
- [ ] Phase 2 — UI wiring
- [ ] Phase 3 — verify, PR, deploy

## How to resume

1. `git checkout claude/michel-os-design-ux-hi7nfu`
2. Read this file — it is the plan of record.
3. Reproduce the triage any time:
   `node --experimental-strip-types <scratch>/devserver.ts` then the crawl
   script; or simply `grep -n "r\.delete" server/api/routes.ts` and count.
4. Continue at the first unchecked box above.

## Verification gates (all must pass before the PR)

```sh
npm test                                    # 619 passing before this work
npm run gauntlet                            # 9 challengers, includes cross-tenant probes
node --experimental-strip-types tools/assets/icons.ts --check
```

Plus: re-crawl every route and confirm each screen now offers the removal its
data implies, and that no control exists that does nothing.
