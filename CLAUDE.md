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

- The My Tickets, Slack, Pull Requests and Sprint boards (`.board-track`, `ui-react/styles/board.css`) are one row of
  fixed-width columns (Jira statuses, Slack time groups, PR review lanes) that scrolls sideways inside itself; they
  are not card lists, so they have no `columns:` container and none of the breakpoints above. Each
  column's card list (`.board-column-body`) scrolls vertically on its own, with the column header
  outside it so the header stays in view. Columns are 280px wide (`.board-column`, under
  `grid-auto-columns: max-content`); at 599px and below they are 82vw
  with `scroll-snap-type: x mandatory`, so the next column peeks in and snaps (`proximity` above
  that). An **empty** column beside a populated one is a 44px rail (`data-empty="true"` from `BoardColumn`: count 0 and
  no children; heading, count and `role="group"` name kept, list `display: none`); a track whose columns
  are all empty keeps full columns, so every rail rule sits under `:has(> .board-column:not([data-empty='true']))`
  (repeated because the sheet uses no CSS nesting). A rail snaps to `end`, not `none`: with `x mandatory` a
  non-snap rail leaves the last lanes unreachable on a phone. How a board fills the viewport, and how a screen adopts it, is under "UI layout: the
  shared board" below.
- `services.css`'s `.grid` (Services tab) sets explicit `grid-template-columns` per breakpoint — a
  real multi-column grid, appropriate because service cards are roughly uniform height, not a
  masonry candidate.
