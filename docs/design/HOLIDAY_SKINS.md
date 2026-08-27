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

Each skin moves four things:

- `--midnight` / `--navy`, the canvas everything sits on
- `--navy-line`, the hairline between the cards and that canvas
- `--season-a/b/c`, the three corner washes
- `--gold` / `--gold-bright`, far enough to sit correctly on the season's canvas

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
| Christmas | 7.75 | 70 | 70% | 2.79 |
| Halloween | 8.55 | 61 | 75% | 3.49 |
| Valentine's | 5.36 | 43 | 65% | 2.90 |
| Spring | 6.54 | 43 | 69% | 2.88 |

Classic's own gold gives that button label 2.45, so every skin reads at least as
well as the baseline. That baseline is itself under the 3.0 WCAG asks for large
text — a property of the approved brand gold, not of the skins, and worth
settling separately.

Re-measure with `themes.mjs` + `diff.mjs` if these values are ever retuned.
