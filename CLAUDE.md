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
  finishing (it is `eslint . --max-warnings 0`, so a warning fails it). `npm run check` is the
  aggregate: lint, `format:check`, then `npm test`; CI (`.github/workflows/ci.yml`) runs the same.
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
session of any kind (investigate, implement, review, groom or e2e check, or a standalone Chat, the one
kind that is not a ticket's; see below). It is an overlay: `pointer-events: none` on the strip and `auto` on the
bots, z-index under the tooltip and dialogs, no change to any screen's height or the viewport-fill
rule; keep it that way, and never put a dialog inside the strip (it would inherit the
`pointer-events: none`). Which sessions get a bot is the single `SESSIONS` table in
`ui/bot-bar.js` (every row does; `BOT_PHASES` is derived from it, so a new kind of session is one new row there, never a second list) (`investigate`, `implement`, `review`, `groom`, `e2e`: every session an entry carries, in draw order; an e2e bot reads `entry.e2e` and is keyed `<KEY>:e2e`; every phase but `review` opens `ClaudeDialog`), with the state mapping, the done time to live, the hold rule and the pure helpers; `none` and
`unknown` get no bot. A ticket session's bot also needs its ticket in an active Jira sprint: the pure filter
`inActiveSprint` is applied to the sessions with the keys `useActiveSprintKeys` gets from
`GET /api/active-sprint-tickets` (`fetchActiveSprintKeys` in `backend/jira.mjs`; per-ticket answers
cached 5 minutes server side, asked again by the browser every `SPRINT_POLL_MS`, 5 minutes). A ticket
whose sprint is unknown gets no bot, and on a failed or `available: false` answer the last good key set
stays; do not show a bot for a ticket the sprint filter has not placed.

**Chat bots are the exception to both rules above.** A standalone chat has no ticket, so it is not a row
of `SESSIONS` and has no `entry`: `botsFromChats(chats, now)` in `ui/bot-bar.js` builds its bot from the
`chats` array `GET /api/claude/tickets` carries beside `tickets` (`phase: 'chat'`, key `<uuid>:chat`,
`ticket: 'chat-<first 8 hex>'`, which is its label, poster and test id, plus its own `title`, `session`,
`goTo` and `lastActiveAt`). `BotBar` appends them **after** `inActiveSprint`
(`[...inActiveSprint(sessions, sprint?.keys), ...chatBots]`), so no sprint filter applies and a chat id
never enters `ticketKeys` or a Jira request; keep that order, and never feed a chat bot to
`useActiveSprintKeys`. A chat gets a bot while it works or when it was written to in the last 24 hours
(`CHAT_RECENT_MS`), and then follows the ordinary rules: it fades 10 minutes after it is first seen done
and can be dismissed. It has no callout and no live-region message, because those are derived from the
ticket map (`useBotCallouts(claude.byTicket, ...)`), and `heldDoneBots` holds only an implement bot. A
chat bot opens `#/chat?session=<uuid>` (`openBot`), not a dialog (and has no `aria-haspopup`). A ticket
bot may carry `session` (`withSessions(bots, sessionIds)`, from the tickets reply's sparse
`sessionIds[KEY][phase]`, which also holds recovered orphans, see "Orphaned sessions" in the chat facts),
which only gives its drawer row a live Chat link (none: the placeholder).

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
fades under reduced motion) plus one polite live-region message per change. The bubble text is
`calloutText(ticket, state, verdict)` and the live-region text `announcementText`; a bot may carry an
optional closed-enum `verdict` (done e2e or groom only, see "E2E ticket check" below).

**Needs-you notification (opt-in, off by default).** Pure rules in `ui/needs-you.js`
(`notificationsFor`, `needsYouCount`, `composeTitle`, `readPreference`/`writePreference`, key
`dev-dashboard.needs-you.notify`); browser side in `ui-react/hooks/useNeedsYou.js`. The Sessions
drawer's **Notify me** button (`sessions-notify`, `aria-pressed`) is the only place permission is
requested, from its click. The notifier is fed by `useBotCallouts`'s `onReady` batch (the same
batch that gets bubbles, so the first poll is never news and the sprint filter applies) and
notifies only when the opt-in is on, permission is `granted` and `document.hidden`, only for a
change to `waiting` or `failed` of a ticket session whose ticket matches the key pattern; the body is
`<KEY> · <CALLOUT_TEXT[state]>`, never chat text, a title or a reason. `useClaudeTickets` takes
`whileHidden` (default false; **only `BotBar` passes it**, and only while the opt-in is on and
permission granted; the permission is re-read on `visibilitychange` and `focus`, so a revoked one stops
the hidden poll). The tab title has one composer, `composeTitle` in `ui/needs-you.js`, used by
`useRouteChange` and the count hook. README "Bot bar" has the user-facing rules.

