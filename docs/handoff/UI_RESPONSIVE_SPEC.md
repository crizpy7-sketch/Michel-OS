# Family Scheduling OS — UI / Responsive Specification

## 1. Device targets

The product must be intentionally designed for:

### Mobile
- 320px
- 375px
- 390px
- 430px

### Tablet / iPad
- portrait
- landscape

### Desktop
- laptop
- wide desktop

Do not merely stretch the mobile UI.

Each breakpoint should have an intentional layout.

## 2. Mobile

Primary target.

Home:
- 3-column mini-app grid when practical
- clear top summary
- next event
- morning brief
- bottom navigation
- large touch targets

Mini-app screens:
- stacked cards
- bottom sheets
- easy one-handed interaction
- no dense desktop tables

## 3. iPad / Tablet

Use space intelligently:
- 4–5 column icon grid
- split panes where useful
- master/detail layouts
- left navigation rail can appear
- calendar and details can coexist
- Shia Baby business dashboards may use two-column layouts

Avoid:
- giant stretched cards
- phone UI centered in huge empty canvas

## 4. Desktop

Use:
- persistent sidebar/rail where appropriate
- wider calendar views
- multi-column dashboards
- event details in side panels
- Shia Baby tables and business dashboards
- global search
- keyboard-friendly interactions

## 5. Visual direction

Premium, not pastel-heavy.

Use:
- deep navy / midnight
- ivory / cream
- graphite
- restrained metallic gold
- subtle glass effects
- custom premium mini-app icons

Avoid:
- emoji icons
- cheap gradients
- over-saturated color coding
- generic SaaS dashboard styling
- excessive borders
- clutter

## 6. Icon assets

Expected folder:

public/icons/
  appointments.png
  practice.png
  shia-baby.png
  school.png
  competition.png
  games.png
  errands.png
  hubby-work.png
  shopping.png
  reminders.png
  ai-assistant.png
  all-schedules.png
  inbox.png

## 7. Core navigation

Recommended mobile nav:
- Home
- Schedule
- Add
- AI
- More

Tablet/desktop may transform to rail/sidebar.

## 8. Accessibility

Required:
- semantic controls
- keyboard access
- visible focus
- 44px-ish touch targets
- readable contrast
- screen-reader labels
- reduced motion support
- no information conveyed only by color

## 9. Loading/empty/error states

Every major page needs:
- loading skeleton
- empty state
- error state
- success state
- permission-denied state

## 10. Responsive QA

Every major feature must be tested at:
- small iPhone
- standard iPhone
- large iPhone
- iPad portrait
- iPad landscape
- desktop

Feature is not complete until it passes all relevant layouts.
