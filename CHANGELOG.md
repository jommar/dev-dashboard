# Changelog

## Unreleased

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
