# Family Scheduling OS — Swarm Orchestration Plan

## Non-negotiable requirement

Codex is the **Lead Orchestrator / Software Superintendent**.

The project must be built by a **swarm of specialized agents** operating in a **dynamic parallel workflow**.

Parallelism must be controlled by dependency contracts.

Do not create chaos by having all agents edit the same files.

## 1. Agent hierarchy

### A. Lead Orchestrator / Superintendent

Owns:
- architecture
- shared contracts
- task graph
- dependency graph
- agent assignments
- branch/worktree strategy
- merge sequencing
- blockers
- integration
- final quality gates

### B. Product Agent

Owns:
- product requirements
- workflows
- edge cases
- acceptance criteria

### C. UX / Information Architecture Agent

Owns:
- navigation
- user journeys
- mobile workflows
- tablet layout behavior
- desktop layout behavior

### D. Design System Agent

Owns:
- tokens
- typography
- spacing
- surfaces
- buttons
- cards
- icon integration
- motion

### E. Household/Auth Agent

Owns:
- auth
- households
- members
- roles
- invitations
- permissions

### F. Core Scheduling Agent

Owns:
- event model
- recurrence
- All Schedules
- participant assignment
- date/time logic

### G. Conflict Engine Agent

Owns:
- overlap engine
- responsibility conflicts
- work conflicts
- employee conflicts
- severity levels
- resolution metadata

### H. AI Scheduling Agent

Owns:
- intent parsing
- structured action proposals
- schemas
- confirmations
- AI suggestions
- morning brief
- inbox classification

### I. Mini-App Agent Group

Independent specialists:
- Appointments Agent
- Practice Agent
- Competition Agent
- Games Agent
- School Agent
- Errands Agent
- Shopping Agent
- Reminders Agent
- Hubby Work Agent

Each uses frozen shared scheduling contracts.

### J. Shia Baby Business Agent Group

Specialists:
- Business Overview Agent
- Employee Scheduling Agent
- Inventory Agent
- Sales Agent
- Expenses Agent
- Tax Set-Aside Agent

### K. Search/Notification/Attachment Agent

Owns:
- global search
- in-app notifications
- file attachments

### L. QA Agent

Owns:
- unit tests
- integration tests
- E2E
- regressions

### M. Security Agent

Owns:
- RLS
- tenant isolation
- auth review
- unsafe mutation review
- AI permission review

### N. Performance/Accessibility Agent

Owns:
- mobile performance
- iPad/tablet usability
- desktop responsiveness
- accessibility
- reduced motion
- touch targets

## 2. Dynamic workflow

PHASE A — Freeze Contracts
- architecture
- data model
- domain interfaces
- permissions
- AI action schemas

PHASE B — Parallel Foundations
- frontend shell
- backend schema/migrations
- auth/household
- design system
- test harness

PHASE C — Parallel Domain Build
- scheduling engine
- personal mini-apps
- Shia Baby business
- AI layer

PHASE D — Integration
- merge behind orchestrator
- resolve interface mismatches
- run migration/test suite

PHASE E — Adversarial Review
- QA agent
- security agent
- accessibility agent
- performance agent

PHASE F — Repair Loops
- failing domains routed back to responsible agent
- max iteration policy can be configured
- orchestrator tracks unresolved blockers

## 3. Parallel work rules

Agents may work in parallel only when:
- their interfaces are frozen
- they own disjoint files/modules
- they know upstream/downstream contracts
- they have explicit acceptance tests

Agents must not:
- rewrite shared contracts
- change database schema ad hoc
- bypass test failures
- silently disable failing features
- merge breaking migrations
- invent duplicate event models

## 4. Suggested branch/worktree model

Examples:
- feature/auth-household
- feature/core-scheduling
- feature/conflict-engine
- feature/ai-actions
- feature/shia-business
- feature/shopping-reminders
- feature/ui-shell
- feature/accessibility

Orchestrator branch:
- integration/family-scheduling-os

## 5. Quality gate before merge

Every agent must provide:
- files changed
- migration impact
- API impact
- tests added
- tests passing
- known limitations

## 6. Continuous reporting

Codex should maintain:
- overall completion %
- phase completion %
- active agents
- blocked agents
- merge queue
- failing tests
- unresolved security issues
- next critical dependency

## 7. Definition of done

A feature is not done merely because UI renders.

Done means:
- frontend exists
- backend exists where needed
- persistence works
- permissions work
- validation works
- tests exist
- responsive behavior verified
- error/loading/empty states exist
- no obvious console/server errors
