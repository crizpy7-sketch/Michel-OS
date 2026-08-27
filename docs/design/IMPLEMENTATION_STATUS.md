# Warm Editorial Implementation Status

## Implemented in this package

- Warm editorial global design tokens and responsive surface styling
- Home launcher reduced to the approved nine primary mini-apps
- Protected Shia Baby bear crop from the original brand source
- Approved Shopping bag art for the launcher
- Floating cream navigation with champagne Add action
- Editorial page headers and shared cards/controls
- Schedule week strip, filters, domain artwork, event hierarchy and chevrons
- Hubby Work / generic mini-app event-card polish
- Add screen form card, visual mini-app chooser and large CTA
- Assistant intro, prompt, working, review, confirmation and applied presentation states
- Shopping add/list/bought presentation
- Shia Baby summary metrics, employees, warnings and shifts presentation
- More → Appearance selector
- Automatic/classic/Christmas/Halloween/Valentine's/Spring appearance layer
- Reduced-motion support
- Warm PWA theme/status colors

## Deliberately unchanged

All domain, DB, API, recurrence, permissions, Assistant validator/executor, Shia Baby staffing, inventory, finance, auth, and VPS deployment behavior.

## Before production deploy

1. Run `npm ci` in a normal connected development/VPS environment.
2. Run `npm run typecheck` and `npm run gauntlet`.
3. Review Home, Schedule, Add, Assistant, Shopping, Hubby Work and Shia Baby on iPhone-sized, iPad-sized and desktop viewports.
4. Confirm the original Shia Baby bear appears consistently.
5. Smoke-test the previously proven Assistant requests and Monday–Friday recurrence.
6. Deploy only the Michel OS app container; do not touch MarketSwarm or other VPS workloads.
