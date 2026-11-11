# CLAUDE.md — dev-dashboard

Personal EZAT dev-service dashboard (its own git repo, nested inside the `/ezat` monorepo — not one
of the ticketed TransAct business repos, no `TAP` tickets, no graphify graph). See `README.md` for
what it does. This file holds conventions worth knowing before touching the UI layer.

## Formatting and linting agent changes

There is no editor save hook for files edited by an agent, so apply the project's checks explicitly
after making code changes:

- Run Prettier on the changed supported files before finishing (use `npx prettier --write <files>`;
  don't format the entire repository unless asked).
- Run `npm run lint` after code changes and fix all reported issues, including warnings, before
  finishing.
- Run the relevant tests for behavioral changes; run `npm test` when the change may affect broader
  behavior.
- Report any check that could not be run and why.

## UI layout: masonry, not grid, for card lists

The retained legacy PR group styles and non-board card lists use real CSS
**multi-column masonry** — Pinterest-style packing — not `display: grid`.
Pull Requests now uses the shared board below, not these legacy group containers.
Grid lays cards out in strict rows, so if one card in a row is much
taller than its neighbor, everything below that row inherits the dead space; masonry lets a short
column pack the next card up instead.

**The pattern**, retained in `ui-react/styles/*.css`:

```css
.some-group-container {
  columns: 1;
  column-gap: <n>px;
}
@media (min-width: 760px) {
  .some-group-container {
    columns: 2;
  }
}
@media (min-width: 1700px) {
  .some-group-container {
    columns: 3;
  }
}

.some-card {
  break-inside: avoid;
} /* required, or a card can split across columns */
.some-card + .some-card {
  margin-top: <n>px;
} /* inter-item spacing; column layout doesn't collapse margins the way flex/block does */
```

Breakpoints (760px / 1700px, 1 → 2 → 3 columns) are fixed across every surface that uses this pattern,
matching `services.css`'s `.grid` (an explicit-row grid, not masonry, but same breakpoints) so the
whole app feels consistent regardless of which container a given screen width lands in.

**Applied to:**

- `.pr-open-groups` / `.pr-draft-groups` and `.pr-approval-groups`
  (`ui-react/styles/prs.css`) — retained legacy group rules, not the current Pull Requests layout.
  Do not remove legacy PR styles/helpers as part of Home or board work.

**Not masonry, intentionally:**

- The My Tickets, Slack and Pull Requests boards (`.board-track`, `ui-react/styles/board.css`) are one row of
  fixed-width columns (Jira statuses, Slack time groups, PR review lanes) that scrolls sideways inside itself; they
  are not card lists, so they have no `columns:` container and none of the breakpoints above. Each
  column's card list (`.board-column-body`) scrolls vertically on its own, with the column header
  outside it so the header stays in view. Columns are 280px wide; at 599px and below they are 82vw
  with `scroll-snap-type: x mandatory`, so the next column peeks in and snaps (`proximity` above
  that). How a board fills the viewport, and how a screen adopts it, is under "UI layout: the
  shared board" below.
- `services.css`'s `.grid` (Services tab) sets explicit `grid-template-columns` per breakpoint — a
  real multi-column grid, appropriate because service cards are roughly uniform height, not a
  masonry candidate.

**The recurring bug this repo has hit three separate times:** a container styled `display: grid;
gap: <n>px;` with no `grid-template-columns` set. Grid with an unspecified column count collapses to
a single implicit column — so it silently renders as a plain list forever, regardless of viewport,
and any `break-inside: avoid` on its children is a dead declaration (that property only does anything
under multi-column layout, never under grid or flexbox). This is an easy copy-paste mistake: the
`break-inside: avoid` gets added to the card because "that's what masonry cards have," without the
container ever getting the `columns:` half of the pair. **When adding a new card-list container that
should masonry-pack, use the pattern above verbatim — don't reach for `display: grid` and assume it
packs like the others.**

**A second gotcha the same migration can hide:** `display: grid; gap: <n>px;` gives every stacked item
a deterministic gap regardless of layout. `columns:` + `column-gap` only spaces columns _horizontally_
— vertical spacing between two items sharing a column depends entirely on the item's own margin, so
dropping `gap` without adding the `.card + .card { margin-top: <n>px; }` sibling rule silently shrinks
inter-item spacing to whatever margin the card already had (often smaller than the old `gap`). This bit
the `.my-ticket-status-group` migration once already — caught by review, not by any test, since no test
asserted a spacing amount. When migrating a `display: grid` container to `columns:`, add the sibling
margin rule in the same edit, every time, not just for the container you're most focused on.

## Home: manual velocity snapshot

Home uses `BoardPanel` / `BoardSection` with one velocity pane, not masonry or
legacy Sprint/Services/Needs You/PR widgets. It lazily restores a validated
all-team/person localStorage snapshot through `ui/home-velocity.js`; only explicit
Generate velocity / Refresh may call `/api/team-velocity`. No polling hook,
countdown, TTL or mount/activation/focus/visibility recovery fetch belongs here.
Team defaults to Nexus and persists separately; Everyone/person selection is
local and resets on Team change/reload. Keep the original Generated timestamp,
current-assignee/status/estimate sprint-membership caveats, last-good data on
failed generation and the separate unsaved-snapshot warning on storage failure.
Do not infer historical delivered work or change the standalone report. Other
screens' polling and shared board contracts below remain unchanged.

## UI layout: the bot bar (every screen)

`ui-react/components/BotBar.jsx` (mounted once in `AppShell`, only once setup is ready) is a
`position: fixed`, transparent strip of mascots along the bottom of every screen, one per Claude
session of any kind (investigate, implement, review, groom or e2e check). It is an overlay: `pointer-events: none` on the strip and `auto` on the
bots, z-index under the tooltip and dialogs, no change to any screen's height or the viewport-fill
rule; keep it that way, and never put a dialog inside the strip (it would inherit the
`pointer-events: none`). Which sessions get a bot is the single `SESSIONS` table in
`ui/bot-bar.js` (every row does; `BOT_PHASES` is derived from it, so a new kind of session is one new row there, never a second list) (`investigate`, `implement`, `review`, `groom`, `e2e`: every session an entry carries, in draw order; an e2e bot reads `entry.e2e` and is keyed `<KEY>:e2e`; every phase but `review` opens `ClaudeDialog`), with the state mapping, the done time to live, the hold rule and the pure helpers; `none` and
`unknown` get no bot. A bot also needs its ticket in an active Jira sprint: the pure filter
`inActiveSprint` is applied to the sessions with the keys `useActiveSprintKeys` gets from
`GET /api/active-sprint-tickets` (`fetchActiveSprintKeys` in `backend/jira.mjs`; per-ticket answers
cached 5 minutes server side, asked again by the browser every `SPRINT_POLL_MS`, 5 minutes). A ticket
whose sprint is unknown gets no bot, and on a failed or `available: false` answer the last good key set
stays; do not show a bot for a ticket the sprint filter has not placed.

That answer is `{ keys, statuses }` (`nextSprint`): the same Jira search already returns each ticket's
status name, so `statuses` is a key -> status map, not a second call. It feeds the hold rule:
`heldDoneBots` holds a done **implement** bot past `DONE_TTL_MS` while its ticket's status is not a
done-kind one (`jiraStatusKind` in `ui/jira-status.js` — Deployed, Complete, Closed, ...), and the bar
passes that set to `liveBots` and `nextBotChange` so a held bot neither fades nor schedules a fade.
Only implement holds; a done review, groom or e2e bot keeps the time to live. A status Jira did not
report, an unrecognised one, or an `available: false` answer falls back to the time to live, never to
"hold forever".

Motion and zones: working patrols, waiting (idle) wanders, done strolls (cycle factors
`IDLE_CYCLE_FACTOR` and `STROLL_CYCLE_FACTOR` in `ui/bot-bar.js`), failed stands. Each state is confined to
its own zone, from the `ZONES` table (`ZONE_OF_STATE`; `DONE_ZONE_SHARE` and `DONE_ZONE_MIN_PX` name the
done zone's): done on the left 20%, working and waiting in the centre 60%, failed on the right 20%, the
left and right at least 200px, the centre the remainder, the bar's ends keeping their edge margin. The
CSS (`--bot-zl`, `--bot-zr`, `--bot-zs`, `--bot-zroom`, per `data-state`) and `walkStretch` /
`zoneBounds` do the same math; change both together. A state change is a jump, never a slide
(transitions are capped at 200ms), with lane and phase from the new zone's range. A crowded zone
overlaps, never widens or shrinks bots, and the hovered or focused bot is raised so its dismiss button
is reachable. Under 600px (`ZONES_MIN_WIDTH_PX`; the CSS media query and `useNarrow` agree) the zones
collapse to the whole width with a 40px margin. No zone is drawn. Reduced motion stands everyone still
at a spread-out place inside their own zone. Hover detail is the app's own `DashboardTooltip`
(keyboard focus works), never a native `title`, `data-tooltip` or SVG `<title>`. A state change between
polls raises a callout bubble (`CALLOUT_TEXT`, detection in the pure `stateChanges`, state in
`useBotCallouts`; never on first load; at most three; the bubble sits outside the mirrored face and only
fades under reduced motion) plus one polite live-region message per change.

The mascot is deterministic per session (rendezvous hashing of the session key
over the registry ids), so a session keeps it for life; the mascot list lives only in
`ui-react/components/mascots/index.js` (see `ui-react/components/mascots/README.md`, "Adding a
mascot"), so do not hard-code a mascot count or order. The bar polls `GET /api/claude/tickets`
itself on every screen (its own `useClaudeTickets({ active: true, source: 'bot-bar' })`, 15 s,
paused while the page is hidden, requests marked `?surface=bot-bar`): specs that count a board's own
Claude reads must exclude that marker.

Every bot carries a poster (`BotPoster.jsx`) with its ticket key above its head: picked per session by
`pickPoster` in `ui/bot-bar.js` (rendezvous hashing with its own salt, independent of the mascot), from the
registry that lives only in `ui-react/components/posters/index.js` (see
`ui-react/components/posters/README.md`, "Adding a poster"; never hard-code a poster id or count). A
poster is decorative: `aria-hidden`, no `<title>`, `<desc>` or native `title`, `pointer-events: none` (the
bot stays the only target). It is a sibling of `.bot-bar-face` inside the lane, never inside the
mirrored face, so it is never mirrored; it sways only while the bot walks (`walks(state)`) and only
under `prefers-reduced-motion: no-preference`. The callout and the hover popup (`POSTER_RISE_PX`) stand
above it; `--bot-poster-*` in `bot-bar.css` and `POSTER_RISE_PX` change together.

Its styles are in `ui-react/styles/bot-bar.css` (tokens only,
`bot-bar-*` names, transform-only keyframes, a reduced-motion block). It never calls
`/api/team-velocity`, so the Home velocity rule above is unaffected.

## DevTools: a wall of live tiles

DevTools is a `.board-pane` holding `.devtools-wall`, a real grid
(`grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`), not masonry: tiles are uniform
(16:10 picture under a one-line header), so rows leave no dead space. Every tile shows its browser
live on ONE shared `EventSource` (`/api/devtools/stream`; subscribe by POST, `ui/devtools-stream.js`),
never one stream per tile: a browser allows ~6 per host and the dashboard holds one already. A tile
is view-only at `tile` quality (small, slow); the viewer it opens raises that browser to `full` while
open. A tile pauses (unsubscribes, last frame kept, "Paused") when scrolled out of the pane, when the
page is hidden or when the screen is not shown. Frames paint straight into the `<img>`; tiles are
memoized so the panel's once-a-second countdown repaints nothing.

**Launch mode.** A browser launches headless (`--headless=new`, in `backend/browser-devtools.mjs`) by
default: a visible window kept stealing the user's desktop focus while agents drove it, so the user
signs in through the viewer's Take control. `POST /api/devtools/browsers` takes an optional boolean
`headed`; `true` launches without `--headless*`, a non-boolean is 400 `INVALID_HEADED` (the route
passes it through uncoerced, `launch` validates, and the code is in the route's allow-list). The mode
is stored on the instance record as `headed: true` only when true, so `start` after `stop` keeps it
and a record without the field relaunches headless; the UI sends `headed` only when exactly `true`.
Both launch places (the DevTools tab form and the E2E dialog's step 1) share `ShowWindowToggle.jsx`,
a "Show browser window" checkbox, unchecked by default. Do not describe a DevTools browser as a real
or visible window anywhere except when `headed` is set.

## UI layout: the shared board (My Tickets, Slack, Pull Requests)

Services also uses `BoardPanel` / `BoardSection`, with a scrolling `.board-pane`
containing its explicit service grid rather than board columns. Keep service
identity, status and controls compact above the stable log viewport; the reserved
feedback footer sits outside the log so polling and feedback do not shift it.
Service-specific layout stays in `services.css`, not the shared board stylesheet.

My Tickets, Slack and Pull Requests share one screen shape with different data, built from one set of
primitives — `ui-react/components/BoardShell.jsx` and `ui-react/styles/board.css` — not screen-specific copies.
Toolbar, notes, states, board frame, columns and card shell are changed there and all three screens get
the change. The panel sheets (`my-tickets.css`, `slack.css`, `prs.css`) hold only what is specific to their own
domain: Jira card state, PR lines and chips, the Slack thread dialog and watcher. Generic classes
are `board-*`, never prefixed with a screen's name; a rule that would read the same on a second
screen belongs in `board.css`.

**The primitives** (`BoardShell.jsx`; test ids come from the `name`/`testId` props and are a
contract, so a refactor never renames them):

- `BoardPanel` — the `<section class="panel board-panel">`. Using it is what opts a screen into the
  viewport-fill rule below.
- `BoardSection` — one `Card.board-section`: `.board-toolbar` (title, a `sub` line, `meta` status
  text, `controls`, then the `filters` row and the `notes` slot) over `.board-body`. With
  `activeTab` the body is the panel of a `BoardTabs` row (below).
- `RefreshControl` (Refresh button and `refresh in N s` countdown) takes the `load` that
  `useActivePolling` returns, so a click restarts the countdown and goes through the hook's
  in-flight guard; all three board screens do this. Pull Requests intentionally adopted the shared
  `.board-next` countdown; retained legacy PR styles do not govern the PR board.
- `BoardTabs` is a segmented switch between views of one board (Slack's Started, Mentions and Watch
  threads). My Tickets has no `BoardTabs`: its filter row is `WorkFilters`. It is a real tab set:
  give it the same `name` as its `BoardSection` and pass the selected tab there as `activeTab`, and
  every tab gets an id and `aria-controls` pointing at the section's body, which becomes the one
  `role="tabpanel"` labelled by the selected tab (the views swap inside that one body, and the
  board's `role="region"` keeps its own name). Only the selected tab is a Tab stop; ArrowLeft,
  ArrowRight, Home and End move focus and select. A tab may carry `count`, and `tone: 'warn'` with a
  `hint` (spoken and shown on hover, so the tone is never colour alone).
- `BoardNote` (amber toolbar note) and `BoardState` (loading, empty, error or warning body).
- `Board` and `BoardColumn` — `.board-frame` > `.board-track` and its columns. `Board` owns scroll
  preservation (`usePreservedInteraction`), so a screen never wires it again. Optional `BoardColumn.hint`
  gives a heading existing `DashboardTooltip` help on hover/keyboard focus; only hinted headings gain
  a Tab stop. Pull Requests supplies lane meanings; My Tickets/Slack keep their no-hint defaults.
- `.board-card` (`.board-card-action` for a card that is a button), `.board-card-top`,
  `.board-card-summary`, `.board-card-stat` and `.board-chip` — the card shell and status chip. A
  domain card adds its own class beside them (`board-card my-tickets-card`).

**Shared by the two screens that open Slack threads** (My Tickets chips, the Slack board), each
once, with the differences passed in rather than forked:

- `ui-react/hooks/useSlackThreadDialog.jsx` — the activity clock, the rule that a thread past the
  cutoff closes its dialog, the `slack-session-changed` listener, the dialog's session-mismatch
  handler and the `<SlackThreadDialog>` element. The panel keeps `openThread` (its own session code
  closes it too) and passes its `source` name, snapshot, session-identity ref, `resetSession` /
  `reloadSession` (how each forgets and refetches its data), and for Slack `resolveOpener`, for My
  Tickets `onExpire`. It returns `{ now, dialog }`; render `{dialog}` inside the panel, beside the card.
- `slackCoverage(snapshot)` in `ui/slack-coverage.js` — the two reason-specific warnings and
  `incomplete` (partial, truncated or either warning). Each panel adds its own causes (Slack:
  replies still being checked, a stale update, threads it cannot place; My Tickets: a continuation)
  and words its own note.
- `readScroll` / `writeScroll` in `hooks/usePreservedInteraction.js` — the one way a scroll place
  is read and put back by `data-testid`; `Board` (per re-render) and `useSectionScroll` (per view)
  both use it.

**Adopting it in a new screen:** render `BoardPanel` > `BoardSection` and fill the slots; make the
body either one `BoardState` or a `Board` of `BoardColumn`s (or a `.board-pane` for a view that is
not a board, which fills and scrolls the same way); style cards with `.board-card` and keep only
domain rules in the screen's own sheet. Import `board.css` before the panel sheets in
`ui-react/styles.css` so they can override it. The polling hook re-renders the panel once a second,
so memoize the board element as `MyTicketsPanel` does. Never copy a board rule into a panel sheet.
`board.css` is held to the stylesheet contract in `test/ui-react-contract.test.mjs` (tokens only,
no hex, short transitions that never say `all`, a `prefers-reduced-motion` block, no `columns:`).

**The viewport-fill rule.** A board screen is exactly one viewport tall: only the columns (or the
pane) scroll, never the page, and it is done by layout, not by a fixed offset or any JS. While a
`.board-panel` is visible `#root` is a `100dvh` flex column (`#root:has(.board-panel:not([hidden]))`),
`.panels` and the panel are flex shares, and the card grows only when it holds a board or a visible
`.board-pane`. The board is `flex: 1 1 0` with a 320px floor and `contain: size`, so its column count
never sets its height. A card holding only a state message (loading, empty, disconnected) keeps its
natural height. So a new board screen needs `BoardPanel` and nothing else: no height of its own, no
change to `App.jsx` or `AppShell.jsx`. One trap: `.board-pane[hidden]` and `.board-sub[hidden]` need
their explicit `display: none` rules, because a `display: flex` rule on the same element defeats the
`hidden` attribute.

## E2E ticket check: facts not to break

The Claude dialog's E2E row (`E2eCheckDialog.jsx`, phase `e2e-ticket-check`, bot phase `e2e`) launches
a new DevTools browser, lets the user sign in, then starts an unattended session. It is a side action
like groom and review; the contracts the backend and UI hold:

- **Record.** The side-action record lives in `launch.json` under `e2e-ticket-check`
  (`{ name, launchedAt, id, browserId }`, plus `browserStoppedAt` or `browserStopFailed`). The
  INVESTIGATE branch of `launchLocked` keeps it through its `kept` list; a side key not named there is
  deleted by the next investigate launch. `entry.e2e` is always present, `blocks.e2e` and `goTo.e2e`
  only for a ticket with the record.
- **Prompt and launch.** The prompt is server-owned (`e2ePrompt(key, port)`), minimal, and interpolates
  only the validated key (with its slug and the `agent-browser --session e2e-<key lower case>` name) and the port, an integer in 9300-9399 read from the DevTools
  registry by `browserId` (`b-` plus 8 hex digits, else 400 `INVALID_TICKET`); never client text, a port
  or a URL from the client. The launch passes only the working directory: no tool limits, no
  `--add-dir`, no MCP override. Refusals: `browser_not_found` / `browser_not_running` (409
  `CLAUDE_REFUSED`), an unavailable listing 502 `CLAUDE_FAILED` like every phase, `timed_out` 502
  `CLAUDE_FAILED` with the record kept. The launcher gets `browsers` as `{ list, stop }` only, so a
  profile is never deleted from here.
- **Once-only auto-stop.** The browser is stopped when the finished session is first seen, which only
  `list()` (`GET /api/claude/tickets`) can see, under the ticket lock with a re-read, and either marker
  ends the attempts. A stop failure is logged, never fails the list.
- **Dialog.** Step 1 launches headless unless "Show browser window" is ticked (`headed: true`); the
  step-2 hint reads `browser.headed` from the launch response: the default points to the live view
  (Take control) and never mentions a window, the headed one names the window as a second way to sign
  in. The live viewer is a modal over the dialog, so Start is unreachable while it is open
  (no separate unmount code). Closing at step 2 before Start stops the browser; while Start runs, close
  does nothing and unmount stops nothing; after `timed_out` no close path stops it (the backend's
  auto-stop owns it). No `EventSource` in the component.
