# Changelog

## Unreleased

- The Slack thread dialog, opened from a My Tickets glyph or a Slack tab row, has a
  "Claude session" section that lists the Claude Code sessions attached to that thread
  and attaches and detaches them on the same watcher as the Watch threads card. Attach
  also puts a thread that is not yet watched on the Watch threads list; detach leaves
  it there. Every thread the server hands the dialog (`GET /api/slack/threads` and
  `GET /api/slack/thread`) now carries `watchKey`, the key the watch list files that
  thread under.
- The Slack watcher's interval now paces only the Slack poll. Each wake step runs on its
  own timer: the stop is due 60 seconds after the notice line and the resume 90 seconds
  after the stop, as design constants. Each session's `delivery` gains `step`, `steps`
  and `nextStepAt`, the watch list gains a top-level `nextCheckAt`, and the new
  `POST /api/slack/watch/check` route runs one poll now behind a Check now button.
- Added a Slack thread watcher. Paste Slack thread links on the Slack tab, attach
  Claude Code sessions to them, and the dashboard server appends a one-line notice to
  each attached session's inbox file when someone else posts in a watched thread;
  a finished session is also resumed. The Watch threads card shows each link's last
  check and each session's delivery status, with pause and resume, an interval of
  30 to 3600 seconds and an editable notice. Host only: without a `.claude`
  directory, as in the Docker image, the watcher is disabled.
- The Slack watcher now wakes an attached idle background session when the notice does
  not: it stops the session with `claude stop` at least 60 seconds after the line and
  resumes the same session id after a 90-second settle gap, never inside it. Busy and
  interactive sessions are never stopped; a session that never lists idle, as one with
  a Monitor armed on its inbox does not, stays `waiting` and ends as `never_idle` 2
  hours after the notice. Delivery gains the `waiting` status and new reason codes
  (shown muted on the Slack tab), a resume that finds the session live now waits
  (`live_at_resume`) instead of failing permanently, no finished session is resumed in
  the first 90 seconds after the server starts, and the session picker reports each
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