The mascot is deterministic per session (rendezvous hashing of the session key
over the registry ids), so a session keeps it for life; the mascot list lives only in
`ui-react/components/mascots/index.js` (see `ui-react/components/mascots/README.md`, "Adding a
mascot"), so do not hard-code a mascot count or order. The bar polls `GET /api/claude/tickets`
itself on every screen (its own `useClaudeTickets({ active: true, source: 'bot-bar', whileHidden: notify.active })`, 15 s,
paused while the page is hidden **except while the user's "Notify me" opt-in is on and the browser
permission is granted**, requests marked `?surface=bot-bar`): specs that count a board's own
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

**The session list drawer.** `SessionsDrawer.jsx` (mounted by `BotBar`, so on every screen once ready) is
a right-edge tab plus a non-modal fixed drawer listing the same sessions as the bar, from the bar's own
data: `sessionGroups(bots, byTicket, lastActive)` in `ui/bot-bar.js` over the sprint-filtered `bots`, deliberately
NOT the TTL/dismissal-filtered `visible`, so a faded or dismissed session stays reachable. Rows open the
same dialog as a bot and copy the entry's `goTo[phase]` command (review included, when it has one). The third argument is
the same response's `lastActive` map (`{ [ticket]: { [phase]: ISO } }`, `{}` when unknown), which gives
each row its last-activity time. Its only request is the token read: each row shows the tokens its
session used (`sessions-usage-<key>`, `useSessionsUsage`, `GET /api/claude/usage` in batches of 8 for at
most 24 distinct session ids, asked when the drawer opens or its sessions change, never while shut,
never on a timer, never from the bar or the tickets poll). It
mounts rows only while open (so tests counting `BOT-n` buttons are unaffected; row button names are
`Open <KEY> <phase> session`, never the bot's `<KEY> <phase>: <state>`; a chat row's name is its title:
`Open <title> Chat session`; a row's phase is an icon, coloured per phase from the one `PHASES` table in `ui/session-phases.js` (words, `NavIcon` name, `--phase-*` token in `tokens.css`; a new or restyled phase is a row there, never a second list) (`sessions-phase-<key>`, `NavIcon`, `aria-hidden`, not a tab stop, the words from `phaseOf` in its app tooltip) in a column of its own right after the state mark and before the key or title, and the detail after the title is just the state and reason, a chat's `working`/`done`; the search still matches the phase words; the header's **New chat** link, `#/chat` as on the Chat screen, is there with or without rows and closes the drawer, focus back on the tab), and its styles live in
`ui-react/styles/sessions-drawer.css` because `bot-bar.css` selectors must all start `.bot-bar`. A row's
time is a `.sessions-row-when` span after its button, linked by the button's `aria-describedby` so the
name stays as above, with no live region. `isQuiet` (`QUIET_WORKING_MS`) marks a working row whose time
is five minutes old, and the open drawer re-reads the clock (`ACTIVITY_CLOCK_MS`) only while it is open.
Chat rows are in the same groups, appended after the sprint filter like their bots (so they are the
24-hour chats, not every chat on disk). `sessionGroups` prefers a bot's own `goTo` and `lastActiveAt` when
it has the key (a chat's `goTo` is null while it works), and looks the rest up under the ticket as before.
Every row always has both icon slots, **Chat** and copy (a chat row's Chat link is the chat itself, name
`Chat with <title> Chat session`, the same form as a ticket row's `Chat with <KEY> <phase> session`). Each is live when its action exists (a `session`, a `goTo`) and otherwise a dimmed
`aria-disabled` placeholder (`SlotOff`, a focusable `span role="button"` that does nothing, test ids
`sessions-chat-off-<key>` / `sessions-copy-off-<key>`) whose tooltip and name say why (`No session to chat with`;
`Working: no resume command yet` for a working chat, else `No resume command available`).
The live Chat link is `#/chat?session=<uuid>`, name `Chat with <KEY> <phase> session`, shown as the Chat tab's icon with "Chat" in the app tooltip (no visible text), as is the row's copy button (name unchanged, tooltip `Copy attach` / `Copy resume`; the outcome, `Copied` or `Copy failed`, shows in the tooltip, the glyph and the button's name, as the chat's copy buttons do); the time, Chat and copy columns have fixed places so rows line up; the link and a chat row or bot close
the drawer, because it is non-modal and would cover the conversation it just opened. Readers of
`GET /api/claude/tickets` re-read at once on a `claude-tickets-changed` window event
(`notifyClaudeTicketsChanged` in `useClaudeTickets.js`, fired by the Chat screen after a send and when a
chat's phase changes), so the bar, the drawer and the chat list follow a turn without waiting for the 15 s poll.

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
- `RefreshControl` (Refresh button and `refresh in N s` countdown) takes the `load` and the
  `countdown` that `useActivePolling` returns, so a click restarts the countdown and goes through the
  hook's in-flight guard. `countdown` is a descriptor `{ lastLoadedAt, interval, loaded, active }`, not
  text: `RefreshControl` renders `BoardCountdown` (private to `BoardShell.jsx`), the only 1 s clock a
  board has, so only its span re-renders per second, never the panel; it ticks only while its screen is
  `active` and the page is visible, and holds `refresh paused (Ns)` while hidden. Pass `countdown`
  straight through, never read it as a string. All four board screens (My Tickets, Slack, Pull
  Requests, DevTools) do this. `RefreshControl` also registers its guarded `onRefresh` under its
  `name` (`ui-react/lib/board-refresh.js`) for the command palette; Home has no entry (its velocity
  stays explicit). Pull Requests intentionally adopted the shared `.board-next` countdown; retained
  legacy PR styles do not govern the PR board.
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

## Services: checkout picker, facts not to break

Each service card's checkout select runs a repo's services from a git worktree (`backend/checkouts.mjs`,
`ServiceCheckoutPicker.jsx`; README "Worktree picker" has the contract).

- **The repo is the unit, not the service.** Services sharing a `def.dir` (`be` and `queue`) switch
  together in `Manager.switchCheckoutUnlocked`, which runs inside `withSettingsLock` along with the
  worktree listing and validation (the PUT route holds one lock callback), so a Settings save or another
  switch cannot interleave. `setCheckout` in `ui-react/lib/api.js` marks every member pending
  (`withPending`) and `ServicesPanel`'s `repoOf` disables every member's select. Never add a per-service
  switch path.
- **The override lives in `checkouts.json`, never in Settings.** `editable()` in `settings.mjs` drops
  unknown service fields, and a Settings save must not clear a pick. It is keyed by the absolute main
  checkout. `Manager.buildService` is the one place a `ServiceProcess` reads it, so any new place that
  builds one goes through it. `checkSettings` compares against `mainCheckout()`, never `cwd()`.
- **A field the card needs must be in `ServiceProcess.snapshot()`.** SSE replaces the whole service
  object, so `checkout` and `checkoutLabel` come from the snapshot, never from a fetched copy or panel
  state.
- **A native `<select>` and `<dialog>`, not the MUI Listbox.** `.service-card` is
  `overflow: hidden` and clips popups. The Actions menu (`ServiceActionsMenu.jsx`) is the one
  exception: MUI Menu renders in a portal, so the card cannot clip it. The select disables during a
  switch and takes focus back after.
- **The card header is two rows, never three.** Row 1 is name, shrinking directory/port and the status
  chip; row 2 is the checkout select and the Actions button. Nothing wraps: it truncates. The status
  dot is the chip's `currentColor` (green running, red `data-exit="error"`, else grey).
- **The worktree list is never polled.** It is read when the panel loads its services, when a select
  gains focus and on a click of the Claude dialog's **Use in Services**
  (`GET /api/repos/checkout-matches`, one listing per repo in parallel, click time only); the PUT lists
  again and accepts only an exact listed path. Do not add a timer or accept a path the listing did not
  return. `switchCheckoutUnlocked` has exactly two call sites in `backend` (its definition and the PUT
  route): Use in Services switches only through that PUT, with `restart: false` unless the user
  confirms, and starts no service.
- **A running service is never swapped without `restart: true`** (409 `CHECKOUT_IN_USE`), and the
  `.nvmrc` preflight runs before anything stops.

## E2E ticket check: facts not to break

The Claude dialog's E2E row (`E2eCheckDialog.jsx`, phase `e2e-ticket-check`, bot phase `e2e`) launches
a new DevTools browser, lets the user sign in, then starts an unattended session. It is a side action
like groom and review; the contracts the backend and UI hold:

- **Record.** The side-action record lives in `launch.json` under `e2e-ticket-check`
  (`{ name, launchedAt, id, browserId }`, plus `browserStoppedAt` or `browserStopFailed`). The
  INVESTIGATE branch of `launchLocked` keeps it through its `kept` list; a side key not named there is
  deleted by the next investigate launch. `entry.e2e` is always present, `blocks.e2e` and `goTo.e2e`
  only for a ticket with the record.
- **Prompt and launch.** The server rereads `prompts/e2e.md` on each launch: a missing file uses
  the unchanged built-in E2E template; an unusable file refuses launch. It substitutes only
  `{KEY}` (the validated ticket key), `{SLUG}` (that key in lower case) and `{PORT}`; the built-in
  uses `agent-browser --session e2e-<key lower case>`.
  The port is an integer in 9300-9399 read from the DevTools
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
- **Verdict.** `ticketEntry` in the launcher adds `verdict` to `entry.e2e` / `entry.groom` only while
  that side is `done`, from `createClaudeArtifacts.verdict(key, name)` (the `VERDICT_FILES` table in
  `backend/claude-artifacts.mjs`: `e2e.md` `Verdict:` PASS|FAIL|PARTIAL|BLOCKED, `groom.md` `Readiness:`
  READY|NEEDS_INFO|BLOCKED). `verdict()` is a bounded artifact reader: first 512 bytes only, opened
  with `O_NOFOLLOW`, regular file only, the ticket-folder link checks of `read`, cached by mtime and
  size, never throws, never logs, and the text after `BLOCKED:` is never read. It is advisory and
  never a gate (`claude-groom-warning` is a note; Investigate stays enabled). `deriveEntry` stays pure.
  The UI words and tones live only in `ui/claude-verdict.js` (a test pins that its keys equal the
  backend enums).
- **Continue writes no state.** `POST /api/claude/continue` goes through `deliverToSession`, so the
  one-writer mark applies, and writes neither `status.json` nor `launch.json`, before or after; the
  status.json single-writer rule holds by construction. `blocks.continue` exists only on a `failed`
  entry. README "Continue a failed session" has the refusals.

## Chat: facts not to break

The Chat tab (`ui-react/panels/ChatPanel.jsx`) talks to a real Claude Code session: the server runs
`claude -p` and streams normalized events to the browser. A chat is addressed by one value, the session
UUID (`#/chat?session=<uuid>`): a **standalone chat** (a record in `claude/chat/<uuid>.json`, no ticket,
cwd always `~/pathwise`) or any session `claude agents --json --all` lists, which includes every ticket
session. The CLI does not list a `-p` run, which is why the dashboard keeps its own record for standalone
chats. The contract is README "Chat" (routes, errors, events, items); its two ends are
`backend/claude-chat-items.mjs` (CLI line to event, transcript to items) and `ui/chat-stream.js` (the
client reducer).

- **One writer per session, and its refusals.** `claudeSessions.beginTurn(sessionId)` in
  `backend/claude-sessions.mjs` is the only writer mark; the chat turn and `resume()` (so the launcher's
  answers, approve, re-review and Continue, and the Slack watcher) go through it, never through a second lock. A held session reads `state: "working"` in
  `entries()`, so the launcher's guards, the ticket card and the bot bar see a turn as work in progress.
  The refusals are 409 `CLAUDE_REFUSED` with `errors[0]` `chat_busy` (a turn is already in flight on this
  session), `session_running` (a listed session is working outside the chat, or the mark is held),
  `session_not_found`, `too_many_turns` (4 in flight) and `no_turn` (stop with none), and 502
  `CLAUDE_FAILED` `listing_unavailable`, `live_at_resume` and `spawn_failed`. A working listed session is
  never touched: no stop, no spawn, no second copy. An idle one is stopped and polled until it has no pid
  (`settleSession`, shared with `deliverToSession`) and only then continued with `--resume`, so the turn
  continues it instead of forking. The mark is taken **after** that stop-poll, not before the listing read:
  a held session reads `working`, so holding it across the chat's own reads would make every idle session
  look like work elsewhere. The stop-poll itself is therefore unguarded, as it is for the launcher. The mark
  is per dashboard process: a terminal that resumes the same session is not seen.
- **Argument arrays, no shell, scrubbed env, on every child.** The turn is
  `spawn('claude', [...], { cwd, env: withoutSecrets(process.env), stdio: pipes })` with no `shell` option.
  The arguments are the fixed `TURN_ARGS` plus `--resume <uuid>` or `--session-id <uuid>`; the message is a
  stdin line, never an argument (it would show in `ps`), and no permission, model, tool or MCP flag is
  passed. `withoutSecrets` in `backend/config.mjs` is the one place the credential names
  (`SECRET_ENV_NAMES`) are removed, and every place that starts a process uses it: `launch()`, `resume()`,
  the manager's Node runtime and the chat. A new child gets it too. The cwd comes from the record or the
  listing, never from a request; a listed entry with no usable cwd is `spawn_failed` rather than a run in
  the dashboard's own directory.
- **Nothing said is ever logged.** A failure is one `[claude]` line through `logClaudeFailure` with the
  step, reason, exit code and the 8-character session prefix: no message, title, CLI output, event or
  stderr (the child's stderr is drained and discarded). Do not add a `console.*` or a log field that
  carries text to the chat modules.
- **The transcript path is derived, not accepted.** History is read from the CLI's own transcript, found
  by `claudeSessions.transcriptFile(sessionId)` (stat only, by exact file name under the projects
  directory), and only after `isSessionId` has passed in the chat module itself (`requireSession`, run
  first in `send`, `stop` and `open`, so a path is never built from a bad id even by a direct call; the
  routes only parse the body). The client never sends a path, cwd, name or flag. Only the last 4 MiB are
  read and at most 300 items returned; either cut sets `truncated`.
- **Stop escalates.** `stop()` sends SIGINT; a process still alive 5 s later gets SIGTERM, and 5 s after
  that SIGKILL (`STOP_GRACE_MS`), so a process that ignores both cannot hold the session for good. A turn
  ends on the process `close`, not on `result`, and the stop timers are cleared on that end. SIGINT leaves
  the session resumable, and a turn stopped by the user ends `stopped` whether or not the CLI printed a
  `result`. `handler.close()` sends SIGTERM to every turn's child and ends every stream.
- **History first, then the stream, in one `hello`.** `GET /api/claude/chat/stream?session=<uuid>` is an
  explicit branch in `http-app.mjs` (a table route is always a JSON reply). It writes `hello` first, with
  the whole chat (`items`, `state`, `live`, `truncated`, `turn`), then `item` (upsert by id), `delta` and
  `state`. While a turn runs, history is read only up to the transcript's size when the turn started and
  the turn's own items come from its live buffer (at most 500), so nothing is listed twice; `open()` reads
  again if a turn starts or ends while it waits. On the client `chatReducer` makes `hello` **replace** the
  view (that is also how a reconnect and Refresh heal), ignores every event before it, and keeps a
  cut-short reply as an assistant item (`partial-<n>`) when the turn goes idle. `delta` is dropped for a
  client that has not drained; `item` and `state` are always written. `state: "working"` with
  `live: false` is a session working outside the chat: read-only, never stoppable. A refused stream is a
  JSON error, because the headers go out with the first event. The stream answers a cross-site
  `Sec-Fetch-Site` with 403 `INVALID_ORIGIN` directly (deliberate: the code is not in the error allow-list
  and every other route answers `OPERATION_FAILED` for it, which existing tests pin); 8 streams at most,
  then 429 `TOO_MANY_STREAMS`.
- **`ChatConversation` is keyed by session.** `<ChatConversation key={session ?? 'new'} />` remounts it on
  every switch and on New chat, so the transcript, draft, Retry, status line and stream of one chat can
  never show in another. Do not replace the key with an effect that resets pieces of state. The stream is
  one `EventSource`, open only while the Chat screen is active and shows a session (`useChatSession`), and
  deltas are batched per animation frame.
- **The composer is `readOnly` plus `aria-disabled`, never `disabled`, while a turn works.** A natively
  disabled textarea drops the writer's focus, and the reason (`chat-disabled-reason`, tied by
  `aria-describedby`) is always shown in words. Send is disabled with it. Stop shows only while `live`; a
  session running outside the chat has no Stop and gets Refresh instead. A refused send or stop is worded
  from `errors[0]` (`REFUSAL_WORDS`), never the raw envelope. The controls (Send, Stop, Retry, Refresh) float
  over the textarea's top right corner (`.chat-field` > `.chat-actions`, after the textarea in tab order);
  text and placeholder start at the top left and the room for the controls is reserved on the right, never
  as a row at the top (`data-controls` 1-3 is how many show; `--chat-actions-*` in `chat.css`; three wrap
  into two rows under 760px). The bottom edge of the screen is under the bot bar, so nothing actionable goes
  there. The reason and send errors sit above the field for the same reason.
- **Orphaned sessions are recovered, never guessed.** `launch.json` keeps only the 8-hex short id; when
  `claude agents --json --all` no longer lists a recorded session (`claude rm`, pruned) the conversation is
  still on disk. `recoverSessionIds` (`claude-sessions.mjs`, the same `scanTranscripts` helper as `lastActive`, a separate pass)
  maps a short id to the full id: regular `<uuid>.jsonl` files only (the uuid directories beside them do not
  count) and exactly one distinct id behind the prefix, else nothing. The launcher asks (`recoverOrphans`,
  from `list()` only, and only with a usable listing, so a failed listing never makes every session an
  orphan; every answer, found or not, is kept for `ORPHAN_RETRY_MS`, 5 minutes on the injectable clock, then
  asked again, so a hit whose transcript is gone is dropped) and `phaseSessions` turns a record the listing
  lacks into a synthetic finished entry, which fills `sessionIds`, `goTo` and `lastActive`: the card state is
  derived as before, from the flag files and the listing, never from the transcript (flag set: `done`; none:
  `failed` / `session_missing`), and the listing always wins. The one exception is the one-writer mark:
  while a chat turn holds the session (`claudeSessions.isHeld`) the synthetic entry is `working`, so the card
  reads working and `goTo` is null, as for a held listed session. The chat resolves an unlisted
  id (`orphanSession`) only when a launch record names its short id (`launchedName`) AND the prefix recovers
  to exactly that id; it then skips the working check and the stop-poll (an orphan has no pid, so nothing
  but a dashboard turn makes it busy), runs from `~/pathwise` (the CLI finds a session by id, not directory) and resumes with
  `--resume <id>`. Any other unlisted id stays `session_not_found`; do not widen that to any transcript on
  disk. Its Copy is the resume string, and `goTo.review` exists like `goTo.e2e` (only for a ticket with a
  review record), so a review row gets Copy.
- **Chat bots and rows are appended after the sprint filter.** See the bot bar section above: a chat's id
  must never reach `useActiveSprintKeys` or Jira, and no new chat code path may read it as a ticket key. A
  chat is `chat-<8 hex>` in labels, never a made-up key.
- **One place registers the tab, one place holds the routes.** `READY_TABS` in `ui-react/App.jsx` (Chat
  follows Pull Requests; `hashFor` keeps the `?session=` query for `chat`, as it keeps Releases' `?view=`)
  and the three literal paths in `ui-react/lib/api.js` (`sendChat`, `stopChat`, `openChatStream`), which
  the contract test reads. The primary route row is pinned by a test, so a new tab goes in the tools row.
  `ui-react/styles/chat.css` follows the board stylesheet rules (every selector starts `.chat`, tokens only,
  no hex, short named transitions, a reduced-motion block, no `columns:`) and is imported after `board.css`.
- **Usage is read on request, never on the poll.** `GET /api/claude/usage` (`createUsageReader` in
  `backend/claude-usage.mjs`, paths from `claudeSessions.transcriptFiles`) is the only place
  transcript content is read for tokens: byte-offset incremental, deduped by message id, 8 MiB per
  request, 256 files cached, numbers and model ids only, nothing logged, tokens only (no dollars, no
  price table). It is never called from `GET /api/claude/tickets`, the bot bar or the tickets poll; a
  screen asks once when it opens (`useClaudeUsage`, `useSessionsUsage`) and the Chat head again only
  when a turn ends. README "Claude usage" has the contract.
- **Known limits, so nobody "fixes" them by accident.** (a) `npm run dev` restarts through nodemon's
  SIGUSR2, which `server.mjs` does not handle, so its SIGTERM cleanup does not run and a `claude` child
  mid-turn can outlive a dev restart. Production `npm start` handles SIGTERM. This was deliberately left
  alone: switching nodemon to SIGTERM would also stop every managed service on each dev restart. (b) Chat
  turns pass no permission flag, so a tool that needs approval is denied (listed in the turn's `denials`
  and shown as a note); there is no in-app approve or deny. (c) `costUsd` on a turn is the CLI's
  `total_cost_usd`, cumulative for a resumed session, not per turn; the Chat head shows it as "Session
  cost so far" only while idle (`costLabel` in `ui/chat-stream.js`). That the total is cumulative on the
  real CLI is not verified. (d)
  Resuming a finished `--bg` ticket session and `session_running` on a working one were checked on the
  real CLI with scratch sessions; sessions started with the launcher's extra flags (`--add-dir`,
  `--tools`, `--strict-mcp-config`) and the ticket row's Chat link in a real browser were not.

## Lazy screens and the first-paint bundle

Chat, Releases, DevTools and Mascots load their code on first visit; Home, My Tickets, Slack, Pull
Requests, Services, Settings (the only screen in setup-only mode) and the bot bar are eager. The ticket
Claude dialog, the command palette and the shortcuts help are lazy overlays too
(`ui-react/lib/lazy-overlays.js`, a `[load, Overlay]` pair each), and `ArtifactViewer` and
`E2eCheckDialog` are lazy inside `ClaudeDialog` through `LazyDialog`. README "UI layout" has the numbers.

- `App.jsx` mounts each lazy screen through `ScreenSlot` with `lazyScreen(() => import(...), 'X')`
  (`ui-react/lib/lazy-screen.js`) memoized at the call site. A screen mounts on the render it is first
  active or when the boot route names it, and stays mounted, hidden, afterwards. Never gate a lazy
  screen on anything but the slot's own first-visit state.
- The loading fallback is `panel-<id>-loading` (never `panel-<id>`), with the screen's own shape: a
  `BoardPanel` by default (viewport-fill from the first paint), a plain `.panel` through
  `<ScreenSlot board={false}>` for a non-board screen (Releases). A new lazy screen sets `board` to match
  its root. A failed chunk shows `screen-error-<id>` with Reload via `ChunkBoundary`.
- An opener of a lazy overlay calls `load()` first and opens when it settles (the Control+K / `?`
  listener, `openBot`, `openClaude`), so the first press is never lost and React's 300 ms fallback
  throttle never shows. The review row of a bot still opens the eager `ClaudePlaceholderDialog`.
- `test/bundle-budget.test.mjs` builds in memory (never `dist/`) and holds initial JS to 640 KiB raw and
  200 KiB gzip -9; a new eager import of a lazy module fails it. `vite.config.js` is pinned by
  `ui-build-contract.test.mjs`.
- **Service feed.** `useServiceEvents` stores `keepIfEqual(previous, next)` (`ui/keep-if-equal.js`, shared
  with `useClaudeTickets`) on the whole snapshot JSON and must stay so: every output line changes
  `lineCount` and `lastLineAt`, and `ServiceCard` refreshes its log whenever the snapshot list changes
  identity, so a projection (status only, say) freezes live logs. Every screen in `App.jsx` is `memo`,
  `AppTabs` and `BotBar` are memoized in `AppShell.jsx`, and `services` goes to `ServicesPanel` only: a
  new prop that changes on every feed tick, passed to anything else, defeats the memo.

## Keyboard layer: facts not to break

- `ui/shortcuts.js` is the pure resolver (`resolveShortcut`, `isBlocked`, `isEditableTarget`,
  `SHORTCUT_TABS`); `useGlobalShortcuts` (one document keydown, bound once, in `AppShell`) only feeds it.
  Guards live in `isBlocked` (`dialog[open]`, `defaultPrevented`, a target inside `[data-control="true"]`,
  `[role="menu"]` or `[role="listbox"]`). The hook prevents Ctrl/Cmd+K in every state, after computing
  `blocked`. New dialogs need no registration.
- The palette is a native modal `<dialog>` rendered by `BotBar` (beside the strip, never inside it) from
  `ShortcutsContext`, so BotBar takes no props (a bot-bar test pins that). Palette and help use
  `useModalDialog` and `useBackdropClose`; entries and filter are in `ui/command-palette.js`.
  `command-palette.css` is `.command-palette*` only, tokens only, with a reduced-motion block, pinned by
  `test/command-palette-contract.test.mjs`.
- **Hash contract.** `hashFor` and `QUERY_ROUTES` in `App.jsx` (releases, chat, my-tickets): `my-tickets`
  keeps its query only when `ticketFromQuery` (`ui/ticket-link.js`) accepts it. `App` holds
  `ticketRequest` (boot and hashchange, My Tickets route only); `MyTicketsPanel` opens the row once data
  is in, says `my-tickets-ticket-missing` only from a current answer (else the neutral
  `my-tickets-ticket-checking`), then calls `onTicketHandled` (replaceState to `#/my-tickets`). Assigned
  tickets only; Include Done is never switched on.
- Route cues (`useRouteChange` in `AppShell`): title, the `route-announcement` region and heading focus
  only when focus was lost (`navigation.spec.js` depends on "only when lost"). None of this adds a request
  or poll; the palette's Refresh runs the board's own guarded load.

## Integration health: facts not to break

- `backend/upstream.mjs` is the one fetch seam for Jira and GitHub (`jira.mjs`, `github.mjs`,
  `github-api.mjs`, `team-velocity.mjs`, `releases.mjs`); a source test forbids a bare `fetch(`.
  `upstreamError(name, res, message)` keeps the caller's message byte-identical. Slack feeds the same
  record from `slack.mjs` and keeps its own `fetchImpl`, timeout and cool-down; the side-branch `.catch`
  on its send promise is deliberate (an extra await tick reorders concurrent Slack reads).
- `GET /api/health` makes no upstream call and sits before the setup gate; never add a call there.
  `useUpstreamHealth` owns no timer (one read on activation and on `refreshKey`), `/api/health` appears
  once in `api.js`, and `UpstreamNote` is mounted in the `notes` slot of My Tickets, Pull Requests and Slack.
- The `[http]` line carries no message on `/api/claude/chat` and `/api/slack/` routes, no query and no
  body; a status below 500, a `SyntaxError` and a cool-down answer log nothing or no message. Any new
  field goes through `scrubMessage` or is a fixed value. `installProcessHandlers` runs from `start()` only.
  Tests that provoke a 5xx print `[http]` lines; pass `integrations.log` a capture function. README
  "Integration health" has the contract.

## Service lifecycle: facts not to break

- `backend/manager.mjs` takes no new imports and `config.mjs` exports nothing new for it:
  `test/manager.test.mjs` copies only `manager.mjs` and `port.mjs` beside a stub config.
- `Manager.stopAll` deliberately bypasses `withSettingsLock` (shutdown is terminal) and sets `closing` on
  every service, so `#start` returns false on entry and after `freePort` and a start in flight at shutdown
  cannot spawn a detached process; `shutdownServer` falls back to per-id `manager.stop` for a manager
  without `stopAll`. `ServiceProcess.restart()` returns false (no second process) when `stopAndWait` fails,
  which `Manager.restartUnlocked` maps to `service did not stop`.
- SIGKILL is only sent while the group leader is alive: a grandchild that outlives a leader that exited on
  SIGTERM is deliberately left (no `kill(-pid)` after the leader is reaped, so no recycled-pid hazard).
- The output throttle is leading+trailing 250 ms, shared by persist and `onUpdate`; the trailing timer is
  unref'd, flushed on exit and `stop`, cancelled by `clearLogs`.
- DevTools registry: module-local `withRegistryLock`; operations inside it call only the `...Unlocked`
  helpers, the `settle` exit callback stays synchronous and lock-free, and `findFreePort` skips ports held
  by `running` records (registry tests use `holdPorts: false` for concurrent launches).
