# Two people, one household

Michel-OS is built for a couple sharing one schedule. This is how that works,
and what it does not do.

## Two accounts, one household

Each person gets their own email and password — nobody shares a login. One of
them invites the other from **More → Household & family**, which produces an
invitation code; the invited person pastes it into **Invitation code** when
creating their account, and lands in the same household.

Verified end to end against the running API: the invitation previews the
household before signing up, the second account joins the same household id,
each person sees the other's events and shopping items, a tick by one shows as
ticked for the other, and a logged-out stranger gets a 401.

## Two ways to add a person, and they are not the same

The Household screen has both, and picking the wrong one is the mistake that
leaves a partner unable to sign in:

| | Makes | Use for |
| --- | --- | --- |
| **Add someone without a login** | a profile on the calendar, no account | a young child, anyone who will not sign in |
| **Invite someone with a login** | their own account | a partner, an older child with a phone |

The member list badges each person **Login** or **Managed profile** so the
difference stays visible afterwards, and each card says in a sentence which one
it is for.

## It syncs; it is not live

There is no WebSocket, no server-sent events and no polling. Data is fetched
when a screen loads, which means:

- **Navigating** to any screen shows current data.
- **Returning to the app** refetches, if the view has been up more than 30
  seconds — see `refreshIfStale` in `public/app.js`.
- **A screen you are already looking at** does not update by itself. If she is
  on Home and he adds an event, it appears when she next navigates or comes back
  to the app, not while she watches.

That last point is the honest limit of the current design. Real-time would mean
a push channel, which is a server change, not a presentation one.

### Why the refresh-on-return has guards

Three, because a refresh at the wrong moment is worse than a slightly stale
screen:

1. **Not within 30 seconds.** Glancing at another app and back should not
   reload anything.
2. **Never while a form holds typing.** `show()` rebuilds the view, so a refresh
   part-way through adding an event would discard it — precisely when somebody
   checked another app for the date.
3. **Never offline**, where the fetch would only replace the screen with an
   error.

All four behaviours (quiet window, refresh after, typing preserved, offline left
alone) are covered by `docs/design/checks/refresh-on-return.mjs`.

Two implementation notes worth keeping, both of which cost a debugging cycle:

- The listener is on `document`, not `window`. `visibilitychange` is fired at
  the Document; it bubbles, so a window listener usually sees it, but binding a
  document event to window is fragile and reads wrong.
- **Headless Chromium never backgrounds a page.** `visibilityState` stays
  `visible` and no visibilitychange/focus/blur fires at all, so a test that
  switches tabs proves nothing. The test overrides the state in-page and
  dispatches the event itself.

## Both of you need to reach the same server

This is self-hosted. Running on one laptop means only that laptop can see it —
put it somewhere both phones can reach before expecting it to be shared.
`docs/deploy/` covers a VPS with a domain and HTTPS.

## Roles

An invited adult sees the whole family schedule without being made an owner.
Teen and child accounts see less, and the Shia Baby books are gated separately
by `business.read` / `finance.read`, so a partner on the calendar is not
automatically in the accounts.
