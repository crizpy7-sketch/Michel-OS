# UX Review — Warm Editorial, post-implementation

The warm editorial layer was reviewed against the running app rather than
against the reference JPEGs: a seeded household (four members, twelve events
across a week, a shopping list, errands, reminders, three employees and five
shifts) rendered at 320, 390, 834 and 1440px, screenshotted, and read.

The reference screens were already matched. What follows is what only shows up
once real data is in the layout — a title long enough to wrap, four people on
one event, a domain with no artwork, a week that has to fit seven days.

Everything below is presentation-only: `public/**`. No domain, API, DB,
recurrence, permission, Assistant or Shia Baby behaviour was touched.

---

## Defects found and fixed

### 1. List rows collapsed to one word per line

The worst of them, and the one that made the schedule unreadable on a phone.

`.entry` and `.schedule-entry` ended their grids with an `auto` track holding
the clash chip, the avatars and the chevron. A max-content track sized to that
cluster beats a `minmax(0, 1fr)` sibling every time, so the title column was
squeezed to nothing and a row like "Noah birthday party (Leo)" wrapped one word
per line into a 25-line row.

The trailing track is now capped with a `--entry-meta-w` token — narrower on a
phone than on a desktop, because the phone has to give more of the row to the
title.

### 2. Rows for domains with no artwork shifted a column

`schedule.js` only rendered the artwork cell when the domain had a mini-app
behind it. On a phone the time cell is `display: none`, so a row that also
skipped the art cell put its title in the 3.5rem artwork column — the same
one-word-per-line collapse, and the reason it survived the first fix.

The slot is now always rendered, empty when there is nothing to put in it.

### 3. Clash explanations restated the row they were attached to

"No one is marked as responsible for Noah during Noah birthday party (Leo), from
1:00 to 3:30 PM on Saturday, August 29" sat under a row already showing that
title, that time and that date. It was the tallest thing in every conflicted
row.

Clamped to two lines. The full sentence stays in the row's tooltip and on the
event screen, and the engine's wording is unchanged.

### 4. Link-shaped buttons were underlined

`.btn` never set `text-decoration: none`, so the global anchor underline drew
through every `<a class="btn">` — the Shia Baby section tabs, "Open staffing &
publish", "Open errands", "See schedule", "Add something".

### 5. `/add` pushed the page to 785px on a 390px phone

The mini-app picker scrolls horizontally, but a grid item's automatic minimum
size is its max-content width, so the card containing it grew instead of the
picker scrolling. Fixed with an explicit zero minimum along the chain. Every
route is now free of horizontal overflow at 320 and 390px.

### 6. Sunday fell off the week strip

`repeat(7, minmax(3.2rem, 1fr))` needs more width than a phone has, so the strip
scrolled and Saturday and Sunday sat off the edge behind a hidden scrollbar. The
days now share the width they are given.

### 7. The Add screen carried the same field twice

A native "Mini-app" select near the top and the artwork picker below the notes
field — one value, two controls, roughly 1500px apart, where choosing in one
silently changed the other off-screen.

Now one control: the picker, moved up beside the title, and promoted from a row
of `aria-pressed` toggle buttons to a proper `radiogroup` with arrow-key
navigation and a roving tabindex.

### 8. Every new event started with two empty date fields

`mm/dd/yyyy, --:-- --`, twice, before anything could be saved. Starts now
defaults to the next half hour and Ends to an hour after it; moving the start
drags the end along, keeping whatever length was set.

### 9. Wire values reached the screen as labels

`needed`, `purchased`, `blocking`, `draft`, `open` — lowercase enums in chips.
`statusLabel()` in `lib/format.js` maps the known ones and sentence-cases the
rest, so a status added later is ugly rather than invisible.

### 10. The shopping list was a poster per banana

