# Changelog

## Unreleased

- Added a Mascots tab (after DevTools) that shows every registered mascot for viewing and picking: a
  card per entry of `MASCOTS` with its name and id and all four states (working, idle, done, failed)
  at the bar's 56 px and at 160 px, each captioned in words. Toolbar controls flip the facing
  (Left/Right), turn the walk cycle on (Moving) and replay the one-time done hop and failed shake
  (Replay); a "Roaming preview" strip walks a few bots with the real bot bar's own lane classes and
  keyframes; and a text box shows which mascot a typed session key (`TAP-1234:implement`) hashes to.
  The page is static: it reads no session data, makes no request and does not poll, and a newly
  registered mascot appears on it with no page change. To share the roaming rules, the bar's lane
  style and its facing/stepping choice moved into `laneStyle` and `botPose` in `ui/bot-bar.js` and
  the mascot lookup into `ui-react/lib/mascot-for.js`; the bar itself behaves as before.

- Fixed the mascots' colours on a light-scheme machine. The dashboard is dark-only, but each
  mascot's palette followed the operating system's light/dark setting, so Glim's navy body and
  Wick's dark ink sat on the dark panel with low contrast on a light-OS machine. `mascots.css`
  now has one dark palette per mascot and no `prefers-color-scheme` split.

- Added a bot bar: a transparent strip of animated mascots along the bottom of every screen (not in
  the Settings-only setup mode), one bot per Claude implement or review session of a ticket in an
  active Jira sprint (the bar asks the new `GET /api/active-sprint-tickets?keys=`, which searches
  Jira only for tickets with no answer from the last 5 minutes and is asked at most every 5 minutes
  per page; a ticket whose sprint is unknown, or any ticket while Jira is unavailable or not
  configured, gets no bot, and the last good set is kept when a refresh fails). Phases (`BOT_PHASES` in
  `ui/bot-bar.js`; investigate and groom are left out, as are sessions that are `none` or
  `unknown`). A working bot patrols back and forth, a waiting one is shown as idle and wanders with
  pauses, a done one strolls (a slow amble with rests at each end and halfway) only inside a done zone on
  the left of the bar (30% of its width, at least 240px; it keeps no one else out) and a failed one
  stands slumped; with reduced motion every bot stands still. Hovering or focusing a bot shows the
  dashboard's own popup (`TAP-1451 review: done · finished`), never a native `title`. When a bot's state
  changes while the page is open, a small speech bubble above it says so (`TAP-1451 · Done ✓`; working
  and done go after about 6 seconds, idle and failed stay until the bot is attended to; at most three
  at once), and one polite live region announces each change once. Each
  session is one mascot for life, picked from the registry in `ui-react/components/mascots/index.js`
  by highest-random-weight hashing of its session key (nothing stored; adding a mascot moves only
  about one session in N). A bot opens the existing Claude dialog (review or workflow) for its ticket.
  A done bot fades out after 10 minutes and a done or failed one can be dismissed with its small x
  (in memory only). The bar is an overlay and changes no screen's height, and it polls
  `GET /api/claude/tickets` itself every 15 seconds on every screen while the page is visible
  (marked `?surface=bot-bar`); the My Tickets and Pull Requests polling is unchanged.

- Added a built-in Markdown viewer for the files a ticket's Claude sessions leave in
  `~/pathwise/.orchestrator/<ticket>/` (plan, checklist, spec, groom notes). In the My Tickets Claude
  dialog, View plan (beside the plan path), View groom notes (once a groom session is done) and a
  Files button in the footer open it over the dialog: a file row (plan first), Reload, Copy path and
  Close. Read-only. Two new routes serve it, `GET /api/claude/artifacts?key=` (the list) and
  `GET /api/claude/artifact?key=&name=` (one file): only `.md` files directly inside that ticket's
  folder, a checked ticket key and file name, no symlink followed out of the folder, 512 KB at most.
  Rendering uses `react-markdown` with `remark-gfm` (tables, task lists, fenced code); raw HTML is
  not rendered, only http(s) and mailto links are live (new tab, no opener), and images are never
  fetched (the alt text shows). The Claude dialog's footer now holds Prompts and Files.

