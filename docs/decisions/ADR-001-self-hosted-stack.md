# ADR-001 — Self-hosted Node + Postgres + Caddy, not Next.js + hosted Supabase

**Status:** accepted
**Supersedes:** `ARCHITECTURE.md` §1 (Preferred stack) for the runtime tier
**Does not change:** §2 (principles), §3 (AI pipeline), §4 (domain boundaries),
§5 (frozen contracts), §7 (recurrence), §8 (security), §9 (notifications), §10
(integration boundaries) — all of which stand exactly as written.

## The decision

Michel-OS runs on the household's own VPS as three containers:

| container | what it is | why |
| --- | --- | --- |
| `app` | one Node 22 process: HTTP API **and** server-rendered UI | one process to deploy, one log to read |
| `db` | PostgreSQL 16 | the frozen contracts are relational; nothing here wants a document store |
| `web` | Caddy | automatic HTTPS with no certbot cron and no manual renewal |

`docker compose up -d` and the household is live.

## Why this rather than the original stack

`ARCHITECTURE.md` §1 named Next.js + Supabase, written before there was a
deployment target. The target is now a VPS the family owns, which changes the
arithmetic:

- **Data residency was the point.** This system holds a family's medical
  appointments, their children's school movements, and a small business's
  books. On a VPS that data sits on hardware the household controls. Hosted
  Supabase would put it on someone else's, for a monthly bill, to solve a
  problem this deployment does not have.
- **Self-hosted Supabase is a lot of machinery for session cookies.** Running
  it properly means Postgres, GoTrue, PostgREST, Realtime, Storage, Kong,
  Studio and Meta — eight-plus containers wanting 4GB before a single family
  event exists. What it buys us here is authentication we can write in a couple
  of hundred lines of `node:crypto`, and Realtime that V1 does not use.
- **The domain tier is already framework-free.** Nine modules of pure
  TypeScript with no runtime dependencies, run by Node's native type stripping.
  A React build pipeline on top would be the single largest piece of machinery
  in the repository, and it would exist to render a family calendar.

## What this costs, honestly

- **No React.** The UI is server-rendered HTML with progressive enhancement.
  Rich client-side interaction (drag-to-reschedule, optimistic updates) is more
  work than it would be in React. Accepted: the interactions this product needs
  are forms, lists and a calendar grid.
- **We own auth.** Session handling, password hashing and invitation flows are
  ours to get right, and auth is a thing people get wrong. Mitigated by keeping
  it small and boring, and by an adversarial probe that attacks it — the same
  posture the domain tier already gets.
- **No managed backups.** Postgres backup and restore is a script and a cron
  entry, documented in the runbook, rather than someone else's SLA.
- **Realtime is not free.** If live multi-device updates are wanted later, that
  is SSE or WebSockets we write. Not needed for V1.

## What stays exactly the same

The reason this is a runtime decision and not an architecture rewrite:

- **`authorize()` remains the single access decision.** Postgres row-level
  security will mirror `ROLE_MATRIX` as defence in depth, never as a second
  opinion that could disagree with the kernel.
- **The frozen contracts are unchanged.** The schema is derived from
  `lib/contracts/index.ts` v1.1; the database does not get its own shapes.
- **AI proposes, the validator decides.** Model output still enters through
  `AIActionProposal` and still meets `validateAction` before anything is
  written.
- **Integration boundaries stay adapter-ready** (§10). Nothing here forecloses
  Google Calendar, maps, or a POS later.

## Testing the SQL, given no Docker daemon in CI

The build container has no Docker daemon, so a Postgres container cannot be
started to test against. Shipping SQL that had never been executed would be
precisely the self-reported "done" the gauntlet exists to refuse.

So the test suite runs **PGlite** — real PostgreSQL compiled to WebAssembly,
in-process. The migrations and queries under test are the same ones production
runs: same DDL, same constraints, same SQL. It is not a mock and not a
different dialect.

Where the two can differ (extensions, concurrency, `pg_stat`), the runbook says
so and those paths are exercised on the VPS rather than claimed here.
