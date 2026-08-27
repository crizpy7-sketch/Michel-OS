# QA Status

## Passed in the packaging environment

- Browser JavaScript syntax check for `public/app.js`, `public/lib/*.js`, and every `public/views/*.js` file.
- `tests/ui/routes.test.ts`
- `tests/ui/shell.test.ts`
- 29/29 UI/shell tests passed.
- File-diff guard confirmed all modified source files are in the presentation-safe surface: `public/**`, `server/ui/**`, `docs/design/**`, and the Codex handoff file.

## Full suite note

A full `npm test` attempt ran 621 tests, but the temporary package install in the packaging sandbox was incomplete (`@electric-sql/pglite` was missing its installed entrypoint), so DB/HTTP tests could not be used as a reliable signal there. Domain-only tests that did not require the missing package continued to pass. Run `npm ci && npm run gauntlet` in the normal connected dev/VPS environment before production deployment.