- Redesigned both Claude dialogs on one visual language (frontend only: no API, route, prompt,
  state-machine or block-reason change, and every `data-testid` is kept). The My Tickets dialog now
  has a header with the key and a state pill (mark and word), a three-step workflow strip
  (Investigate and plan, Approve plan, Implement plan) with one primary button for the step to act
  on, Approve as a done step (`Approved 7:39 AM`) instead of a disabled button, a quiet re-run for
  Investigate and plan once a plan is approved, reasons for off steps as one line under the strip
  (shared reasons said once), a Go to session chip only for a step that has a session (no
  `No session to join`), Groom ticket set apart as independent, question cards with a progress bar and
  Resend answers beside it, and send messages that can be dismissed and clear once the ticket stops
  working. The Pull Requests review dialog gets the same header pill, a single primary (Start code
  review, or Re-review once a review session exists, when Start becomes `Start new review`), one
  reason line, no unstyled list, and the same dismissible messages. Shared pieces live in
  `ClaudeSteps.jsx` (status pill and mark, session chip, dismiss button) and `.btn.primary` in
  `base.css`. The dialog is 640px wide at most and 90dvh tall, scrolling inside.

- Fixed a ticket reading `unknown / unrecognised_state` (dialog: "Claude status is unavailable", with
  Approve, Resend and Implement all off) after its session was ended with `claude stop`. The CLI lists
  such a session as `state: "stopped"` with `pid: null`; the dashboard now treats `stopped` as a
  finished, resumable session wherever it treats `done` that way (phase state, the `claude --resume`
  join command, review and groom state, Re-review), and the sessions module reads `stopped` with a
  null pid as finished so it can be resumed. `stopped` with a numeric pid is still live, a null pid on
  any other state is still unknown, and every other unfamiliar state stays `unrecognised_state`.
  This also removes the dead end after a failed send: a session left stopped by our own stop can be
  retried.

- Fixed a lost send: after stopping a live session the dashboard waited a fixed 15 seconds and then
  resumed it, which makes the CLI start a copy if the process had not gone yet, so answers could
  vanish. It now polls a fresh listing once a second (`FINISH_POLL_MS`, at most `FINISH_POLL_LIMIT`
  = 30) and resumes only when the session has no process; otherwise the send fails as
  `live_at_resume` with `status.json` untouched (`done` and `approved` are written only after the
  session is gone, and put back if the resume does not deliver).
- Every dashboard send (save answers, Resend answers, Approve plan, Re-review) now goes through one
  helper, `deliverToSession`; the Slack wake stays separate. A failed stop, wait or resume logs one
  `[claude] <step> failed {...}` line with the reason, exit code, output cut to 2 KB, short session
  id and ticket key, never the notice.
- Added **Re-review** to the Pull Requests Claude dialog: `POST /api/claude/rereview` sends a new
  `prompts/rereview.md` message to the ticket's idle review session through the shared send path,
  records `rereview: { at }` on the review record once delivered, and entries gain
  `blocks.rereview` and `reviewResentAt`. The prompt editor lists six prompts.

- Added **Approve plan** and **Resend answers** to the Claude dialog. Approve is open only once
  the planning session marked the plan `done` (and the plan file exists, every question is answered
  and the answers were sent): `POST /api/claude/approve` stops the idle session, sets `done` to
  `false` and `approved` to `true` in `status.json` (adding the key to older files, putting the file
  back if the resume does not deliver), resumes it with a new `prompts/approve.md` message (a final
  consistency check, nothing implemented, `done` set again) and records `approved: { at }` in
  `launch.json`. **Implement plan now needs the approval** (`not_approved`; absent or non-true
  reads as not approved), and answers that differ from the last send withdraw it, while a pure
  resend does not. **Resend answers** posts `resend: true` to `POST /api/claude/answers` to send
  the saved answers again even when unchanged, keeping every other gate. Entries gain
  `flags.approved`, `approvedAt` and `blocks.resend` / `blocks.approve`; the prompt editor lists a
  fifth prompt, `approve`. The send path shared by answers and approval was extracted.
- Replaced Home's Sprint/KPI/Needs You/Services widgets with team/person velocity:
  explicit Generate/Refresh saves an all-team browser snapshot, restored without
  automatic fetching or expiry. Team defaults to Nexus and persists; Everyone/person
  views and alphabetical same-window comparison stay local. Current-assignee/status
  sprint-membership caveats remain explicit; failed refreshes retain last-good data
  and storage failures show an unsaved warning. Added `GET /api/team-velocity`;
  dedicated screens and the standalone velocity report remain unchanged.
