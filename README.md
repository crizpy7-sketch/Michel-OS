# Michel-OS — Family Scheduling OS

An AI-assisted family scheduling system, built by a **swarm of specialist agents**
working in parallel and verified by an **adversarial gauntlet loop**.

The product spec, architecture, data model and swarm plan live in
[`docs/handoff/`](docs/handoff). Where the product actually stands against
PRODUCT_SPEC §14's 29 acceptance criteria — criterion by criterion, including
the ones with nothing behind them yet — is
[`docs/DELIVERY_STATUS.md`](docs/DELIVERY_STATUS.md).

This README is about *how the thing gets built*.

---

## The two ideas

**1. Parallelism is bought with contracts, not luck.**
Before any agent starts, the orchestrator freezes
[`lib/contracts/index.ts`](lib/contracts/index.ts) and hash-pins it in
`tools/swarm/contract.lock`. Every agent then owns a disjoint set of files
(`tools/swarm/registry.ts`) and builds against the frozen shape. An agent that
quietly edits a shared contract to make its own module compile breaks every
sibling at once — so the gauntlet checks the hash on every run.

**2. Self-reported "done" is worth nothing.**
Phase E of `SWARM_ORCHESTRATION.md` is *Adversarial Review*. Here that is a set
of challengers whose job is to prove the swarm's output is broken. Each one runs
real code or reads real compiler/test output — none of them accept an agent's
own status report.

---

## Running it

```bash
npm install

npm run swarm        # orchestrator checkpoint: delivery %, blockers, next milestone
npm run swarm -- --graph    # dependency graph and phase gating
npm run gauntlet     # one adversarial round + repair routing
npm run gauntlet -- --rounds 3       # let the repair loop iterate
npm run gauntlet -- --freeze         # re-pin the contract hash first
npm run gauntlet -- --json           # machine-readable report
npm test             # the unit suite on its own
```

Where the product stands against the V1 acceptance criteria:
[`docs/DELIVERY_STATUS.md`](docs/DELIVERY_STATUS.md). The short version is that
the domain tier is done and tested and the persistence and frontend tiers are
not started, so **no acceptance criterion is complete** under
SWARM_ORCHESTRATION.md §7 — the page says which part of each one is standing.

No bundler and no transpile step: Node 22 strips the TypeScript types natively.

---

## The gauntlet

| Challenger | What it is trying to prove is broken |
| --- | --- |
| `contract-integrity` | an agent rewrote the frozen contracts to make its own code compile |
| `ownership` | a file belongs to nobody, or two agents claim it |
| `typecheck` | type errors — attributed to the agent that owns the file |
| `unit-tests` | failing tests, routed to their owner by file |
| `purity` | a hidden clock, `Math.random`, a stub, an `as any` inside domain logic |
| `definition-of-done` | a module that exists but is empty, untested, or exports nothing |
| `determinism` | an engine whose output changes when you shuffle the input |
| `adversarial-security` | cross-tenant escape, privilege escalation, prototype pollution |
| `performance` | an algorithm that passes on six events and melts on a real household |

`determinism`, `adversarial-security` and `performance` are **runtime probes**
(`tools/swarm/probes/`) — 46 checks that import the real modules and attack them:

- the security probe throws a hostile corpus at the authorization kernel and the
  AI action validator — a cross-tenant `householdId` in a model-generated
  payload, a `role: "owner"` escalation field, a `__proto__` pollution attempt,
  a prompt-injection string, a model-chosen primary key — and then goes after
  the same claim in every other module: completing a reminder in another
  household, scheduling a rival business's shift, reading the shop's books as a
  viewer, finding a family appointment through the search box as an employee;
- the determinism probe runs each engine twice and then again with its input
  shuffled, and demands byte-identical output — the frozen `Conflict` contract
  requires ids to be a pure function of the inputs, and every list a person
  reads has to survive the same treatment;
- the performance probe runs the conflict sweep over 5,000 occurrences, a search
  over 20,000 documents and a year of shifts for a dozen staff, all against
  wall-clock budgets, then checks the growth curve so a quadratic scan cannot
  hide behind a fast machine.

### The loop

```
Phase E  run every challenger
            │
            ├── no blocking findings ──► PASSED
            │
Phase F  route each finding to the agent that OWNS the file
         write .swarm/tickets/round-N/<agent>.md
         dispatch repairs ──► re-run Phase E
            │
            └── budget spent ──► EXHAUSTED
```

`EXHAUSTED` is a real verdict. A gauntlet that always eventually passes is a
slow rubber stamp, so the loop reports unresolved blockers rather than
lowering the bar to reach green.

---

## The swarm

Roster and file ownership: `tools/swarm/registry.ts`, derived from
`docs/handoff/SWARM_ORCHESTRATION.md` §1.

| | Agent | Owns | Phase |
| --- | --- | --- | --- |
| A | Lead Orchestrator | contracts, harness, docs | A |
| E | Household/Auth | `domains/household/**` | B |
| F | Core Scheduling | `domains/scheduling/recurrence.ts` | C |
| G | Conflict Engine | `domains/scheduling/conflicts.ts` | C |
| H | AI Scheduling | `domains/ai/**` | C |
| I | Personal Organization | `domains/personal/**` | C2 |
| J1 | Shia Baby Staffing | `domains/shia-baby/staffing.ts` | C2 |
| J2 | Shia Baby Ledger | `domains/shia-baby/ledger.ts` | C2 |
| K | Search / Notifications | `domains/platform/**` | C2 |

Agents in the same phase run concurrently *because* their `owns` sets are
disjoint — and the `ownership` challenger fails the build the moment that stops
being true.

### Contract versions

Contract changes requested by agents mid-flight are never applied silently; they
are recorded in [`docs/contract-change-requests.md`](docs/contract-change-requests.md)
and batched into a versioned re-freeze **between** phases.

That has happened once. Six requests piled up behind the v1.0 freeze during
Phase C — reminders had no permission verb of their own, a shift was being
smuggled through a field named `eventId`, `every N weeks` had no week start,
expansion truncated silently — and all six were applied together as
**v1.1** before Phase C2 began. Four more (CR-009…CR-012) are already open
against v1.1, including one that is really a permission-model question and so
belongs to Agent E rather than to the agent that noticed it.

### Last run

```
9/9 challengers clean · 381 tests passing · 0 blocking findings   GAUNTLET PASSED
```

Nine domain modules, written by agents that never read each other's code. Both
integration phases — Phase D for the original four modules and Phase D2 for the
five that joined them — passed on their first run.

The gauntlet has caught four real defects so far, and none of them were found by
the agent that wrote the code:

- two in the orchestrator's own harness on its first full pass: a test
  challenger that reported one synthetic failure while 125 real tests sat unrun,
  and a performance probe whose synthetic load produced zero conflicts and so
  measured the empty path (`6a7c35c`);
- an order-dependent group label in the shopping list, where the same list
  rendered two different ways depending on which row arrived first;
- a schedule analysis that took 1404ms against a 750ms budget because it built
  an `Intl.DateTimeFormat` on every call — a mistake the conflict engine had
  already learned not to make, in a module written by an agent that had not read
  it. 1404ms → 80ms.

That last one is the argument for the whole apparatus: nine green unit suites
had nothing to say about it.
