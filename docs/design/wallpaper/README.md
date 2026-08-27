# Seasonal wallpaper

The four seasonal wallpapers, and the design canvas they were judged on.

- `motifs.mjs` — **the source of truth.** The SVG motifs, the 260px tile, the
  scatter, and the encoder that makes a tile safe inside both a CSS `url()` and
  an HTML `style` attribute.
- `emit-css.mjs` — prints the four `--season-motif` declarations that live in
  `public/app.css`. The stylesheet's tiles are generated; edit them here, not
  there.
- `build.mjs` — rebuilds the design canvas artboards (the home screen under each
  season, plus a sheet showing the motifs up close).

Both outputs come from the same definitions, so the canvas cannot drift from
what the app paints.

## Changing a motif

```bash
node docs/design/wallpaper/emit-css.mjs
```

Paste the four blocks over the matching `--season-motif` lines in
`public/app.css`, then look at the result — `docs/design/HOLIDAY_SKINS.md`
records how the skins are measured, and a motif that reads at full strength on a
swatch can disappear at the 0.5 opacity that actually ships.

## The rules the motifs hold to

One drawing system, four seasons: 1.1px strokes, no fills, no closed
silhouettes, the same 260px grid. What changes between seasons is the plant and
the ink — not the hand. Break that and they stop being a family and start being
four sets of holiday stickers on the same app.
