# Holiday / Seasonal Skins

Implemented through `public/lib/theme.js` + CSS `data-skin` attributes.

## Modes

- `auto`
- `classic`
- `christmas`
- `halloween`
- `valentines`
- `spring`

Automatic windows:

- December → Christmas
- October → Halloween
- Feb 1–14 → Valentine's
- Mar 15–Apr 30 → Spring/Easter
- otherwise Classic

Each skin moves five things:

- `--midnight` / `--navy`, the canvas everything sits on
- `--navy-line`, the hairline between the cards and that canvas
- `--season-a/b/c`, the three corner washes
- `--season-motif`, the wallpaper tile (below)
- `--gold` / `--gold-bright`, far enough to sit correctly on the season's canvas

## The wallpaper

A repeating 260px tile of engraved botanical line work, painted on `body::before`
-- its own fixed layer under the content and over the washes. Classic sets
`--season-motif: none` and gets no wallpaper at all.

| Skin | Motif | Ink |
| --- | --- | --- |
| Christmas | fir sprigs, six-point stars | evergreen `#2f5741` |
| Halloween | bare branches, crescent moons | plum `#5c4763` |
| Valentine's | laurel sprigs, small open hearts | rose `#9c5a66` |
| Spring / Easter | new-growth sprigs, eggs | sage `#5b7a55` |

One system, four seasons: 1.1px strokes, no fills, no closed silhouettes, drawn
on the same 260px grid. What changes is the plant and the ink — not the hand.
That is what keeps them from reading as four sets of holiday stickers bolted
onto the same app.

### The wallpaper gets quieter as the screen gets bigger

`--season-motif-strength` is 0.5 on a phone, 0.22 from 48rem, 0.16 from 74rem.

A phone shows the wallpaper only through the gutters — the cards cover nearly
the whole width. A desktop exposes far more canvas and puts about five times as
many motifs on screen, and the section headings ("Morning Brief", "Next up") sit
directly on that canvas with no card behind them. At a flat 0.5 the pattern drew
straight through them.

Growing the tile instead of easing the strength was tried and is worse: it thins
the motifs out but draws each one larger, so a tablet gets fewer, more
conspicuous marks — and it breaks the one thing holding the four seasons
together, which is that they are drawn at one size by one hand. The tile stays
260px at every width.

Measured with the layer isolated (the same skin, rendered with and without the
wallpaper), the motifs touch about 1% of pixels at every width, and peak stroke
intensity falls with the ramp:

| Width | strength | peak Δ | pixels touched |
| --- | --- | --- | --- |
| 390px | 0.5 | 95 | 1.0% |
| 834px | 0.22 | 43 | 0.9% |
| 1440px | 0.16 | 31 | 0.7% |

The tiles are inline SVG data URIs, which the CSP permits (`img-src 'self'
data:`), so a season costs no extra request and nothing to cache-bust. They add
about 9 KB to `app.css`.

They are generated, not hand-written: the source of truth is `motifs.mjs` in the
design working files, which emits both the shipped CSS and the design canvas, so
the preview and the product cannot drift.

**Why not the old corner dots.** The previous decoration was four radial-gradient
dots pinned to the viewport corners. Three of the four sat behind a card at any
given moment, so most of that flourish was never visible.

They cannot change layout, content hierarchy, icon identity, or any engine
behavior.

**Gold stays gold.** It is the primary action colour on every screen — the Add
button, the form submits, the next event — and a red one in December is a
different product, not a seasonal skin. A skin retunes it; a skin does not
replace it.

**No skin carries a motion rule.** The original scope named "subtle motion" and
none of the four ever had any, so the Appearance card told people about
something that did not happen. If motion is ever added, MOTION.md governs it —
no pulsing warnings, no confetti by default, and `prefers-reduced-motion` wins.

## Card surfaces are deliberately untouched

`--navy-raised` and `--ivory` are the same in all five skins, so body text sits
on the same surface at the same 16.18:1 contrast whatever the season. A skin
changes the room, not the paper.

## Calibration

The first implementation set only the three washes, at alpha 0.08–0.14. Measured
against classic at 390px that came to a mean per-pixel delta of 1.4–2.6 out of
255 — below what anyone can see on a phone. The current values measure:

| Skin | mean Δ | max Δ | % pixels changed >2 | button label contrast |
| --- | --- | --- | --- | --- |
| Christmas | 8.03 | 114 | 70% | 2.79 |
| Halloween | 8.65 | 93 | 75% | 3.49 |
| Valentine's | 5.46 | 81 | 65% | 2.90 |
| Spring | 6.72 | 83 | 69% | 2.88 |

The max deltas are the motif strokes; the means stay low because the wallpaper
is sparse by design.

Classic's own gold gives that button label 2.45, so every skin reads at least as
well as the baseline. That baseline is itself under the 3.0 WCAG asks for large
text — a property of the approved brand gold, not of the skins, and worth
settling separately.

Re-measure with `themes.mjs` + `diff.mjs` if these values are ever retuned.
