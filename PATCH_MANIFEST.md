# Michel OS Warm Editorial — Redesign Patch

This is **not the full repository**. It contains only the presentation-layer files changed or added for the approved warm-editorial redesign.

## How Codex should use this

1. Open the current `Michel-OS` repository.
2. Create/use branch `feature/warm-editorial-redesign` from current `main`.
3. Copy this patch over the repository root, preserving paths.
4. Read `CODEX_READ_ME_FIRST.md` and `docs/design/` before making further edits.
5. Run the full project gauntlet/tests in the normal development environment.
6. Fix only presentation-layer defects unless a test proves otherwise.
7. Do **not** modify the frozen engine: domains, recurrence, DB migrations, Assistant validation/execution, permissions/auth, or Shia Baby business rules.
8. Commit and push the UI branch for review.

## Contents

- 12 modified presentation files
- 19 new design/theme/reference files
- 0 intended engine/domain changes

## Changed / added paths

```text
public/app.js
public/app.css
server/ui/shell.ts
public/lib/art.js
public/views/schedule.js
public/views/home.js
public/views/compose.js
public/views/lists.js
public/views/miniapp.js
public/views/assistant.js
public/views/business.js
public/views/more.js
CODEX_READ_ME_FIRST.md
docs/design/IMPLEMENTATION_STATUS.md
docs/design/README.md
docs/design/QA_STATUS.md
docs/design/MOTION.md
docs/design/ACCEPTANCE.md
docs/design/HOLIDAY_SKINS.md
docs/design/ENGINE_FREEZE.md
docs/design/references/add-approved.jpeg
docs/design/references/shia-baby-approved.jpeg
docs/design/references/shopping-approved.jpeg
docs/design/references/assistant-approved.jpeg
docs/design/references/hubby-work-approved.jpeg
docs/design/references/schedule-approved.jpeg
docs/design/references/home-approved.jpeg
docs/design/tokens/warm-editorial.json
public/brand/shia-baby-bear.png
public/brand/shopping-approved.png
public/lib/theme.js
```