- The Sprint tab's Needs attention list (`.sprint-board-attention`, `sprint-board.css`) is an explicit
  `repeat(auto-fill, minmax(280px, 1fr))` grid: its cards are in priority order, which `columns:` would read down
  the columns, and `BOARD_SHEETS` bans `columns:`. Its Board view is the shared board above.

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
session of any kind (investigate, implement, review, groom, e2e check or review request, or a standalone Chat, the one
kind that is not a ticket's; see below). It is an overlay: `pointer-events: none` on the strip and `auto` on the
bots, z-index under the tooltip and dialogs, and it never scrolls the page. The room it needs is reserved by the
page, not the strip: `--bot-bar-gutter` (`tokens.css`, from `--bot-bar-size` and `--bot-poster-*`, 104px) is the
height of `#root:has(.bot-bar) > .panels::after` in `shell.css`, the last flex item of `.panels`, so a board gives
up that height, the viewport-fill rule below still holds and no bar means no gutter. Keep it that way, and never put
a dialog inside the strip (it would inherit the `pointer-events: none`). Which sessions get a bot is the single `SESSIONS` table in
`ui/bot-bar.js` (every row does; `BOT_PHASES` is derived from it, so a new kind of session is one new row there, never a second list) (`investigate`, `implement`, `review`, `groom`, `e2e`, `reviewRequest`: every session an entry carries, in draw order; an e2e bot reads `entry.e2e` and is keyed `<KEY>:e2e`; every phase but `review` opens `ClaudeDialog`), with the state mapping, the done time to live, the hold rule and the pure helpers; `none` and
`unknown` get no bot. A ticket session's bot also needs its ticket in an active Jira sprint: the pure filter
`inActiveSprint` is applied to the sessions with the keys `useActiveSprintKeys` gets from
`GET /api/active-sprint-tickets` (`fetchActiveSprintKeys` in `backend/jira.mjs`; per-ticket answers
cached 5 minutes server side, asked again by the browser every `SPRINT_POLL_MS`, 5 minutes). A ticket
whose sprint is unknown gets no bot **unless its session is live** (`working` or `waiting`: `isLive` in
`inActiveSprint`, so work on a next-sprint ticket is never hidden; done and failed stay filtered), and on a
failed or `available: false` answer the last good key set stays; do not show a finished bot for a ticket the
sprint filter has not placed.

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
Only implement holds; a done review, groom, e2e or review-request bot keeps the time to live. A status Jira did not
report, an unrecognised one, or an `available: false` answer falls back to the time to live, never to
"hold forever".

Motion and zones: working patrols, waiting (idle) wanders, done strolls (cycle factors
`IDLE_CYCLE_FACTOR` and `STROLL_CYCLE_FACTOR` in `ui/bot-bar.js`), failed stands. Each state is confined to
its own zone, from the `ZONES` table (`ZONE_OF_STATE`; `DONE_ZONE_SHARE` and `DONE_ZONE_MIN_PX` name the
done zone's): done on the left 20%, working and waiting in the centre 60%, failed on the right 20%, the
left and right at least 200px, the centre the remainder, the bar's ends keeping their edge margin. The
CSS (`--bot-zl`, `--bot-zr`, `--bot-zs`, `--bot-zroom`, per `data-state`) and `walkStretch` /
`zoneBounds` do the same math; change both together. A state change is a jump, never a slide
(transitions are capped at 200ms), with lane and phase from the new zone's range. A crowded working or
waiting zone overlaps, never widens or shrinks bots, and the hovered or focused bot is raised so its dismiss
button is reachable. A crowded **done or failed** zone stacks instead: `collapseZones` in `ui/bot-bar.js` keeps
`zoneCapacity` bots (`max(1, floor(zoneRoom / POSTER_WIDTH_PX) + 1)`, `zoneRoom` split out of `walkStretch`;
`POSTER_WIDTH_PX` equals `--bot-poster-w`; under 600px the single zone's capacity is for `all`) and the rest become
one `+N` pill per zone (`OverflowPill`, `bot-bar-more-<done|failed|all>`, `PILL_ZONES` maps its key to a name once)
in the edge margin. The pill is a toggle for the Sessions drawer (`aria-expanded`, `aria-controls` = the drawer's
`useId()` that `BotBar` passes as the required `drawerId` prop), never a second list. Which bots stay: callout
carriers first, then newest seen-done (done) or key order (failed). Collapse runs on `visible`, after TTL, hold
and dismissal, and only `spots`, the layers and the rendered strip read `shown`: `groups`, alerts, the live region,
the Needs-you notifier and callout detection keep the full list. The one exception is callouts held in state: `useBotCallouts`
returns `retain(keys)`, and `BotBar` calls it with the drawn keys so a stacked bot holds no bubble slot (a
hidden bot can never be hovered to end a waiting or failed bubble). Under 600px (`ZONES_MIN_WIDTH_PX`; the CSS media query and `useNarrow` agree) the zones
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
requested, from its click; it shows On / Off / Blocked as a visible `aria-hidden` label
(`sessions-notify-state`, `notifyStateLabel`) while its name stays `Notify me`; its `DashboardTooltip` (`notifyTooltip`, `describeChild`, so the popup describes it and never names it; its id sits in `aria-describedby` beside the blocked note's) explains it per state. The notifier is fed by `useBotCallouts`'s `onReady` batch (the same
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
above it; `--bot-poster-*` in `tokens.css` and `POSTER_RISE_PX` change together (`bot-bar.css` declares none).

Its styles are in `ui-react/styles/bot-bar.css` (tokens only,
`bot-bar-*` names, transform-only keyframes, a reduced-motion block). It never calls
`/api/team-velocity`, so the Home velocity rule above is unaffected.

**The edge drawer frame (Sessions and Slack).** `ui-react/components/EdgeDrawer.jsx` (eager) is the one frame of
both right-edge drawers: a fixed tab plus a non-modal `<aside>`. Classes, test ids and names come from its `name` prop
(`sessions`, `slack-feed`: `${name}-tab`, `-tab-count`, `-drawer`, `-head`, `-head-actions`, `-close`), the shared CSS
hooks are the `data-edge-*` attributes (`edge-drawer.css`), the drawer's content is `children` and is mounted only while
open, and the caller keeps `tabRef` (required) so its own controls can refocus the tab. On open, Close takes focus; Escape
and Close shut it and refocus the tab, unless the event is `defaultPrevented` or a `dialog[open]` exists. The frame has
no tooltip, native `title` or live region. `BotBar` holds `activeDrawer` (`'sessions' | 'slack-feed' | null`, never a
boolean) and `setDrawer(name, open)`: opening sets the name, closing clears it only when that drawer is the open one,
so a late close from one never shuts the other, and `openBot` clears it for a chat. One drawer is open at a time; an
open drawer (520px, full height, z-index 30) covers both tabs, as the Sessions drawer always covered its own, so the
other drawer is reached by closing this one first. The `+N` pill and the Sessions tab go through `setSessionsOpen`, which
loads `SessionsBody` (below) before opening, also when the load fails. Tab slots are `data-edge-tab`: Sessions is
`upper` (bottom edge at the midline) and Slack `lower` (top edge at the midline), each `--s1` off it, so the Sessions
tab is no longer vertically centred; under 600px both are `--edge-tab-length` (128px, `tokens.css`) tall, Slack at the
spot the single tab used to have (above the bot bar), Sessions one tab length and `--s1` above it. A new edge drawer is a
new `EdgeDrawer` caller with its own slot and sheet, never a copy of the frame.

**The session list drawer.** `SessionsDrawer.jsx` (mounted by `BotBar`, so on every screen once ready; it renders
through `EdgeDrawer` and keeps the search, the clock, the usage read and every other piece of state, so the search survives
close and reopen) is
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
`ui-react/styles/sessions-drawer.css` (the lavender role and every row, group and search rule; the frame is `edge-drawer.css`)
because `bot-bar.css` selectors must all start `.bot-bar`. The groups and rows are `SessionsBody.jsx`, a lazy overlay
(`loadSessionsBody`); `SessionsDrawer` hands it rows already dressed (`dressed`: `mark`, `words`, `detail`, `copyWord`,
`meta`) so it imports none of the modules the eager code shares with other lazy chunks (see "Lazy screens"). A row's
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

## Slack activity drawer: facts not to break

The second edge drawer (`SlackDrawer.jsx`, eager: tab, count and frame only; `SlackFeedPanel.jsx`, lazy: the body) lists
what Slack's Activity pane shows. It is read-only and never marks anything read, so the tab's count falls only when the
mentions are read in Slack.

- **Opening and the body.** The tab calls `loadSlackFeedPanel()` and opens when it settles, success or failure; the
  body sits in `ChunkBoundary`, whose failure line is `slack-feed-load-failed`. The panel reads `getSlackFeed()` on mount
  and on its Refresh button (`slack-feed-refresh`, `aria-disabled` while a read is out, so focus stays; one read at a time,
  an answer after unmount dropped, a failed refresh keeps the rows already shown), **never on a timer**, and unmounts on
  close, so every open starts on **Mentions**. Tabs (`FEED_TABS` in `ui/slack-feed.js`, one `BoardTabs`, test ids
  `slack-feed-view-<id>`): Mentions, Threads, Reactions; a tab's count is its unread rows (`tabCounts`, with
  `hint: 'unread'` so it is spoken), never its row count. Not `BoardSection` (it adds a heading and status region).
  Rows are plain `a[href][target=_blank][rel="noopener noreferrer"]` links (`slack-feed-row-<id>`) to the message in
  Slack, because `thread()` serves one channel and only verified roots and cannot open an arbitrary message; never route
  a row to the thread dialog. An unhydrated row reads "Unknown conversation" and "Message not loaded".
- **Disconnected and unavailable are calm.** `reason: 'disconnected'` shows `slack-feed-disconnected` with a link
  (`slack-feed-connect-link`) to `#/slack` that closes the drawer and refocuses the tab; the drawer never connects (the
  Slack tab owns sign-in) and shows no Connect button. `unavailable` shows `slack-feed-unavailable` with Refresh.
  `getSlackFeed` resolves `{ available: false, reason: 'unavailable' }` on any failure.
- **`GET /api/slack/feed`** (`slack.feed()`, `createSlackFeed` in `backend/slack-feed.mjs`) takes no query, answers 200
  and never throws: `{ available: true, updatedAt, partial[], mentions[], threads[], reactions[] }` or
  `{ available: false, reason: 'disconnected' | 'unavailable' }`; no stored session means `disconnected` with no Slack
  call, every other failure (a feed `ok:false`, a thrown call, a session change mid-read) is `unavailable`. `partial`
  holds `budget`, `rate_limited`, `unreadable`. A cross-site or same-site `Sec-Fetch-Site` is answered `403`
  `INVALID_ORIGIN` directly in the route, as the chat stream does (a thrown one would read `OPERATION_FAILED`), because a
  read spends up to about 35 Slack calls. `/api/slack/` keeps its `[http]` line message-free. Rows carry names and text,
  never user, channel or user-group ids: an unmapped `<@U..>` becomes `@someone`, an unlabelled `<#C..>` `#channel` and a `<!subteam^S..>` its label or `@group` (`plainText`,
  before the shared `cleanText`, which the Slack board keeps untouched); an id with no known name is `''`.
- **Calls and caches.** One `activity.feed` page (`types=at_user,at_channel,keyword,thread_v2,message_reaction`,
  `limit=30`), then hydration in tab order (mentions, threads, reactions), newest first, pool of 5: at most 24
  `conversations.replies` (`HYDRATE_BUDGET`, one per distinct message, never `conversations.history`) and 10
  `conversations.info` (`INFO_BUDGET`) per request, plus the shared `auth.test` and `users.list`. A row the budget does
  not reach is `hydrated: false` with `partial: ['budget']`; a thrown `rate_limited` stops every further call of the
  request; a per-call failure leaves that row unhydrated (`unreadable`) and never fails the page. Message reads (key
  `<channel>:<ts>`, thread rows `thread:<channel>:<latest_ts>` so a reaction cannot hand a thread a parent-less entry) and
  channel infos are cached 10 minutes, 200 entries each, oldest out; a read Slack would not give is remembered 60 s
  (`MISS_TTL_MS`, a negative cache written only for an `ok:false` or unusable payload, never for a throw or rate limit)
  so an unreadable row costs no call per open. Concurrent calls share one in-flight promise; there is no page cache.
  `clearCaches()` calls `feed.clear()` (all three maps), and every await re-checks `isCurrent(gen)`, so an account
  switch returns `unavailable` and a stale read writes no cache.
- **Method literals and read-only.** `activity.feed`, `conversations.replies` and `conversations.info` of the feed live
  only in `slack-feed.mjs`, which is in `NEW_MODULES` of `test/slack-watch-readonly.test.mjs`; no `activity.mark*` or any
  write method. Every call goes through `call()`, so rate limits and upstream health are the integration's.
- **Split and dedupe.** `at_user`, `at_channel` and `keyword` items are **Mentions** (one row per `<channel>:<ts>`, unread
  if any collapsed item is), `thread_v2` is **Threads**, `message_reaction` is **Reactions**; other types and items with no key
  or no message ids are dropped. A thread row whose newest reply (`latest_ts`) is already a mention row is dropped, so a
  mention shows once, under Mentions; reaction rows are separate events and are never dropped for a mention.
- **The count.** The tab's number is `activityMentions` from `pending()` (`mentionUnread`: `at_user + at_channel +
keyword` from the `client.counts` call it already makes; only positive finite numbers count), mentions only, `99+`
  above 99, amber `attention`, shown only while `pending.available`; `channel` and `mentionsTotal` keep their meaning
  and the Slack tab's badge number is unchanged. Whether it equals Slack's own Activity badge is not verified.
- **One shared pending store.** `useSlackPending` is a module-level store (`useSyncExternalStore`): one timer, readers
  counted, the first reader starts it and the last stops it, so the Slack tab's badge and the drawer tab make one
  `/api/slack/pending` request per interval. The next tick is `pendingDelay(pending)` in `ui/polling.js`: `SLACK_POLL_MS`
  (60 s) when `available` **or `failed`**, `SLACK_IDLE_POLL_MS` (5 min) only when the server itself answered
  `available: false`; `getSlackPending` turns a rejected fetch or non-OK status into `{ available: false, failed: true }`
  (client-side only, so a flaky network is retried in a minute, not five). A tick while `document.hidden` asks for
  nothing; `slack-session-changed` reads at once, and so does the page going from hidden to visible: a `visibilitychange`
  listener (`readIfVisible`, which reads only while `document.hidden` is false) owned by the store like the session
  listener, added with the first reader and removed with the last, so the count is fresh on return instead of waiting for
  the next tick (the return read re-arms the one timer, so the cadence stays a request a minute; no second timer, and no
  other screen gains a fetch). The next tick is armed when a tick fires (the timer callback calls `schedule()` then
  `readIfVisible()`) and again by each answer, every read asks, and only the newest read's answer counts (`latest`): not an
  in-flight guard, because a guard would drop the session-change read and a hung request would stall the poll, and the
  "shared pending poll" e2e depends on the arm-first order. Do not add a guard.
- **The border countdown.** The Slack edge tab's left border is the countdown to the next read, synced to the store's
  real timer, never a free-running loop. Each `schedule()` publishes a new snapshot `{ pending, ms, cycle }` (`useSlackPending()`
  returns it whole; `ms` is that arm's `pendingDelay`, `cycle` the `setTimeout` id, so it changes exactly when the timer is
  re-armed: the tick, an answer landing, the return-from-hidden read, a session-change read). `SlackDrawer` passes it as
  `sweep` (only while `pending.available`: absent before the first answer and while unavailable, disconnected or failed)
  and `EdgeDrawer` renders a keyed, `aria-hidden` `.slack-feed-tab-sweep` span, so a new cycle remounts it and a CSS
  animation of `--sweep-ms` restarts. CSS only (`slack-feed.css`: transform-only `scaleY(0)` to `scaleY(1)` from the top,
  `linear`, clipped to the tab's rounded corners by the wrapper, `--accent`; `display: none` under reduced motion). It
  keeps running while the page is hidden, like the timer, and adds no timer, subscription or per-second render. The
  Sessions tab and the Slack board's badge have none. Do not drive it from script or add text, a tooltip or a name.
- **Style roles.** The tab is cyan `--accent` (`slack-feed.css`: hover, expanded and focus ring), never lavender
  (Claude only); both new sheets use tokens only, text at least `--fs-xs`, 120 ms named transitions and a
  reduced-motion block, and `slack-feed.css` selectors all start `.slack-feed`. The frame sheet is `edge-drawer.css`,
  imported before `slack-feed.css` and `sessions-drawer.css` in `styles.css`.

## UI colour, text and buttons: facts not to break

`ui-react/styles/tokens.css` is the only stylesheet that writes a colour (`mascots.css` and `posters.css` art
excepted); `styles.css` keeps alias lines only (`--panel-2`, `--fg*`, `--ok`, `--bad`, `--warn`). `theme.js` and
`index.html` (`theme-color`) hold literals equal to the tokens, because MUI needs parseable colours; change a token,
change them (`test/ui-refresh-palette.test.mjs` holds all three, and every text pair at 4.5:1 and every edge or
focus ring at 3:1; `--red` is lifted to `#fc7a8d` to clear 4.5:1 under its 12% hover tint).

- Roles: cyan (`--accent`, `--accent-fill` for a primary fill) means interactive or selected, never decoration.
  The Slack activity edge tab is cyan, not lavender (it is not Claude).
  Lavender (`--support`) means Claude only: the Sessions tab and drawer, the Chat tab and screen, the Sprint tab's
  Groom controls, the Claude launcher including its dialog primary fill (`.claude-dialog .btn.primary`, specificity 0,4,0, keeps `:disabled`
  on the base look). Ticket keys (`.jira-link`, `.review-ticket-key`, `.my-tickets-card-key`) are `--strong` and
  underline on hover. Jira status kind `active` is `--status-active`; My Tickets cards also carry a decorative 2px
  top bar (`.my-tickets-card::before`, `--jira-status-color`; the column title says the status, so never colour alone).
  `--phase-implement` is teal, not lavender.
- Approved card tint is 13% green over `--panel2` (8% is no longer green-dominant on the bluer surface);
  `test/ui-react-contract.test.mjs` pins it, and `--muted` on it is 4.56:1.
- Readable text is at least `--fs-xs` (12px); the guards scan every sheet but `posters.css`, `settings.css` and
  `releases.css`. Poster art stays as drawn.
- Buttons are neutral by default: `.btn.MuiButton-outlined` (and native `.btn`) sits before `.btn.primary`,
  `.btn.subtle` and `.btn.danger` in `base.css`, all equal specificity so order decides; keep that order. Primary and
  `danger` are call-site classes (`className="primary"` on Home Generate velocity before data, DevTools Launch, Chat
  Send, Slack Connect, Services Start all; `danger` on Slack Disconnect, DevTools Remove, watch Remove), not a
  default and not derived from the label. `.btn.subtle:hover` is transparent so chromeless buttons never take the
  neutral hover tint. The rules are global, so Settings and Releases buttons are neutral too.
- `.shell-location` ("Local workspace") is hidden from 700px to 1499px (shown again when the header wraps below 700px) so the header stays one row at the 12px footer pill.

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

## UI layout: the shared board (My Tickets, Slack, Pull Requests, Sprint)

Services also uses `BoardPanel` / `BoardSection`, with a scrolling `.board-pane`
containing its explicit service grid rather than board columns. Keep service
identity, status and controls compact above the stable log viewport; the reserved
feedback footer sits outside the log so polling and feedback do not shift it.
Service-specific layout stays in `services.css`, not the shared board stylesheet.

My Tickets, Slack, Pull Requests and Sprint share one screen shape with different data, built from one set of
primitives — `ui-react/components/BoardShell.jsx` and `ui-react/styles/board.css` — not screen-specific copies.
Toolbar, notes, states, board frame, columns and card shell are changed there and all four screens get
the change. The panel sheets (`my-tickets.css`, `slack.css`, `prs.css`, `sprint-board.css`) hold only what is specific to their own
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
- `RefreshControl` (Refresh button and its countdown) takes the `load` and the
  `countdown` that `useActivePolling` returns, so a click restarts the countdown and goes through the
  hook's in-flight guard. `countdown` is a descriptor `{ lastLoadedAt, interval, loaded, active }`, not
  text: `RefreshControl` renders `BoardCountdown` (private to `BoardShell.jsx`), the only 1 s clock a
  board has, so only its span re-renders per second, never the panel; it ticks only while its screen is
  `active` and the page is visible, and holds `refresh paused (Ns)` while hidden. The words are no
  longer seen: the `.board-next` readout (text, test id and class unchanged, so tests and assistive tech
  still read it) lies `color: transparent` over the Refresh button's border box (`.board-refresh`
  wraps the pair), and its `::before` is the countdown, a 2px `--accent` line along the button's bottom
  edge that fills left to right (`board-sweep`, transform-only, linear) over `--cd-ms` (the descriptor's
  `interval`), starting `--cd-ago` (elapsed ms, negative) in. It is CSS only and draws only while the
  readout has words (`:not(:empty)`), so it follows the readout's rules: loaded and `active`. The span is
  keyed by `hidden + lastLoadedAt`, so a load or the page hiding or showing restarts it, and `data-hold`
  pauses it while hidden; `--cd-ago` is read once per cycle in a `useMemo` (also keyed on `active`, so a
  screen shown again resumes at the true position), never per tick, which would shift a running
  animation. Hidden under reduced motion. Do not `sr-only` the readout (it would clip the line) or
  give a screen its own copy of the rule. Pass `countdown`
  straight through, never read it as a string. All five board screens (My Tickets, Slack, Pull
  Requests, DevTools, Sprint) do this. `RefreshControl` also registers its guarded `onRefresh` under its
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
- `BoardNote` (an amber one-line chip, `role="status"`, exact text always in the DOM and clamped by CSS; a
  24px text-less toggle, `board-note-toggle`, named "Show full note" / "Collapse note", appears only while the text
  overflows, measured on the text span; `defaultOpen` starts it expanded, used only by the two Slack coverage notes,
  `my-tickets-slack-coverage` and `sprint-board-slack-coverage`, because they carry a link) and `BoardState` (loading, empty, error or warning body).
- `Board` and `BoardColumn` — `.board-frame` > `.board-track` and its columns. `Board` owns scroll
  preservation (`usePreservedInteraction`), so a screen never wires it again. Optional `BoardColumn.hint`
  gives a heading existing `DashboardTooltip` help on hover/keyboard focus; only hinted headings gain
  a Tab stop. Pull Requests supplies lane meanings; My Tickets/Slack keep their no-hint defaults.
- `.board-card` (`.board-card-action` for a card that is a button), `.board-card-top`,
  `.board-card-summary`, `.board-card-stat` and `.board-chip` — the card shell and status chip. A
  domain card adds its own class beside them (`board-card my-tickets-card`).

**Shared by the four screens that open Slack threads** (the Slack board directly; the My Tickets, Pull
Requests and Sprint card chips through `ui-react/hooks/useTicketSlackThreads.jsx`), each once, with the
differences passed in rather than forked:

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
- `threadTicketKeys(thread)` in `ui/slack-ticket-links.js` — the one rule that ties a Slack thread to
  tickets: every `TAP`/`TRIPS` key on the thread's subject line (`subjectText`, the first line of the
  opening message), found in the slugified line so formatting (`_italics_`, labels, brackets, links)
  never hides one, bounded by `-` so `TAP-12` is not `TAP-1` and `STAP-1` is nothing. `threadsByTicket`
  (the card chips) and the thread dialog's title both call it; never add a second key regex for Slack text.
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
  (no separate unmount code). Closing at step 2 before Start **removes** the browser (record and profile: a
  throw-away browser no session used, so no Stopped row piles up; the finish-time auto-stop above still only
  stops); while Start runs, close does nothing and unmount removes nothing; after `timed_out` no close path
  stops or removes it (the backend's auto-stop owns it). No `EventSource` in the component.
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

## Harness seam: facts not to break

Everything that speaks the agent CLI sits behind one adapter in `backend/harness/`. The contract, the
"Adding a harness" steps and checks, what leaves the backend and what is not renamed are in
[`backend/harness/README.md`](backend/harness/README.md); the user-facing rules are README "Harnesses".
Claude Code is the only registered adapter and the default; with it active every argv, command string,
file, route, reply shape, reason code and pinned word is unchanged. Rules a change can break:

- **One list, one wiring point.** `HARNESSES` in `backend/harness/index.mjs` is the only list (no
  hard-coded id or count anywhere); `assertHarness` runs on every entry at load and `buildSessions`
  checks the sessions service's methods where `createHttpHandler` builds it. `createHttpHandler` picks
  `integrations.harness || defaultHarness()` once and passes it to the sessions service, launcher, chat,
  usage reader and Slack watcher, each defaulting to Claude Code. No setting, env var or UI control
  chooses it (`editable()` would drop a new settings key), and a registered harness needs a driver in
  `test/harness-conformance.test.mjs` (`DRIVERS`). `test/harness-fake.mjs` is the test-only second
  adapter; nothing here is verified against another CLI.
- **Import rule.** Nothing outside `backend/harness/<id>/` imports from it except
  `backend/harness/index.mjs`, and an adapter imports only Node built-ins, `config.mjs`,
  `claude-log.mjs`, `slack-watch-store.mjs` (`isSessionId`), the generic files in `backend/harness/` and
  its own directory, never a launcher, chat, ticket-state, usage or HTTP module (no cycles).
  `test/harness-layout.test.mjs` pins both, that the two Claude files that moved into the adapter
  (sessions, chat items) leave nothing at their old `backend/` paths (moved with `git mv`, no shim) and
  that no generic module spells the `claude` binary or an `mcp__` name. A Claude literal in a generic
  module (argv, command string, tool name, usage field, `~/.claude`) belongs in the adapter.
- **The `harness` stamp is additive.** A new `launch.json` phase record and a new standalone chat record
  get `...harnessStamp(harness)`: `{}` for Claude Code (the bytes are unchanged), `{ harness: id }` for
  any other. `harnessIdOf(record)` reads a valid `harness` and otherwise `claude-code`, so older files
  read as Claude Code. Never rename an id (a stored value), and never write `harness: 'claude-code'`.
  `status.json` is untouched (a protocol with the session). A record of another harness still lists but
  gets no go-to command (the active harness's commands would misname it).
- **`harness_unsupported` is the one new refusal**, 409 `CLAUDE_REFUSED`, before any file write, session
  call or spawn (the sites are listed in README "Harnesses"): `requireChat`, `requireOwnHarness` and the
  spec review's `limits.specReview` check. A chat `send` to another harness's record is refused, but
  `resolveSession` is not, so such a chat's history still opens. Launching over another harness's record
  is not refused (it replaces the record). A missing `usage` facet is not a refusal: zero, complete
  tallies and no file read.
- **Capabilities are derived from facets** (`harnessMeta`), never declared beside them.
  `GET /api/config` is the only response that gains a field (`harness`); every other reply key set stays
  pinned by the route tests.
- **UI helper.** `ui/harness.js` is pure and import-free, at most 2048 bytes (asserted in
  `test/harness.test.mjs`): `DEFAULT_HARNESS`, `harnessFrom(raw)` (invalid or missing gives Claude Code,
  never throws), `say(text, harness)` (fills `{name}`, `{label}`, `{command}`, `{A}`) and
  `can(harness, capability)`. `HarnessContext` / `useHarness` live in `ui-react/lib/harness-context.js`
  and `App.jsx` provides them around both the setup-only and the ready shell. Wording stays a token in
  the source (`say('{name} session attached', harness)`) and is filled at render, so the default harness
  reproduces every old literal; `test/harness.test.mjs` ties its golden table to the source text, and
  two source-text tests pin the token form (`ui-react-contract.test.mjs` for the Slack chip,
  `pr-review-board-contract.test.mjs` for the review labels). The usage hooks ask `/api/claude/usage`
  only when `can(harness, 'usage')`, and Chat shows its composer read-only with "Chat is not available
  with {label}." when `!can(harness, 'chat')`. A new user-visible string that names the harness uses a
  token, never the literal.
- **Not renamed, on purpose** (the list is in the guide's "What leaves the backend"): the `claude`-named
  routes, codes, log prefix, state directory, modules, test ids and CSS classes name the product area and
  are pinned by tests.
- **One prompt source for every harness.** The built-in prompts and `prompts/*.md` are the only prompt
  set; no per-harness copy, directory or template exists. The few harness-specific words are the
  placeholders `{SKILL}` and `{ASK_TOOL}`, filled by `harnessValues` in `claude-prompts.mjs` from the
  adapter's required `prompt: { skill, askTool }` (checked by `assertHarness`, covered by the
  conformance suite). Rendered for Claude Code they are byte-identical
  (`test/claude-prompts-golden.test.mjs`); a new harness-specific fragment becomes a placeholder, never a
  second text.
- **Untouched by design:** `backend/manager.mjs` and the `config.mjs` exports (`withoutSecrets` and
  `SECRET_ENV_NAMES` stay the one credential list, used by every adapter's process starts).

## Chat: facts not to break

The Chat tab (`ui-react/panels/ChatPanel.jsx`) talks to a real Claude Code session: the server runs
the harness's turn command (Claude Code: `claude -p`) and streams normalized events to the browser. A
chat is addressed by one value, the session UUID (`#/chat?session=<uuid>`): a **standalone chat** (a
record in `claude/chat/<uuid>.json`, no ticket,
cwd always `~/pathwise`) or any session `claude agents --json --all` lists, which includes every ticket
session. The CLI does not list a `-p` run, which is why the dashboard keeps its own record for standalone
chats. The contract is README "Chat" (routes, errors, events, items); its two ends are
`backend/harness/claude-code/chat-items.mjs` (CLI line to event, transcript to items, the adapter's
chat facet) and `ui/chat-stream.js` (the client reducer).

- **One writer per session, and its refusals.** `claudeSessions.beginTurn(sessionId)` in
  `backend/harness/claude-code/sessions.mjs` (built on `createSessionLock` in
  `backend/harness/session-lock.mjs`) is the only writer mark; the chat turn and `resume()` (so the
  launcher's answers, approve, re-review and Continue, and the Slack watcher) go through it, never
  through a second lock. A held session reads `state: "working"` in `entries()`, so the launcher's
  guards, the ticket card and the bot bar see a turn as work in progress.
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
  `spawn(turn.command, turn.args, { cwd, env: withoutSecrets(process.env), stdio: pipes })` with no `shell`
  option, where `turn` is the harness's `chat.buildTurn(...)` (Claude Code: `claude`, the fixed
  `TURN_ARGS` in `backend/harness/claude-code/cli.mjs` plus `--resume <uuid>` or
  `--session-id <uuid>`); the message is a stdin line, never an argument (it would show in `ps`), and
  no permission, model, tool or MCP flag is passed. `withoutSecrets` in `backend/config.mjs` is the one
  place the credential names (`SECRET_ENV_NAMES`) are removed, and every place that starts a process
  uses it: `launch()`, `resume()`, the manager's Node runtime and the chat. A new child gets it too.
  The cwd comes from the record or the listing, never from a request; a listed entry with no usable cwd is `spawn_failed` rather than a run in
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
  still on disk. `recoverSessionIds` (`backend/harness/claude-code/sessions.mjs`, the same
  `scanTranscripts` helper as `lastActive`, a separate pass) maps a short id to the full id: regular `<uuid>.jsonl` files only (the uuid directories beside them
  do not count) and exactly one distinct id behind the prefix, else nothing. The launcher asks (`recoverOrphans`,
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

## Sprint board: facts not to break

The Sprint tab (`ui-react/panels/SprintPanel.jsx`, `SprintCard.jsx`, `SprintGroomDialog.jsx`; pure rules in
`ui/sprint-attention.js` and `ui/sprint-board.js`; reads in `backend/sprint-board.mjs`) is a product-owner view of one
team's sprint. README "Sprint" has the user-facing rules and the reply shapes.

- **A lazy board screen in the Tools row.** `READY_TABS` row `sprint` after `mascots` (the mascots-after-devtools pin
  and `PRIMARY_ROUTES` are unchanged), a memoized `lazyScreen` in a board-shaped `ScreenSlot` that passes `config`, chord
  `b` in `SHORTCUT_TABS`, `panels/SprintPanel.jsx` in `LAZY_MODULES`. No hash query (`QUERY_ROUTES` is pinned): the
  choice lives in storage. `BoardPanel` > `BoardSection name="sprint"` with `RefreshControl name="sprint"` (the
  palette's Refresh is keyed by tab id) and `Board` / `BoardColumn` with `sprint-*` test ids, never `TicketBoard`,
  whose ids would collide with My Tickets'. Columns are `finishedColumnsLast(boardColumns(shown))`: the shared
  `boardColumns` order (attention band first) is left alone, and `finishedColumnsLast` in `ui/sprint-board.js` moves a
  column of finished tickets that is not done-kind (Rejected, Duplicate) to the end, after the done band.
- **Its own storage key, never Home's.** `dev-dashboard.sprint-board` (`{ version: 1, team, sprint }`) is read and
  written only by `ui/sprint-board.js`; never a `dev-dashboard.home-velocity*` key or `readVelocityTeam`. `sprint: null`
  means "follow the team's active sprint": `sprintChoice` stores null for the active sprint, a team change stores
  null and `settledChoice` turns a kept id that has become the active sprint back into null, so never turn a null
  into an id. Team defaults to Nexus (`DEFAULT_SPRINT_TEAM`).
- **No `/api/team-velocity`.** Teams come from `GET /api/sprints` (`boardOf` prefixes, the identity Home shows);
  `e2e/sprint-board.spec.js` asserts zero velocity reads, and the Home velocity rule above is unaffected.
- **Read-only routes.** `GET /api/sprints` and `GET /api/sprint-tickets?sprint=<id>` are setup-gated, send no Jira
  write and log nothing (`test/sprint-board.test.mjs` scans the module for `POST`/`PUT` and `console.`), and reach
  Jira only through `upstreamFetch` (`sprint-board.mjs` is in the no-bare-fetch list). A cross-site or same-site
  `Sec-Fetch-Site` is refused before any Jira call. The id goes into JQL, so `SPRINT_ID` (`^[1-9]\d{0,9}$`) is checked
  in the route **and** in `fetchSprintTickets` itself: `400 INVALID_SPRINT` (in the error allow-list), no Jira call.
  A ticket is `mapTicketIssue` plus `assignee`, fetched with the shared `ticketFields(cfg)` from `jira.mjs`; a field
  `mapTicketIssue` reads is added there, never in one caller.
- **Sprint discovery is the Agile API, bounded.** `fetchSprintList` reads one page of
  `GET /rest/agile/1.0/board?type=scrum` (50 rows, `BOARDS_MAX` 20 kept), then per board `/board/<id>/sprint`: one
  `active,future` page and the first `closed` page; when that is not the last, only the last `closed` page (from
  `total`), or, with no `total`, pages forward up to `CLOSED_PAGES_MAX` (4) closed pages, because Jira lists closed
  sprints oldest first. Boards run through the shared `runWithLimit` (`backend/jira-search.mjs`, also used by
  `dev-status.mjs` and `slack-feed.mjs`; never a local copy) `BOARD_CONCURRENCY` (3) at a time, each board's reads one
  after another, so at most 3 Jira requests are in flight, and the first board failure stops the other workers (its
  `stopped` flag), because a failed list is not cached and the tab polls every 60 s. A live site with 6 boards is 13
  calls per 5-minute cache. Board ids must match `SPRINT_ID` before they go into a path. `teamsOf` groups by
  `boardOf`, dedupes by id (a sprint can sit on several boards) and orders as before (closed newest by end date, 3 per
  team). More boards than the cap, an open page that is not the last, the closed page cap, or a board answering
  400/403/404 sets `truncated`, which the panel shows as `sprint-board-teams-truncated` (pickers may miss sprints),
  separate from the ticket note `sprint-truncated` (`data.truncated` only). A board skipped for a 403 is recorded by
  `upstreamFetch` as a Jira `auth` failure, so `/api/health` may read "Jira rejected the token" until the next good
  Jira call (the tickets read that follows usually clears it); that is expected, not a token problem. Only a
  401/403/404 on the board list, not a rate limit, falls back to the old issue scan (`scannedSprintList`, kept
  unchanged); every other failure is the reply, so a 429 never adds calls.
- **Caches.** Module-level: the sprint list 5 minutes, a sprint's tickets 30 s with at most 20 entries, keyed by Jira
  base URL **and account email** (plus the sprint field or the id), concurrent reads share one promise and a failed
  read is forgotten. A Refresh within 30 s gets the cached answer on purpose. `clearSprintBoardCaches()` is for tests.
  The poll is 60 s (`SPRINT_BOARD_POLL_MS`), never while hidden. A team or sprint switch calls `load` directly (the
  hook's guarded load would drop it while a read is out), a request counter drops stale answers, and the poll that
  can follow a switch within a second is accepted, because the cache serves it.
- **Linked PRs are deliberately absent.** No `dev-status.mjs` or GitHub call from this screen: a per-ticket
  dev-status lookup on a 60 s poll is sustained Jira load, and one 429 cools every Jira call down for up to 900 s.
  Adding PRs needs a cheaper discovery first, not a call per card.
- **Slack threads come only through the shared hook.** `useTicketSlackThreads` with `source: 'sprint'` and
  `includeMentions: true` (a sprint is mostly other people's tickets, as on Pull Requests); `loadSlack()` is fired from
  the panel's own `load`, never awaited, so the tickets never wait on Slack. No Slack route, method call or
  `/api/slack` literal of this screen's own: the hook's existing reads (`GET /api/slack/status` and the route-cached
  `GET /api/slack/threads`) are the only ones.
  The card's chips are `SlackThreadLinks`, looked up by `normalizeTicketKey` (TAP and TRIPS only), opened through the
  hook's `openThread` with `selectedTicketKey`, and its `dialog` is rendered inside the panel after the section. The
  coverage note is `sprint-board-slack-coverage` (the hook's `incomplete` or a `continuation`); it starts open
  (`defaultOpen`) because it carries a link, as My Tickets' does, and `test/board-shell-refresh.test.mjs` pins both.
- **Grooming has one path.** The card's Groom opens the existing `ClaudeDialog` (after `loadClaudeDialog()`
  resolves; see the bundle note under "Lazy screens"). The batch launches only through `claude.launch(key, 'groom')`
  from `useClaudeTickets`, awaited one after another, never in parallel, capped by `groomCandidates` at
  `GROOM_BATCH_MAX` (5) minus the groom sessions working anywhere; `groomOutcome` skips `session_running` and goes
  on, and any other refusal stops the rest. No second launch route and no Jira write. The cap is client-side only.
- **Attention reasons are one closed table.** `ATTENTION_REASONS` in `ui/sprint-attention.js` (id, label, order) is
  the only list: the card chips, the summary toggles and `attentionOrder` read it, and `CLAUDE_REASONS` names the
  three that need a Claude answer (`–` and `aria-disabled` until `claude.loaded`, never counted before). `slack-reply`
  is not one of them: it reads `needsReply === true` on the ticket's thread rows, passed in as `slackLinks` in
  `attentionReasons`' options (the panel's one lookup), never from message text. A finished ticket has none:
  `isFinished` (exported from `ui/sprint-attention.js`) is a done kind **or** `statusCategory === 'Done'` whatever its
  kind, so Rejected (kind `attention`) and Duplicate (kind `queued`) are finished; the same rule gives done points,
  keeps finished tickets out of `groomCandidates` and hides the card's Groom button. `ui/jira-status.js` keeps those
  kinds, because My Tickets and the bot bar share it. A new reason is a row there and its rule in `attentionReasons`,
  never a list in a component. Batch eligibility uses `TICKET_KEY` exported from `ui/needs-you.js`, never a new regex.
- **Phase words are a tested copy.** `SESSION_CHIP_WORDS` in `ui/sprint-board.js` copies `PHASES[*].words` of
  `ui/session-phases.js` (plus spec review, which that table has no row for), because importing that module from
  the lazy screen splits it out of the entry chunk. `test/sprint-board-state.test.mjs` ties the copy to the table, so a
  renamed phase fails there; change both.
- **CSS prefix `sprint-board`.** `ui-react/styles/sprint-board.css` is in `BOARD_SHEETS`: every selector starts
  `.sprint-board` (`.sprint-*` is Home's, in `home.css`), tokens only, short named transitions, a reduced-motion block,
  no `columns:`. Lavender `--support` marks the Groom controls only (the batch dialog's Confirm through
  `.sprint-board-dialog .btn.primary`). No `UpstreamNote` is mounted on this screen.

## Lazy screens and the first-paint bundle

Chat, Releases, DevTools, Mascots and Sprint load their code on first visit; Home, My Tickets, Slack, Pull
Requests, Services, Settings (the only screen in setup-only mode) and the bot bar are eager. The ticket
Claude dialog, the command palette, the shortcuts help and the two edge-drawer bodies (`SlackFeedPanel`, opened by
the Slack edge tab, and `SessionsBody`, the Sessions list) are lazy overlays too
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
  201 KiB gzip -9 (raised from 200 for the merged-PR rows); a new eager import of a lazy module fails it. `vite.config.js` is pinned by
  `ui-build-contract.test.mjs`. Both edge-drawer bodies are in its `LAZY_MODULES`.
- **The first-paint gzip, all-JS and CSS margins are thin.** With the Sprint tab and its Slack threads the initial
  closure is 645,708 B raw (631 KiB) and 205,249 B gzip against 205,824 (201 KiB; 575 B spare), all JS is 919,892 B
  against `MAX_TOTAL_RAW`, 900 KiB (921,600 B; raised from 884 KiB for the lazy Sprint screen), so 1,708 B spare
  (the Sprint screen's Slack wiring reuses eager modules and split none out), and all CSS is 181,863 B against
  180 KiB (184,320 B), 2,457 B spare: a few more bytes of eager code or CSS, or a new eager import, can fail the budget
  test with no apparent cause. A lazy screen that imports a module the entry also uses can split it into an initial
  chunk of its own: `SprintPanel` therefore opens `ClaudeDialog` after `loadClaudeDialog()` instead of importing
  `LazyDialog` from `ScreenSlot`, and the Sprint card keeps a copy of the phase words instead of importing
  `ui/session-phases.js` (measured at about +1.4 KB and +450 B of first-paint gzip). The spec icon (`SpecMark` in `TicketBoard.jsx`) is eager on
  purpose: a lazy version measured no smaller at first paint, because the panel state and API call are eager anyway.
  `SessionsBody` stays lazy only because `SessionsDrawer` passes it dressed rows: rolldown makes any module that the
  entry and two or more lazy chunks share its own initial chunk, which cost more than the move saved. A new import in
  `SessionsBody.jsx` (pinned by a source test in `test/edge-drawer.test.mjs`) of a module an eager file and another lazy
  chunk already use brings that split back; re-measure the chunks before adding one.
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
  only when focus was lost (`navigation.spec.js` depends on "only when lost"). The heading's ring shows only after
  a keydown: `useLastInput` (capture `keydown` / `pointerdown`, bound once) lets `useRouteChange` stamp
  `data-focus-source="keyboard"` or `"other"` before `focus()`, and `base.css` drops the outline for
  `[data-focus-source='other']:focus` (`e2e/route-focus.spec.js` and `navigation.spec.js` depend on both rules).
  None of this adds a request or poll; the palette's Refresh runs the board's own guarded load.

## Integration health: facts not to break

- `backend/upstream.mjs` is the one fetch seam for Jira and GitHub (`jira.mjs`, `github.mjs`,
  `github-api.mjs`, `team-velocity.mjs`, `dev-status.mjs`, `sprint-board.mjs`); a source test forbids a bare `fetch(`,
  and also in `releases.mjs` and `ticket-prs.mjs`, which reach Jira only through `dev-status.mjs`.
  `upstreamError(name, res, message)` keeps the caller's message byte-identical. Slack feeds the same
  record from `slack.mjs` and keeps its own `fetchImpl`, timeout and cool-down; the side-branch `.catch`
  on its send promise is deliberate (an extra await tick reorders concurrent Slack reads).
- `backend/dev-status.mjs` is the one Jira dev-status lookup (`lookUpPullRequests`), used by Releases and by
  `GET /api/ticket-prs` (My Tickets PR lines: the default list's newest 50 tickets, every linked PR Jira
  does not report as merged or declined, then GitHub GraphQL keeps the OPEN ones whose author is the saved token's login; no
  `ownsPr`, by decision). It keeps **one module-level cache of unfiltered PRs** per Jira origin and issue id,
  so a caller that needs a subset filters itself (Releases applies `ownsPr` and `countsAsMerged` in
  `releases.mjs`; never filter inside the lookup). The TTL is a per-read argument (`ttlMs`: Releases 60 s,
  My Tickets 120 s), so an expired entry is a miss that is overwritten, never deleted on read: one reader's
  shorter TTL must not evict what the other still serves. Cached PR objects are shared and never mutated.
  A change to the lookup, its call order or its cache must keep the Releases call-count suites green.
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
