# Michel-OS — Family Scheduling OS

An AI-assisted family scheduling system, built by a **swarm of specialist agents**
working in parallel and verified by an **adversarial gauntlet loop**.

The product spec, architecture, data model and swarm plan live in
[`docs/handoff/`](docs/handoff). This README is about *how the thing gets built*.

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
(`tools/swarm/probes/`). They import the real modules and attack them:

- the security probe throws a hostile corpus at the authorization kernel and the
  AI action validator — a cross-tenant `householdId` in a model-generated
  payload, a `role: "owner"` escalation field, a `__proto__` pollution attempt,
  a prompt-injection string, a model-chosen primary key;
- the determinism probe runs each engine twice and then again with its input
  shuffled, and demands byte-identical output — the frozen `Conflict` contract
  requires ids to be a pure function of the inputs;
- the performance probe runs the conflict sweep over 5,000 occurrences against a
  wall-clock budget, then checks the growth curve so a quadratic scan cannot
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

| | Agent | Owns |
| --- | --- | --- |
| A | Lead Orchestrator | contracts, harness, docs |
| E | Household/Auth | `domains/household/**` |
| F | Core Scheduling | `domains/scheduling/recurrence.ts` |
| G | Conflict Engine | `domains/scheduling/conflicts.ts` |
| H | AI Scheduling | `domains/ai/**` |

Agents in the same phase run concurrently *because* their `owns` sets are
disjoint — and the `ownership` challenger fails the build the moment that stops
being true.

Contract changes requested by agents mid-flight are not applied silently; they
are recorded in [`docs/contract-change-requests.md`](docs/contract-change-requests.md)
and batched into a versioned re-freeze.