8rem rows with a 2rem serif name and `Qty 1` under every one of them; six
groceries filled two and a half screens. The control for marking something
bought was a gold pill labelled with the state it was already in — "needed" —
which reads as a status badge, not a button.

Rows are now 4.4rem, the quantity line only appears when the quantity is not
one, the button says "Got it", and the list groups by aisle. Grouping only
kicks in when it actually gathers something: six items in six aisles is six
headings and no grouping.

### 11. Staffing warnings showed ISO dates

"Nobody is scheduled to open on 2026-08-27." The engine composes these strings
and is unchanged; the view rewrites only the date literals inside them.

### 12. An empty Shia Baby workspace was a dead end

Four zeros and one button, with the employee, warning and shift sections all
rendering as nothing. It now says what the first step is.

### 13. A back chevron on tab-bar destinations

Schedule, Assistant and More are roots, not somewhere you arrived from. Back is
now hidden on all five tab destinations rather than on `/` alone.

### 14. Smaller things

- The avatar stack ran to four faces plus a counter, wide enough to squeeze the
  title beside it; three plus a count now, with the full list still on the
  `aria-label`.
- The domain eyebrow on schedule rows was the one cool blue in a warm palette.
- The schedule toolbar's "Add" was an underlined text link sitting between two
  selects; it is the toolbar's primary action and now looks like one.
- Shia Baby's four section tabs overflowed their row, clipping "Money" with
  nothing to say it was there. They are a segmented control that fits.
- Metric labels read "3 Employee" and "0 Open shift".
- The selected mini-app tile was distinguished by a 1px border tint; it is now
  filled and ringed.

---

## Desktop and tablet

UI_RESPONSIVE_SPEC §1 asks for an intentional layout per breakpoint, and §3
warns against "phone UI centered in huge empty canvas". On a 1440px desktop the
home screen was one column: a greeting wrapped to three lines by a phone's 11ch
cap, nine tiles in a six-column grid leaving three orphans, and 900px-wide cards
holding two lines of text, with the Morning Brief starting below the fold.

- The brief and the schedule are now two columns from 62rem up, so both are
  above the fold.
- The greeting relaxes to 18ch once it has a column to sit in.
- The launcher is 3×3 on a tablet and one row of nine on a wide desktop, instead
  of 6+3.
- Card text is held to a 62ch measure.

The tablet split-pane for Schedule that §3 also suggests — calendar and details
side by side — is **not** done. It is a genuine layout change rather than a
defect fix, and it wants its own pass.

---

## Not changed, deliberately

- **The conflict engine's severity.** A household of four generates six clashes
  on day one, five of them "no one is marked as responsible", all rendered as
  `blocking`. The home screen therefore opens on a red 6 and a wall of red
  paragraphs. Whether "nobody is responsible for a child at this event" should
  block is an engine question, not a CSS one, so the presentation layer only
  stops it from shouting.
- **The bear, the artwork, the palette, the seasonal skins, the motion spec.**
- **Every domain, API, DB, auth and deployment behaviour.**

---

## Known debt in the presentation layer

`public/app.css` is two design systems stacked: sections 1–12 are the original
dark navy/gold system, section 13 is the warm editorial layer that overrides it.
Two consequences worth knowing about before the next visual change:

1. **Section 13 writes raw hex.** Section 1 states the rule — "nothing else in
   this file writes a raw colour" — and the override layer breaks it roughly
   sixty times. Those literals are invisible to the seasonal skins, which only
   move `--season-*` and `--gold`, so a skin can never shift them.
2. **`[data-theme='light']` is now wrong.** It inverts the *dark* tokens, but
   the base is already light, so setting that attribute would produce a broken
   hybrid rather than a light theme. Nothing sets it today.

Neither is a live bug. Both would be resolved by folding section 13 into the
token block rather than layering a third set of overrides on top.

---

## Verification

- 619/619 `npm test` pass.
- Every route free of horizontal overflow at 320px and 390px.
- Changed files are all under `public/**`.
