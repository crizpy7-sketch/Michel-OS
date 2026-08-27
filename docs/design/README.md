# Michel OS Warm Editorial Design System

These files define the approved visual layer for Michel OS. The product engine is intentionally unchanged.

## Direction

Michel OS should feel like a premium family operating system: calm, editorial, warm, trustworthy, and easy to scan on a phone.

- warm ivory canvas
- cream elevated surfaces
- charcoal text
- champagne-gold primary accent
- elegant serif display typography with system sans-serif controls/body copy
- soft borders and restrained shadows
- original colorful mini-app identity
- large touch targets and generous breathing room

## Protected artwork

The Shia Baby bear is the brand and is not to be recoloured or regenerated. It
was replaced once, deliberately, by the owner: the current bear is a cream
knitted bear with a navy bow, supplied as a transparent PNG.

It lives in two places, both generated from that one supplied file:

- `public/icons/shia-baby.png` — 1024×1024, the source the icon pipeline reads.
  Run `npm run icons` after changing it.
- `public/brand/shia-baby-bear.png` — 256×256, used only by the Shia Baby hero.

The earlier bear was an opaque crop from `art/source/shia-baby-original.jpeg`,
and `public/lib/art.js` special-cased the mini-app tile to load that 532 KB file
directly instead of the 4 KB derived asset. That special case is gone: the tile
now goes through the manifest like the other twelve icons, and the artwork being
transparent means it sits on the seasonal wallpaper instead of over it.

## Reference screens

- `home-approved.jpeg`
- `schedule-approved.jpeg`
- `add-approved.jpeg`
- `assistant-approved.jpeg`
- `shopping-approved.jpeg`
- `hubby-work-approved.jpeg`
- `shia-baby-approved.jpeg`

The references define hierarchy and visual language; the live UI must still render real data and preserve accessibility/responsive behavior.

## Motion

Use small 180–260ms transitions, tiny press scale, gentle card entrance, and one-time Assistant/success feedback. Respect `prefers-reduced-motion`.

## Seasonal skins

Skins are CSS token/atmosphere changes only. They cannot alter layout, icon identity, data, permissions, or behavior. Users can choose automatic, classic, Christmas, Halloween, Valentine's, or Spring/Easter from More → Appearance.
