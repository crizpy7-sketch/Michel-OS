# Michel OS — Read This First

The production engine is already working. Treat the backend/domain layer as **frozen**.

The current branch/package contains the approved warm-editorial presentation refactor. Continue only in the presentation layer unless a test proves a UI-induced defect.

## Do not change

- `domains/**`
- database schema/migrations
- API semantics
- Assistant validation/execution rules
- recurrence behavior
- permissions
- Shia Baby staffing/coverage logic
- persistence/auth behavior

## Safe implementation surface

- `public/app.css`
- `public/app.js` (routing/visual attributes only)
- `public/lib/art.js`
- `public/lib/theme.js`
- `public/views/**` for markup/presentation only
- `server/ui/shell.ts` for theme metadata/shell presentation
- `public/brand/**`
- `docs/design/**`

## Visual source of truth

See `docs/design/references/` and `docs/design/README.md`.

## Current implemented presentation work

- warm ivory / cream design tokens
- editorial serif hierarchy
- floating rounded navigation and central Add action
- approved 9-tile Home launcher
- protected original Shia Baby bear asset
- approved Shopping artwork
- Schedule week strip and richer schedule cards
- Add/compose visual mini-app picker
- Assistant idle/working/review/applied visual states
- Shia Baby workspace summary, employee/warning/shift presentation
- Shopping add/list/bought presentation
- subtle motion with `prefers-reduced-motion`
- seasonal appearance layer: automatic/classic/Christmas/Halloween/Valentine's/Spring

Run the UI/shell tests before touching anything:

```bash
node --test --experimental-strip-types tests/ui/routes.test.ts tests/ui/shell.test.ts
```
