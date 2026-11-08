# Changelog

## Unreleased

- Saved Claude answers now go back to the planning session. **Save answers** still saves
  what you changed, and partial answers send nothing. Once every question has an answer, the
  dashboard stops the session if it is idle, waits the Slack wake's 15 s settle gap and
  resumes the same session (a finished one is resumed with no wait) with a notice that
  names the answered or changed question ids (never the answer text) and tells it to update
  the plan, checklist and spec and then set the new `done` flag in `status.json`. A save that
  changes nothing never re-sends answers already delivered, a changed answer re-sends, and a
  failed send keeps the answers and is retried by the next **Save answers**, with or without
  edits. `launch.json` gains `sent`, recorded only after a real delivery. **Implement plan**
  now needs the planning flag and `done` both `true`, no open question and no answer waiting
  to be sent. Two new reasons join the icon and `blocks`: `answers_not_sent` (amber) and
  `plan_not_done` (red); both are also `CLAUDE_REFUSED` reasons for Implement plan, in the order
  open questions, `answers_not_sent`, `plan_not_done`. `GET /api/claude/tickets` entries gain
  `flags.done` and `unsent`, and `POST /api/claude/answers` accepts `[]` and answers with
  `send`. Limits: only the planning session is messaged (after an Implement launch answers just
  save), a session that never sets `done` shows red, **Save answers** can take about 15 s when
  a live session has to be stopped, the gap is a design constant that is not checked against
  the real CLI (the README's manual check covers it), and a failed `launch.json` write after a
  delivered resume is an HTTP error and the next save re-sends.
- Added `nodemon.json` so `npm run dev` ignores the `claude/` state folder. Writing a
  launch or status file there used to restart the dashboard mid-request.
- Added a Claude icon to every My Tickets card. It shows where the ticket stands with
  Claude (not started, working, needs you, done, ended without finishing,
  unavailable) as a badge and a word, and opens a dialog with **Investigate and
  plan**, **Implement plan** and **Go to session**. Both launches start a background
  `claude --bg` session from `~/pathwise`, named `<KEY>-investigate-and-plan` or
  `<KEY>-implement-plan`; **Go to session** copies the command that attaches to or
  resumes it.
  Questions the planning session asks appear in the dialog as text inputs, and
  **Implement plan** stays disabled until you have saved an answer to each. State
  lives in the gitignored `claude/<KEY>/` folder: `status.json`, shared with the
  session, and `launch.json`, written by the dashboard only. The new routes
  `GET /api/claude/tickets`, `POST /api/claude/launch` and `POST /api/claude/answers`
  answer before setup is complete. Host only: it needs the `claude` command and
  `~/pathwise`, and launched sessions do not receive `GH_TOKEN`, `GITHUB_TOKEN`,
  `JIRA_API_TOKEN` or `JIRA_TOKEN`. Run the manual check in the README before first use.
- Claude sessions are now named per phase, and the Jira summary no longer reaches the
  launch (`POST /api/claude/launch` takes `{ key, phase }`; a leftover `summary` is
  ignored). Each phase finds its own session, so **Implement plan** no longer reports
  "already running" while only Investigate and plan runs: a refused launch now names
  the phase that runs (`session_running` for the phase asked for, `investigate_running`
  or `implement_running` for the other), ahead of `not_planned`, `plan_missing` and
  `questions_unanswered`. Sessions launched earlier keep their old name and are still
  tracked by their saved id.
- Added a shared `writeFileAtomic` helper (a temp file, then a rename) beside
  `stageTokenFile` in `backend/credentials.mjs`; the Claude launcher and the Slack
  watch map use it.
- Added a shared `SECRET_ENV_NAMES` list to `backend/config.mjs`: the credentials kept
  out of the environment of the services and Claude sessions the dashboard starts.
- Added a shared `copyText` helper to `ui/dom.js` for the copy buttons of the Claude
  dialog and the Slack thread dialog; the diff viewer keeps its own clipboard code.
- `.dockerignore` now lists `claude`, so the launcher's state folder stays out of the
  image build context.
- The main navigation is now a compact sticky top bar, freeing the full width for
  the ticket and Slack boards. Home, My Tickets and Slack lead, followed by the
  other tools and Settings. Below 1200px the tools use a keyboard-accessible
  disclosure, while the first three links stay visible. Routes, setup gating,
  Slack notification badges and the service connection status are unchanged.
- The Slack switch row (Threads I started, Mentions, Watch threads) is now a proper
  set of tabs: each tab controls the card's body, only the selected tab is a Tab
  stop, and the left and right arrow keys, Home and End move along the row and
  select. The Watch threads tab shows how many threads are watched and turns amber
  (with a note read aloud and shown on hover) while the watcher is paused,
  disabled or has a failing delivery, so a stopped watcher is visible from the
  other views; it is read from the watcher's own poll, with no extra request. On
  My Tickets, **Refresh** now restarts the countdown to the next automatic refresh,
  as it already did on Slack. Internally, the two screens that open Slack threads
  share one hook for the thread dialog (`useSlackThreadDialog`) and one helper for
  the incomplete-results warnings (`slackCoverage`), and the two scroll-keeping
  hooks share one read and write of scroll positions. No `data-testid` changed.
- The Slack tab is redesigned onto the My Tickets board layout: one card with a
  toolbar (title, account line, counts, Connect or Disconnect, **Load more
  eligible threads**, **Refresh** and a countdown), a switch row (Threads I
  started, Mentions, Watch threads) and a board that fills the rest of the
  viewport. The separate Account card, the page intro and the **Activity time
  unavailable** section are gone: a thread whose activity time cannot be verified
  is no longer shown, is left out of the tab counts and the need-a-reply count,
  and the amber note says how many were left out. Watch threads is now the third
  view of the card rather than a card below the board; it stays mounted while
  another view is selected, so its poll and unsent links survive switching.
  Slack now polls through the same hook as My Tickets, which adds **Refresh** and
  a countdown; coming back to the tab reloads the list only when it is older than
  60 seconds (before, on every visit). My Tickets and Slack share one set of
  board components (`BoardShell.jsx`) and one stylesheet (`board.css`), and the
  generic `my-tickets-*` classes are renamed `board-*`. `data-testid` names are
  unchanged, except that Slack gains `slack-tab-watch`, `slack-refresh`,
  `slack-next`, `slack-coverage` and `slack-threads-empty` and loses
  `slack-threads-card` and `slack-body`.
- The Slack tab now groups Threads I started and Mentions into five columns by
  latest activity. The shared list includes only threads created in the last
  rolling 28 days, so older My Tickets Slack chips disappear even after a new
  reply. An incomplete refresh retains only rows it confirmed and warns in both
  panels; previously verified reply information may be reused with a stale
  warning. Ambiguous search and history matches are skipped rather than risk
  reading an older thread, so some recent standalone mentions may be missing.
  The separate watcher and its configured links are unchanged. Live Slack
  behavior and API rate-limit impact have not been verified. Deploy and roll
  back the backend and frontend session-generation changes together.
- The main Playwright UI suite now defaults to four fully parallel workers;
  the separate vite-proxy config is unchanged. It also runs against a fresh
  unminified production build instead of the Vite dev server, with tracing off
  locally, which takes the full run from about 147 s to about 57 s;
  `PW_WORKERS`, `PW_TRACE` and `PW_HTML` are the new switches, and the HTML
  report is no longer written locally by default.
- Each PR line on a My Tickets card now shows review-comment chips: up to two small
  chips counting the PR's GitHub review threads, one for threads a person started
  and one for Copilot's. A chip reads unresolved over total, amber while any thread
  is open and muted with a check once all are resolved, with a plus past GitHub's
  first 50 threads. Threads from other bots and the PR's conversation comments are
  named in the line's accessible name only. `GET /api/ticket-prs` entries gain
  `comments` (counts only, `null` when unreadable), read in a GraphQL batch of its
  own, so a failure in one never blanks the other. The
  query's field names and the Copilot reviewer login were checked against GitHub's
  documentation only, not the live API; if GitHub rejects the query, the chips just
  do not appear.
- A Slack chip on a My Tickets card is now filled, in the support colour, with
  `Claude session attached` in its label when a Claude session is attached to that
  thread through the Slack watcher. Each `started` row of `GET /api/slack/threads`
  gains `attachedSessions` (a count, `0` when the watcher is disabled or its store
  cannot be read; `mentions` rows do not receive that annotation), and the board
  reads the thread list once more when the thread dialog closes. It still never
  reads `GET /api/slack/watch`.
- A My Tickets card turns green, with a seal named `All PRs approved`, when it has
  at least one open PR and every PR reads approved. A PR with unknown review is not
  approved, and CI and drafts are not looked at.
- Changed: a change request that still stands now outranks approvals. When any
  reviewer's latest approval or change request is a change request, the PR reads
  `changes requested` even if another reviewer approved after it (before, the newest
  review decided and a later approval read `approved`). A reviewer's own later
  approval clears their request, and with none standing the newest decides, as
  before; a change request from an account with no login keeps the newest-wins
  rule. The rule is shared, so it also changes the Pull Requests tab badge and
  Home's groups, not only the My Tickets board. Approval counts and the approval
  threshold are unchanged.
- On the My Tickets board a PR's review now reads `review unknown`, never
  `approved`, when GitHub reports reviews older than the newest 100 the board reads
  (`review` is `null` in `GET /api/ticket-prs`), because an older change request
  could still stand there; its card is never green. The Pull Requests tab pages
  through every review and is unaffected.
- `GET /api/ticket-prs` now answers `403` to a browser request whose
  `Sec-Fetch-Site` is `cross-site` or `same-site`, before anything is sent to
  GitHub: a load costs many GitHub calls and nothing is cached. The dashboard's own
  page, a typed address, `curl` and requests without the header are unaffected.
- The My Tickets tab is now a kanban board: one column per Jira status in workflow
  order (blocked work first, Done last), each column scrolling on its own inside a
  board that scrolls sideways and fills the viewport. A card shows the Jira key,
  priority, points, update age and Slack chips with a reply count and a needs-reply
  mark, and one line per open PR of yours naming the ticket: a CI glyph, the repo
  and number, the review state and a draft tag. At narrow widths the filters fold
  behind a Filters button. The new `GET /api/ticket-prs` route supplies the PR lines
  (your open PRs keyed by ticket, with review state and a CI summary); it is gated
  by setup like the other data routes, always answers 200 afterwards and degrades
  to `available: false` or a `null` review or CI instead of failing. The tab never
  waits on it. The status sub-groups and masonry of the old My Tickets list are
  gone.
- The Slack thread dialog, opened from a My Tickets glyph or a Slack tab row, has a
  "Claude session" section that lists the Claude Code sessions attached to that thread
  and attaches and detaches them on the same watcher as the Watch threads card. Attach
  also puts a thread that is not yet watched on the Watch threads list; detach leaves
  it there. Every thread the server hands the dialog (`GET /api/slack/threads` and
  `GET /api/slack/thread`) now carries `watchKey`, the key the watch list files that
  thread under.
- The Slack watcher's interval now paces only the Slack poll. A wake is one awaited
  flow: the poll that finds a notice owed for an idle attached session writes the line,
  stops the session at once with no grace wait, waits a 15 s settle gap (a design
  constant, not a measured timing) and resumes it under the same session id, without
  holding up the poll, a forced check or another session. The watch list gains a
  top-level `nextCheckAt`, the card shows a next-check countdown with no step display,
  and the new `POST /api/slack/watch/check` route runs one poll now behind a Check now
  button.
- Added a Slack thread watcher. Paste Slack thread links on the Slack tab, attach
  Claude Code sessions to them, and the dashboard server appends a one-line notice to
  each attached session's inbox file when someone else posts in a watched thread;
  a finished session is also resumed. The Watch threads card shows each link's last
  check and each session's delivery status, with pause and resume, an interval of
  30 to 3600 seconds and an editable notice. Host only: without a `.claude`
  directory, as in the Docker image, the watcher is disabled.
- The Slack watcher now wakes an attached idle background session when the notice does
  not: it stops the session with `claude stop` in the pass that writes the line and
  resumes the same session id after a 15 s settle gap, never inside it. Busy and
  interactive sessions are never stopped; a session that never lists idle, as one with
  a Monitor armed on its inbox does not, stays `waiting` and ends as `never_idle` 2
  hours after the notice. Delivery gains the `waiting` status and new reason codes
  (shown muted on the Slack tab), a resume that finds the session live now waits
  (`live_at_resume`) instead of failing permanently, no finished session is resumed in
  the first 15 s after the server starts, and the session picker reports each
  session's `activity`. A restart in the middle of a wake can append the same notice
  line a second time.
- Migrated the dashboard shell to React, MUI and Vite while preserving the
  existing panels, API boundary, setup gate, hash navigation, live service
  updates, dark theme, and responsive card layouts.
- Replaced all six legacy DOM panel controllers with React-rendered panels,
  shared React controls, panel-owned interaction state and app-owned styles.
- Added a Docker setup (`Dockerfile`, `docker-compose.yml`) that runs the
  dashboard with its sibling repos' pinned Node versions and dependencies
  installed in the container. Linux only (host networking).
- Moved the Node backend into `backend/`. Commands are now
  `node backend/cli.mjs` and `node backend/server.mjs`.