- Added **Start code review** to the Pull Requests Claude dialog, replacing its blank body with
  review-session status and launch/error feedback. The PR-only icon tooltip is removed; its
  accessible name and My Tickets tooltips remain. The same button handles initial review and
  re-review through `POST /api/claude/launch` with `phase: "pr-review-transact"`, starting
  `<KEY>-pr-review-transact` in trusted `~/pathwise`. Review is independent of workflow/groom,
  needs no plan, does not mutate `status.json` or receive `--add-dir`, and preserves their records.
  Active/starting reviews and unavailable/unrecognised review state refuse duplicate launches;
  finished/blocked sessions or sessions missing after the start window can be relaunched.
  Ticket entries gain `review: { state, reason }` and `blocks.review`; Investigate resets keep
  review and groom records. The fixed server-generated prompt uses `pr-review-transact`, checks
  prior findings/unresolved threads against the latest head without duplicating resolved
  findings, and forbids code fixes. It delegates actionable PR findings/review and a concise
  reply to the ticket's existing Slack thread through applicable workspace skills, preserving
  their approval/Jira rules and permission/confirmation gates. Missing threads or required
  confirmation are reported as blockers, not replaced with new threads or unconfirmed success.
  No dashboard Slack posting/thread-finding integration or review prompt editor is added.
  Session completion is not a passing review; tests verify prompt intent and lifecycle with
  fake CLI/intercepted APIs, not real reviews, PR posts or Slack replies. All four PR filters
  now persist, including Ticket prefix, in the existing version-1 localStorage; valid saved
  choices win over empty Search/All dropdown defaults, and Clear persists those defaults.
  Deploy backend and built UI together; no dependency, environment or storage migration.
- Replaced the Pull Requests screen's four PR sections with the shared review
  board: one card per other-assigned Jira ticket in **Ready For Code Review**,
  including tickets with no PRs, with all title-linked open PRs across current
  watched repositories (drafts and configured specs repos included). **To Review**,
  **Reviewing** and **Reviewed** derive from every linked PR before filters;
  Reviewed needs a nonempty all-approved set, no drafts or standing changes
  requests, and complete evidence. Missing discovery/review evidence stays
  conservatively To Review. Added dynamic **Ticket prefix** alongside Search,
  Repository and Review state, **Clear filters**, and hover/keyboard lane-header
  help. New read-only
  `GET /api/review-tickets`; Home, My Tickets, Slack, legacy PR APIs/CLI and the
  diff viewer retain their behavior. Deploy the backend route before/with the UI.
- On a My Tickets card the Slack chips and the Claude icon moved out of the top line into a row
  of their own under it (chips at the start, the icon at the right edge); the top line keeps the
  key, seal, priority, points and update age.
- Added **Groom ticket** to the Claude dialog: a third row, with its own **Go to session**,
  that starts a background session named `<KEY>-groom` running your `groom-ticket` skill. It is
  independent of the investigate and implement workflow: any ticket in any Jira status, no
  flags, no `status.json`, no gates, and neither it nor the workflow blocks the other (only a
  running groom session refuses another Groom launch). The prompt keeps the session read-only
  (no Jira write, no Slack post) until you say write in the session, has it put open decisions
  in the output as lettered options, and has it write `groom.md` under
  `~/pathwise/.orchestrator/<key in lower case>/` plus a chat summary; the dashboard shows the
  path once the session is done but does not read the file. `POST /api/claude/launch` accepts
  `phase: "groom"`; ticket entries gain `groom: { state, reason }`, `blocks.groom` and
  `goTo.groom` (nothing else in an entry changes), and `launch.json` gains a `groom` record
  that an Investigate launch keeps. The card's icon follows the groom session only for a ticket
  with no workflow record. The groom prompt is a fourth editable prompt, `prompts/groom.md`,
  taking `{KEY}` and `{SLUG}` only; `npm run claude:prompts` now writes four files and the
  Prompts editor lists four (its `{STATUS_FILE}` warning is skipped for a prompt that does not
  take it).
- The built-in investigate prompt now asks the session to give every question lettered options
  (a, b, c) inline in the question text, with a recommended default, and to keep each question
  under 450 characters (the card cuts questions off at 500). The shape of `questions` is
  unchanged. A `prompts/investigate.md` written earlier keeps its own wording: add the
  instruction by hand or reset the prompt.
