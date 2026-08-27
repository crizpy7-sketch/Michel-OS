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

`public/brand/shia-baby-bear.png` is an exact crop from `art/source/shia-baby-original.jpeg`. Do not replace, recolor, or regenerate the bear.

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
