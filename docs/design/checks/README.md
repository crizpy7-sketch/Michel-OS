# Behaviour checks

Scripts that exercise the running app for things a unit test cannot reach.
Each expects the app on `http://127.0.0.1:4310` with the usual seeded
household, and Playwright available.

- `refresh-on-return.mjs` — the refresh-on-return behaviour in `public/app.js`:
  that coming back to the app picks up the other person's changes, that a quick
  glance away does not reload, that half-typed forms survive, and that an
  offline return does not replace the screen with an error.

  It takes about three minutes, because it waits out the real 30-second quiet
  window three times rather than reaching into the module to shorten it.

  **Headless Chromium never backgrounds a page** — `visibilityState` stays
  `visible` and no visibilitychange/focus/blur ever fires — so switching tabs in
  a test proves nothing. The script overrides the state in-page and dispatches
  the event itself.