- The three Claude prompts can now be edited in the app. **Prompts**, at the left of the
  Claude dialog's footer, swaps the dialog body for an editor (**Back**, also at the left,
  returns). Each prompt shows a badge (`default`, `custom` or `unusable file`), a text box, its
  placeholders, **Save**, **Reset to default** (deletes the file), an `Unsaved changes` tag and
  a live warning, which never blocks **Save**, when the text lacks `{STATUS_FILE}`. It edits
  the same `prompts/*.md` files, so hand edits and app edits agree, and a saved prompt applies
  from the next launch or send. New routes, outside the setup gate and behind the same checks
  as the other mutating Claude routes: `GET /api/claude/prompts`,
  `PUT /api/claude/prompts/<name>` (body `{ text }`) and `DELETE /api/claude/prompts/<name>`,
  with `<name>` `investigate`, `implement` or `answers`. A text that is empty, over 20,000
  characters or holding a NUL byte, once trimmed, is `400` `INVALID_PROMPT`, and a file holding
  a NUL byte is unusable (`prompt_unreadable`); a missing `{STATUS_FILE}` is never refused. A
  save or reset the disk refuses is `502` `CLAUDE_FAILED` with `prompt_not_changed`, which the
  editor words. A symlinked `prompts/` folder is read but can be neither saved to nor reset, a
  symlinked prompt file is followed on read, and a folder in a prompt file's place can be
  neither replaced nor removed. Limits: anything that can reach the dashboard port without
  browser headers (a local user, or a container or VM sharing the host's loopback) can change
  the prompts and the settings, the same trust boundary as the settings route; and a prompt of
  control characters can be valid yet too big to save through the 64 KiB body limit (ASCII,
  CJK and emoji at the cap fit). The file rules now live in one module,
  `backend/claude-prompts.mjs`, shared by the launcher and the routes (`npm run claude:prompts`
  keeps its own create-only write). The footer's **Prompts** and **Back** sit on the left in
  every state.
- Every reply the dashboard server sends now carries `X-Frame-Options: DENY` and
  `Content-Security-Policy: frame-ancestors 'none'`, so the dashboard cannot be embedded in an
  iframe (an IDE panel, for example). The policy has no other directive. Only the dashboard
  server sends them: `npm run dev:ui` runs Vite, a separate server, and `vite.config.js` sets
  no such headers, so the pages Vite serves itself are not covered.
- The Claude launch prompts and the message sent with saved answers can now be replaced by
  files: `prompts/investigate.md`, `prompts/implement.md` and `prompts/answers.md` in the
  dashboard folder. A missing file means the built-in text, and `npm run claude:prompts`
  writes the built-in templates there to edit, never overwriting a file. The files are read on
  every launch or send, so an edit applies at once, and they take `{KEY}`, `{SLUG}`,
  `{STATUS_FILE}` (`answers.md` also `{QUESTION_IDS}` and `{CHANGE}`); an unknown `{WORD}` stays
  as written. A file that cannot be used (unreadable, a folder, empty, holding a NUL byte, over
  20,000 characters) is `prompt_unreadable`: a launch is refused with nothing written
  (`CLAUDE_REFUSED`) and a send fails with the answers saved, so the next save retries. The folder is outside `claude/`,
  which launched sessions are given, and is gitignored and dockerignored. The dashboard does
  not check that a custom prompt keeps the `status.json` protocol, so one that drops it leaves
  sessions red and Implement plan locked; delete the file to go back.
- Reworked the Claude dialog layout. It is now two phase rows, each with its run button and
  its own **Go to session** button side by side (they stack at 480px wide and below), and the
  hints sit in a line under the row. Questions are numbered and show a tick (accessible name
  `Answered`) once they have a saved answer. The answers are auto-growing multi-line boxes
  (CSS only, `field-sizing: content`; a browser without it shows a fixed-height box that
  scrolls) with password-manager overlays turned off. **Save answers**, the `N of M answered`
  line and the result of the last save moved into the pinned footer beside **Close**, so Save
  is on screen without scrolling. No behaviour and no `data-testid` changed.
- The Claude dialog now has two **Go to session** buttons, one per phase (named in full,
  `Go to investigate and plan session` and `Go to implement plan session`, for assistive
  tech), each copying the command for its own phase's session
  (`claude attach <id>` for a live or blocked one, a `claude --resume` from `~/pathwise` for a
  finished one) and disabled with `No session to join` when that phase was never launched or
  cannot be joined. The planning session stays reachable after Implement plan has launched,
  which it was not. Breaking for anything reading
  `GET /api/claude/tickets`: `goTo` is now always `{ investigate, implement }`, each
  `{ kind, command }` or `null`, instead of one `{ kind, command }` or `null` for the
  current phase.
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
  plan**, **Implement plan** and a **Go to session** button per phase. Both launches
  start a background `claude --bg` session from `~/pathwise`, named
  `<KEY>-investigate-and-plan` or `<KEY>-implement-plan`; **Go to session** copies
  the command that attaches to or resumes that phase's session.
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
