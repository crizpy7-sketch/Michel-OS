# Asset Map — Family Scheduling OS

## Rule for Codex

Use the assets in `public/icons/` for the approved mini-app visuals.

**Do not replace approved artwork with emoji, Lucide icons, generic stock icons, or CSS recreations.**

The detailed original design boards are preserved in `art/reference/`.

## Approved production icon assets

| Mini-app | Production asset | Status |
|---|---|---|
| Appointments | `public/icons/appointments.png` | APPROVED |
| Practice | `public/icons/practice.png` | APPROVED — shiny/glittery red + blue pom-poms |
| Shia Baby | `public/icons/shia-baby.png` | APPROVED |
| School | `public/icons/school.png` | APPROVED |
| Competition | `public/icons/competition.png` | APPROVED |
| Games | `public/icons/games.png` | APPROVED — Valley Cats blue/red wildcat + football |
| Errands | `public/icons/errands.png` | APPROVED |
| Hubby Work | `public/icons/hubby-work.png` | APPROVED — scaffold design workstation |

## Shia Baby brand source

- `public/brand/shia-baby-original.jpeg`
- `art/source/shia-baby-original.jpeg`

This is the original bear artwork supplied for Shia Baby. Preserve its visual identity.

## Final artwork still pending approval

Temporary placeholder files are supplied so development can continue without blocking:

- `public/icons/shopping.placeholder.png`
- `public/icons/reminders.placeholder.png`
- `public/icons/ai-assistant.placeholder.png`
- `public/icons/all-schedules.placeholder.png`
- `public/icons/inbox.placeholder.png`

These placeholders are **NOT approved production artwork**.

Codex must keep the asset references easy to swap when final art is supplied.

Do not silently ship the placeholders as final.

## Reference artwork

`art/reference/` contains the original high-resolution boards/images used to establish the visual direction, including the full scheduling app dashboard.

These are design references, not necessarily directly rendered UI assets.

## UI implementation requirement

On the home screen, use a reusable `MiniAppIcon` component so changing an icon requires only updating an asset path/data record.

Suggested mapping:

```ts
const miniApps = {
  appointments: "/icons/appointments.png",
  practice: "/icons/practice.png",
  shiaBaby: "/icons/shia-baby.png",
  school: "/icons/school.png",
  competition: "/icons/competition.png",
  games: "/icons/games.png",
  errands: "/icons/errands.png",
  hubbyWork: "/icons/hubby-work.png",
};
```

Pending icons should use an explicit `artStatus: "pending"` flag until approved.
