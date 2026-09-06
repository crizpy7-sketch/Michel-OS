# Michel OS verification and lint evidence

This bounded Phase 7 task enables lint; it does not repair application findings,
grant deployment authority, or complete the production lifecycle.

## Reproducible commands

Use the existing Node 22 CI runtime (22.13 or later; ESLint 10 also supports Node
24). Run `npm ci`, `npm run lint`, `npm run typecheck`, and `npm run gauntlet`.
The gauntlet retains its nine existing challengers, including the full test suite.
CI runs the same lint command separately and preserves its nonzero status while
continuing the gauntlet and, if that passes, disposable Docker verification.
No `continue-on-error`, autofix, bulk suppression file, or subset argument is used.

Development-only tooling is pinned in package.json and package-lock.json:
ESLint 10.10.0, @eslint/js 10.0.1, typescript-eslint 8.69.0 and globals 17.12.0.
The existing locked TypeScript 5.9.3 and all previously locked packages are unchanged.
ESLint 9 was considered to match Factory's existing configuration pattern, but
the package registry marks it unsupported; the supported 10.x CLI is compatible
with Michel's Node 22 runtime and typescript-eslint peer requirements.

## Rules and file coverage

`eslint.config.mjs` uses the official [ESLint / TypeScript recommended setup](https://typescript-eslint.io/getting-started/).
It applies @eslint/js recommended rules to all JS/TS and the TypeScript recommended
preset to TS. The official TS preset replaces JS rules that conflict with TS syntax
or TypeScript's own checks; `npm run typecheck` remains independently required.
No additional rules were disabled to accommodate existing findings. No stylistic
or formatting preset was added. Inline suppressions are disabled.

The runner enumerates Git-tracked and non-ignored untracked standalone
`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx` files. It passes the
explicit inventory to ESLint and requires one result per file. This covers:

- browser application code in public/ (browser globals, no Node globals);
- domains/, lib/, server/ and tools/ (Node globals);
- all tests/, including receipt-consumer and negative lint tests;
- docs/deploy/ receipt-consumer TypeScript;
- .github/scripts/, the lint runner/config, and docs/design/ JS tools.

The two docs/design/checks Playwright scripts contain Node code and browser
`page.evaluate` callbacks, so both global environments are declared for those exact
files. They are linted, not executed against any application by the lint command.

Exclusions: node_modules/, .git/ and .swarm/ are third-party or private operational
state. Non-JS/TS files (Markdown, YAML, SQL, shell, HTML/CSS, images) are outside this
standalone-source lint parser. Embedded scripts in strings/HTML and shell/SQL are
not claimed as linted; existing gauntlet checks remain applicable. There are no
maintained source-directory, test, receipt-consumer, or per-finding exclusions.
Every actual file checked and its SHA-256 is recorded. Zero-file execution,
ignored-file warnings, CLI overrides, and incomplete ESLint coverage fail.

## Execution evidence and failure behavior

`npm run lint` invokes the installed locked ESLint CLI without shell interpolation
or downloads. It writes `.swarm/lint-report.json` even when ESLint reports findings.
The record contains real CLI exit status, rule diagnostics and source positions,
checked files/hashes, exclusions/reasons, tool versions, config/runner/package/lock
hashes, command arguments, timestamps, exact Git candidate/tree, and clean-tree state.
Source bodies, suggested replacement code, credentials and environment dumps are
not retained. The local dirty-tree flag is visible; CI requires a clean exact HEAD
matching MICHEL_CANDIDATE_SHA. Source/config mutation during execution fails.

The report also records an actual disposable stdin negative control using the same
installed CLI/configuration: `debugger` must produce exit 1 and `no-debugger`.
Integration tests run the normal npm command in disposable Git fixtures and prove
positive execution, known-violation failure, suppression resistance, exact identity,
zero-file refusal, dirty-CI refusal, and rejection of subset/rule overrides.

The existing artifact preflight/upload retains exactly:

- .swarm/gauntlet-report.json
- .swarm/receipt-consumer-integration.json
- .swarm/lint-report.json

Hidden-file inclusion is explicit, either missing original report still fails,
and the new lint report requires actual coverage and exact candidate metadata.
A failed lint report is retained; upload success never converts failed lint into a
pass. The separate release-provenance allowlist remains unchanged. After CI, the
downloaded ZIP/member digests and exact member list must be inspected. GitHub
artifact retention is 14 days; durable PR evidence preserves reports and references.

This is **raw, unverified execution evidence**, not a canonical Quality receipt.
Only the unchanged pinned Factory's trusted evidence-admission/resolution process
may admit observed CI results. The collector must check the exact run/job/SHA,
actual step conclusion, report status/configuration/coverage, and retained bytes.
It must admit failed lint as failed, not invent a PASS from a successful upload or
test fixture. Pre-deployment quality, Cristian approval and post-deployment lifecycle
acceptance remain separate. Factory remains pinned read-only at
`d380dfbd4cc65466f6757c680e654a967d2749e0`.

## Findings and bounded follow-up

Initial lint execution reports existing findings; exact candidate results and the
full file/line/rule inventory are retained in CI/PR evidence. Source remediation is
not authorized by this task. Proposed follow-up is to classify each finding first:

1. Review unused declarations/imports and assignments for side effects and intent.
2. Review control-character regexes in security/receipt code without weakening
   their validation; propose precise evidence-backed treatment separately.
3. Review empty catch blocks, unnecessary escapes, and unused expressions against
   their intended behavior and existing tests.
4. Request bounded remediation authorization before changing application code;
   rerun exact-candidate lint/tests/Quality afterward. No blanket suppression.

The baseline and lint-tooling npm audits report the same existing high-severity
development `sharp` advisory (GHSA-f88m-g3jw-g9cj); production-only audit is clear
at inspection time. No unrelated dependency upgrade or risk waiver is performed.
The report is a time-bound audit observation, not a permanent security guarantee.

Prior repair history is preserved, including the used 1/1 retention attempt. This
separate lint task grants no automatic post-review repair, merge, VPS, deployment,
Factory Pages, Shelf admission or Phase 8 permission. Phase 7 stays 1/4 and official
progress stays 31/41 = 75.61%.
