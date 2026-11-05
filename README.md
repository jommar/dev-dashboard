# EZAT Dev Dashboard

A small dev-service controller. It runs each EZAT service
(Portage Backend / Frontend, TravelTracker API / UI, Queue) as its own
independently-controllable child process, exposes a dark-mode browser dashboard
with per-service **Start/Stop/Restart** buttons, and provides an agent-ready log
tail so debugging can be driven from code.

## Why

`scripts/run.sh` starts every service together in one terminal. This dashboard
gives you the same services but with:

- per-service control (start/stop/restart one without killing the rest)
- **tail-by-default** logs — every surface shows only the last N lines so a
  chatty service doesn't flood a terminal or an agent's context
- an **agent-readable** log path (CLI + files + HTTP) so an agent can read logs,
  spot a crash, drive a restart, and verify — i.e. "heal with debugging"

## Requirements and layout

The dashboard starts, stops and diffs the EZAT service repos, so it expects them
to sit next to it in one folder:

```text
ezat/
├── dev-dashboard/      this repo
├── Portage-backend/
├── Portage-frontend/
├── TravelTracker/
└── .nvmrc              monorepo root Node pin
```

Node.js 24 runs the dashboard itself. Each service runs under the Node version
pinned by its repo's `.nvmrc`, which must be installed through nvm.

## Quick start

```bash
cd dev-dashboard
npm start
# → EZAT Dev Dashboard → http://127.0.0.1:6500
```

Prefer containers? [Run in Docker](#run-in-docker-linux) needs no local Node setup.

For development, use watch mode so the dashboard restarts when server files
change:

```bash
cd dev-dashboard
npm run dev
```

`scripts/start-dashboard.sh` uses `npm run dev` after its setup phase. Install
the dashboard's development dependencies once with `npm install` in
`dev-dashboard` before using that launcher.

Open `http://127.0.0.1:6500`. On a fresh or incomplete installation, only
**Settings** is available: complete GitHub, Jira and local services, then click
**Save settings**. See [Settings and setup](#settings-and-setup) for migration and
validation details. Once setup is ready, the navigation contains:

- **Home** — the overview: sprint progress, KPI tiles, the "needs you" queue and
  a compact service health strip. See [Home](#home). Use its tab or click the
  **EZAT Dev Dashboard** title to return to it.
- **Services** — one card per service, each showing its status and a log
  viewport that tails the last 40 lines (_Show full_ reveals everything).
- **Pull Requests** — your open and draft PRs in separate sections, grouped by ticket.
- **My Tickets** — Jira tickets assigned to you (`assignee = currentUser()`) as a
  kanban board with one column per status, each card carrying your open PRs
  with their CI and review state and any Slack threads, under a header line
  naming the current active sprint. An _include Done_ checkbox controls whether
  Done tickets are shown. See [My Tickets](#my-tickets).
- **Releases** — the tickets of one Jira fix version (the picker defaults to the
  earliest unreleased EZAT version), each with its GitHub PRs, grouped by
  whether the work reached `ops/development`. It opens on your own tickets;
  **All release tickets** widens it. See [Releases](#releases).
- **Slack** — optional. One connect button that captures your own Slack web
  session; nothing else in the app depends on it. See [Slack](#slack).
- **Settings** — saved integrations, token replacements, local services and
  advanced options.

The visible view lives in the URL hash (`#/home`, `#/services`, `#/prs`,
`#/my-tickets`, `#/releases`, `#/slack`, `#/settings`), so a reload — or a link you paste to
yourself — lands where you left off. A bare URL or an unrecognised hash is
canonicalized to Home when ready, or Settings during setup. During setup, deep links, title clicks
and back/forward navigation also resolve to Settings; operational panels and the
service feed are not mounted. Log fetching pauses while Services is hidden.

> The dashboard port (`6500`) and tail line count are configurable in
> [`backend/config.mjs`](backend/config.mjs).

### Run in Docker (Linux)

The container bundles the dashboard, the Node versions the sibling repos pin, and
their dependencies, so nobody has to install Node or run `npm install` in each
repo by hand. It needs Docker Engine with Compose v2.24 or newer and the monorepo
layout: this folder next to `Portage-backend/`, `Portage-frontend/`,
`TravelTracker/` and the monorepo `.nvmrc`.

```bash
cd dev-dashboard
cp .env.example .env     # optional: GH_TOKEN and JIRA_* for first-run setup
docker compose up --build
```

Then open `http://127.0.0.1:6500`. The first start runs `npm ci` in each sibling
repo inside the container, which takes several minutes. Later starts reuse it.

- Stop any host dashboard (`npm start`) first. Only one process can listen on
  port 6500.
- Linux only. The container uses host networking so services reach the host's
  MySQL, Redis and Kafka on `localhost`. Docker Desktop on macOS and Windows runs
  containers in a VM, so this file does not work there as written.
- Settings, saved tokens and logs live in the `dashboard-config` and
  `dashboard-logs` volumes. `docker compose down -v` deletes them, along with
  the dependency volumes.
- Run CLI commands in the container: `docker compose exec dashboard node backend/cli.mjs logs`.
- `docker compose config` prints the `.env` values in plain text. Do not paste its
  output anywhere.
- After changing dashboard code, run `docker compose up --build` again.
- The image pins the Node versions listed in `NODE_PINS` in the Dockerfile. When a
  sibling repo changes its `.nvmrc`, add the version there and rebuild. Until
  then the container refuses to start and names the missing version.
- PR diffs run `git` in the sibling repos and authenticate to GitHub with
  `GH_TOKEN`. SSH remotes do not work inside the container.
- The Slack thread watcher is host only. The image has no `.claude` directory, so
  the watcher reports `disabled` and starts no timer (see [Watch](#watch)).

## Settings and setup

### Saved configuration and credentials

The dashboard persists configuration outside the project:

| Path                                                         | Contents                                                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/dev-dashboard/settings.json`                      | Versioned non-secret settings (`schemaVersion: 1`), revision, migration origin, integration acceptance metadata and the `slackWatch` section |
| `~/.config/dev-dashboard/slack-watch/map.json`               | Watched Slack links and the session ids attached to each; written by the Slack watcher only (see [Watch](#watch))                            |
| `~/.config/dev-dashboard/slack-watch/inbox/<session-id>.log` | One notice line per wake for an attached session; plain text, created and removed by the watcher                                             |
| `~/.config/github/token`                                     | GitHub token                                                                                                                                 |
| `~/.config/jira/token`                                       | Jira API token                                                                                                                               |
| `~/.config/slack/session.json`                               | Slack web-session credentials (`xoxc-` token + `d` cookie), only after you connect Slack                                                     |

Token files use mode `600`; existing regular token files are normalized to that
mode when read. Symlinks and nonregular credential files are rejected. Tokens
are not stored in `settings.json` or returned by the Settings API. The browser
receives only token presence/source indicators.

**Blank token inputs do not mean migration failed.** They are replacement
fields, intentionally never prefilled. **Saved token detected (private file)**
and the **Saved token — leave blank to keep** placeholder mean a token already
exists. Leave the input blank to retain it; enter a value only to replace it.
There is no token-delete control. Replacements are persisted only when the
complete candidate passes validation.

Use Settings to edit the GitHub owner and watched repository names, Jira URL
and email, local root and service rows, and advanced result limit, Jira fields
and minimum PR approvers. GitHub supports one owner and the public API
(`https://api.github.com`); its API URL is read-only in the form. Repository names
are short names under that owner. Service commands are JSON argument arrays,
such as `["npm","run","dev"]`, with no shell expansion. A blank port means no
port. Service directories may be relative to the absolute local root or absolute.

Once `settings.json` exists, it is authoritative: edits to `.env`, exported
integration variables or the defaults in `backend/config.mjs` do not override saved
configuration. An unreadable, malformed or unsupported settings file is not
silently overwritten or backfilled; setup stays closed for repair. Host, dashboard
port, tail count and log-buffer limits remain runtime constants in `backend/config.mjs`.

### Fresh setup and validation

All integrations are required, even for service-only usage. Readiness requires
GitHub repositories and a readable nonblank token; Jira URL, email, token and
valid sprint/points fields; and at least one valid local service with a readable
root/directory and resolvable executable/runtime. Service IDs must be unique and
safe, labels and command arguments nonblank, and numeric ports unique within
`1–65535`. The result limit is `1–100`, and the approval count is a positive safe
integer. Missing `node_modules` remains a start-time warning; optional local PR
diff checkouts are not setup prerequisites.

Click **Save settings** to validate edited configuration and persist it. New or
changed integrations require successful authenticated probes: GitHub user,
each repository and GraphQL repository access; Jira user, a small issue search,
and metadata identifying the configured sprint field and numeric points field.
Empty PR/ticket lists and no active sprint are valid results. Unchanged accepted
integrations retain their acceptance for local-service or approval-count edits.

**Check saved connections** checks the saved configuration, not unsaved form
edits. Confirmed authentication/access/configuration failures revoke acceptance
and close setup. Transient outages (timeouts, DNS errors, rate limiting or server
errors) cannot make a new integration ready, but previously accepted unchanged
integrations retain readiness across revalidation and restart, with degraded
connection status shown separately. Ordinary panel-fetch failures can still
degrade data without automatically running these connection checks.

The browser sends the displayed revision with a connection check and adopts the
returned revision, so a subsequent save uses the updated revision. If readiness
stays unchanged, unsaved edits are retained, including after a degraded check.
If a check restores or revokes readiness, the browser reloads at `#/settings`
to mount the appropriate navigation. Successful recovery reconciles the saved
local service definitions before opening the gate; it does not start services.

Invalid edits to a ready installation are rejected, preserving active settings.
An incomplete installation can save a non-secret draft and remain in Settings;
replacement tokens require a complete accepted candidate. A successful save
reloads the page. A revision conflict retains your form edits: reload to inspect
the latest revision before saving again.

Settings validation/save does not start, stop or restart services, free their
ports or clear logs. Unchanged running services retain their processes and logs;
additions and stopped-service edits/removals are supported. Changing or removing
a running/pending service, including its label, returns `SERVICE_IN_USE`.
Root changes also conflict if they change a live service's resolved directory or
runtime. Stop affected services through their normal controls before editing.
Revoking readiness does not stop existing children; normal dashboard shutdown
still owns their cleanup.

### Automatic legacy migration

When the settings file is absent, initialization seeds defaults and detects
legacy evidence: an existing dashboard `.env`, effective integration/approval
environment values, or nonblank preexisting token files. Static defaults and local
directories alone do not count. Without evidence, this is fresh setup; partial
legacy configuration remains a draft until completed.

Migration imports `GH_TOKEN`, falling back to `GITHUB_TOKEN`, and
`JIRA_TOKEN`, falling back to `JIRA_API_TOKEN`, only when the corresponding token
file is absent. The first nonblank Jira alias wins, preserving the legacy
production `JIRA_TOKEN` precedence. Existing token files win, even if empty or
invalid. Exported environment values take precedence over the same key in the
legacy `.env`.
Jira URL/email/custom-field overrides and `MIN_PR_APPROVER` are imported along
with default GitHub/local definitions. The legacy `.env` is left untouched.

A fully locally valid legacy configuration is grandfathered ready without remote
probes and displays **Migrated; connection not yet verified**. This is not proof
of current authentication; use **Check saved connections** to confirm access.
Newly supplied environment values/token files also count as legacy evidence;
there is no installation-age detection. Fresh and partial initialization persist
a settings record so later environment changes do not re-seed configuration.

On initialization of an existing `origin: legacy` record, missing token files
can still be recovered from the legacy environment using the same precedence:
`JIRA_TOKEN` first, then `JIRA_API_TOKEN` if blank or absent. Existing files are
never replaced by this recovery. For a revision-1 record
with no integration acceptance entries yet, recovery can restore grandfathered acceptance
if the whole configuration becomes locally valid. Recovery on other revisions
does not itself grant new acceptance; check/save settings when required.

### Setup gate and APIs

Until ready, operational HTTP APIs (services, logs, controls, events, PRs,
tickets, releases and diff) return `409 SETUP_REQUIRED` before doing their work.
The page, static assets and these setup endpoints remain available:

| Endpoint                      | Contract                                                                                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/config`             | Tail count, derived Jira browse URL and `setup` (readiness, errors, revision, origin, connection status)                                                                                                                                                             |
| `GET /api/settings`           | Editable saved settings, revision, token presence/source and setup status; no tokens                                                                                                                                                                                 |
| `PUT /api/settings`           | Full editable configuration plus `expectedRevision`; optional `credentials.githubToken` / `credentials.jiraToken`; omitted/blank replacements retain saved tokens                                                                                                    |
| `POST /api/settings/validate` | JSON object body with optional `expectedRevision` (sent by the browser); stale revisions return `409 REVISION_CONFLICT` before probes. Revalidates saved settings and returns public state with the current revision; `setup`/connection errors determine the result |

JSON bodies are limited to 64 KiB. Saves return `409 REVISION_CONFLICT` or
`409 SERVICE_IN_USE` for conflicts, `422` for invalid fields/confirmed probe
failures, and `503 VALIDATION_UNAVAILABLE` for unavailable validation
(`PERSISTENCE_FAILED` for write failures). Malformed JSON returns `400` and
oversized bodies `413`. Responses use sanitized errors. A setup revocation
closes existing SSE streams with a `setup-required` event; the browser returns
to Settings on that event or an operational `SETUP_REQUIRED` response.

### Slack watch settings

The Slack watcher has three settings, kept in a `slackWatch` section of
`settings.json`. They are edited on the Slack tab's **Watch threads** card (and
through the `/api/slack/watch` routes), not in the Settings panel:

| Field             | Meaning                         | Valid values                                                                                                                                                   |
| ----------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intervalSeconds` | Polling period                  | A whole number from 30 to 3600; default 180                                                                                                                    |
| `noticeTemplate`  | Text of the line a session gets | One line of at most 200 characters with no control characters; default `There's a new message on {link}`; `{link}` is the only placeholder and may be left out |
| `paused`          | The global pause                | `true` or `false`; default `false`; changed only by the pause and resume routes                                                                                |

A record without the section reads as these defaults, and so does a stored value that
fails these rules (for example in a hand-edited file). An invalid value is refused with
`422 INVALID_SETTINGS` and `slackWatch.<field>` errors, and nothing is written.

The section is saved by its own narrow path, outside the setup gate. It validates only
the three fields (a partial save keeps the stored values it does not mention) and
writes `settings.json` atomically through the same staging helper as a normal save.
It leaves the `revision`, the validation state, credentials, services and readiness
alone, publishes no setup change and never touches running services. Because the
revision does not move, this path takes no `expectedRevision`. It instead compares
the revision in the file on disk with the one the server loaded, and answers
`409 REVISION_CONFLICT` when they differ or the file cannot be read. The server reads
the file once at startup, so after the file is edited outside the dashboard the
conflict stays until the server restarts. It answers `503 PERSISTENCE_FAILED` when
no settings record is loaded, such as after an unreadable or malformed file.

An ordinary Settings save, validation or connection check carries the section over
unchanged. A build from before this feature ignores the section and drops it on its
next Settings save.

### Rollback

For a user-managed code rollback, stop the dashboard and retain the external
settings/token files and untouched legacy `.env`. Older code uses its legacy
environment/defaults; Settings-only changes are not back-written to `.env`, so
older versions will not automatically use those edits. There is no automatic
settings reset or credential deletion.

## CLI

```bash
cd dev-dashboard

npm run logs    -- legacy --lines 40      # tail a service's recent logs
npm run restart -- legacy                  # restart one service
npm run restart -- --all                   # restart all
npm run stop    -- fe                      # stop one
npm run start:svc -- queue                 # start one service
node backend/cli.mjs status                        # list services and status
node backend/cli.mjs prs                           # list your open PRs
node backend/cli.mjs my-tickets [--include-done] [--json]
                                                   # list Jira tickets assigned to you
node backend/cli.mjs releases [--version <id|name>] [--all] [--json]
                                                   # list a Jira fix version's tickets and
                                                   # whether their PRs merged
node backend/cli.mjs team-velocity [--sprints N] [--out PATH]
                                                   # rebuild team-velocity.html (whole-team
                                                   # sprint velocity, last 8 sprints)
```

> `npm start` runs the **dashboard server** — the npm script for starting a
> single service is `start:svc`. `status`, `prs`, `my-tickets`, `releases`, and
> `team-velocity` have no npm script; run them through `backend/cli.mjs` directly
> (`node backend/cli.mjs --help` lists every command).

The CLI reads live logs from the dashboard over HTTP when it is running (so
`logs` shows the real captured output). If the dashboard is down, control
commands run their own manager in-process.

Every operational command first checks setup, including direct GitHub/Jira
commands and offline service controls. If the dashboard reports `SETUP_REQUIRED`
or the persisted setup is unready, the command exits nonzero with a Settings
diagnostic instead of falling back. Ready offline fallback uses saved service IDs
and configuration; `node backend/cli.mjs --help` works before setup.

## Agent interface

An agent can read the same logs three ways:

1. **CLI** — `npm run logs -- <id> --lines 40`
2. **Files** — rolling tail written to `logs/<id>/out.log` (gitignored)
3. **HTTP**
   - `GET /api/logs/:id?lines=N`
   - `GET /api/services`
   - `POST /api/services/:id/{start|stop|restart}`
   - `GET /api/events` (SSE live status)
   - `GET /api/prs`
   - `GET /api/my-tickets?includeDone=0|1`
   - `GET /api/ticket-prs` (your open PRs keyed by ticket, with review and CI state; see [My Tickets](#my-tickets))
   - `GET /api/releases?version=<id>&scope=mine|all&refresh=1` (see [Releases](#releases))
   - `GET /api/config` and the [Settings APIs](#setup-gate-and-apis)

## Home

The landing view, and the one screen meant to answer _"what should I be doing
right now?"_. Reach it through the Home tab or page title once setup is ready;
it is where a bare URL or an unknown hash lands in ready mode.

Home adds **no new endpoints and no new upstream calls**. It composes
[`/api/prs`](#open-prs), `/api/my-tickets` and the `/api/events` service stream,
all of which the other tabs already use.

**KPI tiles** — Open PRs · Needs review · My tickets in sprint · Done this
sprint. Each tile links to the tab that explains it. A tile shows `—` rather
than `0` when the number is genuinely unknown (integration data or review data
unavailable) — hover it for the reason.

**Sprint** — the selected sprint, with its date range, days remaining and
a stacked bar of your tickets in that sprint by status category. A selector
lists every sprint found on your fetched tickets (active first, then future,
then closed most-recent-first), defaulting to the active sprint; KPIs stay
active-scoped regardless of the selection. Tickets are
scoped by their whole `sprints` list, not just the sprint shown on the row, so a
ticket carried into a later sprint still counts toward the active one. A
previous sprint is a floor, not a total: the ticket query is capped and
assigned-to-me only, so the existing "totals may be incomplete" warning applies
to old sprints too.

The bar is weighted by **story points**, not ticket count, because the two
disagree in the direction that matters: a sprint reading 21 of 27 tickets done
(78%) can be 91 of 108 points done (84%), and it is the second figure that gets
quoted at sprint review. Ticket counts stay in the legend beside the points, so
nothing is lost.

Click any legend item to **expand the tickets behind it** in place — key,
summary, status, type and its points, linked to Jira. Bands expand
independently and stay open across refreshes; the rows are Home's own compact
ticket rows (`WorkTicketRow`), not the cards the [My Tickets](#my-tickets) board uses.

Two honesty rules, because a progress bar is easy to lie with:

- A ticket with no estimate adds no width, so it would silently vanish. The
  count is stated next to the total (`3 unestimated`) and is itself a fourth
  drill-down — the useful thing to do with that number is go and estimate them.
- If **nothing** in the sprint is estimated, a points bar would render three
  empty bands and read as "no work". The bar falls back to counting tickets and
  labels itself `no estimates`; no `pts` figure is shown at all.

**Needs you** — one merged queue, most urgent first, each group labelled with
why it is listed:

1. your PRs with changes requested
2. teammates waiting on a review
3. your PRs still waiting on approval
4. your tickets in progress

Groups 1-3 mean somebody is waiting; group 4 is your own current work, so it
reads last. Rows within a group are stalest-first — the longest-ignored item is
the one actually blocking. The queue is capped at 12 rows, spent in group order
so the most urgent rows are never the ones dropped, with an `N more not shown`
line for the remainder. PR rows are rendered by the same `prItemHtml` the Pull
Requests tab uses, so the two views cannot drift.

**Services** — one line per service: status pill, port link, and a Start/Stop
button. No log viewport. It is fed entirely by the `/api/events` stream, which
pushes a full snapshot on connect, so the strip costs no extra request. The page
opens **one** `EventSource` in `app.js` and fans it out to every panel that
shows service state, rather than one connection per panel.

Home refreshes on the same 90s cadence as the other data tabs, with the same
discipline: one 1s ticker drives both the countdown and the refresh, polling
pauses while the view is hidden or the page is backgrounded, and each region is
diffed so a silent tick never disturbs scroll or focus. GitHub and Jira are
loaded independently — an ordinary fetch failure degrades only its own
sections, and the meta line says `some data stale` rather than blanking the
page.

### Two honest caveats

- **"Needs review" is not "review requested from you."** GitHub's requested
  reviewers are never fetched ([`backend/review.mjs`](backend/review.mjs) asks only for
  submitted reviews), so that is not knowable without a new call. The tile and
  queue group mean: _open PRs by other people, under the approval threshold,
  that you have not reviewed yet_ — drafts excluded.
- **Home asks for `includeDone=1`**, because the default my-tickets query drops
  Done tickets and sprint progress needs them. That shares the
  `MY_TICKETS_MAX_ISSUES` cap of 200. The JQL sorts by `updated DESC` for this
  reason: it used to sort by status name, which meant truncation dropped To Do
  first (`Done` < `In Progress` < `To Do`) and biased every total toward
  "finished". Nothing downstream depends on that order — `groupTicketsByStatus`
  re-sorts every group — so the sort only decides what is lost, and stalest is
  the honest thing to lose. If the cap is hit, `/api/my-tickets` returns
  `truncated: true` and the Sprint block says its totals may be incomplete
  rather than reporting a confident, wrong number.

The derivation behind all of the above — the counting, the point summing, the
sprint scoping and the urgency ordering — lives in
[`ui/home-data.js`](ui/home-data.js), which is DOM-free precisely so it can be
tested: see [`test/home-data.test.mjs`](test/home-data.test.mjs). The sprint
bar's arithmetic and its honesty rules are pinned separately in
[`test/home-cards.test.mjs`](test/home-cards.test.mjs), since a bar that is
wrong by a few percent looks entirely plausible.

## Open PRs

### Local work filters

Pull Requests has **Search**, **Section**, **Repository** and **Review state**
filters across open, draft, approval and merge-candidate sections. Missing or
unavailable review summaries are **Unknown**, separate from awaiting review.
My Tickets has **Search**, **Status**, **Sprint**, **Priority** and **Type**;
sprint membership includes a ticket's full sprint history, using IDs when available.
Home's Needs You block has **Search** and **Action type**, applied before its
12-row cap. Home's Sprint **Search** and **Status** affect only expanded ticket
lists; progress, points, KPIs and sprint history retain their full-data totals.

Search is immediate, case-insensitive and literal (punctuation is not a regular
expression). Search and dropdowns combine with AND over already fetched data,
without extra requests or changing server eligibility. Counts show matching
versus fetched items (unique PRs across groups); an empty filtered list says
**No matches**. Fetch-cap and stale-data warnings still apply. **Include Done**
remains the separate remote-scope control.

**Clear filters** resets only its own view or Home block. Each set of filters
survives tab switches, refreshes and reloads in versioned browser localStorage
(`dev-dashboard.work-filters`). Malformed or unsupported saved state falls back
to defaults; blocked/full storage leaves filtering usable in memory. A selected
option missing from refreshed data stays selected until cleared, so it cannot
silently broaden the list. Filters are browser-local and are not shared in URLs.

The dashboard shows the authenticated GitHub user's open pull requests across
the watched repos saved in Settings (defaulting to `TransActComm`'s
`Portage-backend`, `Portage-frontend`, `TravelTracker`) —
as **masonry cards grouped by ticket** on the dashboard, and via
`node backend/cli.mjs prs` / `GET /api/prs`. Cards show the PR title, owner, its status
(`draft`/`open`), the repo `#number`, and how long ago it was last updated,
sorted newest-first within each ticket group.

**Your open PRs** shows non-draft PRs. A ticket group only shows here while its
Jira status is **Code Review**;
groups whose ticket has moved to another status are hidden from this section
(they may still appear elsewhere, e.g. under "needing approval" once ready for
review). PRs with no linked ticket (`Unticketed`) are always shown regardless
of status — there is no status to filter them on. If Jira status fetching fails,
ticketed groups cannot be matched and only `Unticketed` PRs remain here.

**Your draft PRs** shows your drafts in a separate section, independent of Jira
status. Drafts are moved out of the visible **Your open PRs** section and grouped
by their first linked ticket or `Unticketed`, newest-first within each group.
Cards have an amber tint and rail, explicit `draft` badges, counts and the same
diff action. Drafts remain visible when Jira metadata is unavailable; a GitHub
failure makes the draft section unavailable.

Ticket-group headers in every PR section — open, draft, needing approval and
merge candidates to `ops/development` — show an optional sprint pill. Selection
matches My Tickets: active → future → most recent closed, with the same sprint
state styling and date tooltip. The pill is omitted when sprint data is
unavailable or the group is `Unticketed`.

Configure the GitHub owner, repositories and token through **Settings**. Missing
credentials close the all-integrations setup gate; environment tokens are
supported for [legacy migration](#automatic-legacy-migration).

While the Pull Requests tab is active, the panel auto-refreshes every 90
seconds with a silent background update (cards stay visible until the new
payload arrives, and the DOM is only touched when something changed). Polling
pauses when the tab is hidden or the page is backgrounded, and a countdown in
the heading shows the time to the next refresh. A `Refresh` button forces an
immediate reload.

### PR merge candidates to ops/development

Below the approval section, a "PR merge candidates to ops/development" list
shows your Jira tickets in **Promote to UAT** status whose linked PR (matched
by ticket key, same grouping as above) is still open and targets
`ops/development` — i.e. ready to merge now that the ticket reached
Promote-to-UAT. Uses the saved GitHub and Jira connections; a fetch failure can
make this section unavailable while the rest of the PR tab remains usable.

## My Tickets

The dashboard shows Jira tickets assigned to you (`assignee = currentUser()`
in JQL) as a **kanban board**: one column per Jira status among your tickets,
with the most recently updated ticket first in each column. Available in the
**My Tickets** tab, via `node backend/cli.mjs my-tickets` / `GET /api/my-tickets`.
Each card also carries your open PRs with their CI and review state, and any
Slack threads for the ticket.

**Columns** — left to right in workflow order, in four bands. Attention statuses
(`Blocked`, `Impediment`, `Rejected`, `Active Incident`, `CS Escalation`) come
first so blocked work shows without scrolling, then queued statuses (`To Do`,
`Backlog`, …), then active ones (`In Progress`, `Code Review`, `Ready For
Testing`, …), then done ones. Inside a band the known statuses keep their
workflow order. A status the dashboard does not know goes after the known ones
of its band, A→Z; its band is the one Jira's status category implies (`To Do`
queued, `Done` done, anything else active). A status with no tickets has no
column. A column's header shows the status name and a count, over a 2px rule
coloured by the status colour mapping under [Ticket status](#ticket-status). The
order lives in [`ui/ticket-board.js`](ui/ticket-board.js), which is DOM-free and
pinned by [`test/ticket-board.test.mjs`](test/ticket-board.test.mjs).

**Cards** — the Jira key (a link that opens Jira in a new tab), a priority mark
(chevrons or bars; the priority's name is its tooltip and accessible name), story
points (`5 pt`, absent when unestimated), time since the last update, and the
[Slack chips](#slack-threads) at the right end. Below are the summary, clamped to
two lines with the full text in its tooltip, and one line per open PR. The status
and the issue type are not on the card: the column names the status, and Type
stays a filter.

**PR lines** — one link per PR, opening it in a new tab: a CI glyph, `repo #number`
(the repository name without its owner), the review state in words and a `Draft`
tag for a draft. The glyph differs in shape as well as colour: a check for passing
CI, a cross for failing, an open ring for pending and a dash for no checks or
unreadable ones. Hover a line for the CI summary, for example `CI failing: lint,
unit-tests (2 of 9 failed)` (at most three failing checks are named); the same
text is in the line's accessible name. The review state reads `approved`,
`changes requested` or `awaiting`, and `review unknown` when it could not be read.
A ticket with two open PRs shows two lines, a PR whose title names two tickets
shows on both cards, and a ticket without a PR shows none.

**PR data** — the lines come from `GET /api/ticket-prs`, which the tab calls on its
first load, on every 90 second poll and on **Refresh**. It lists **your** open PRs
(authored by the GitHub user the saved token belongs to) in the watched
repositories from Settings, drafts included and whatever their ticket's Jira status, unlike the Open PRs section,
which keeps only Code Review groups. A PR is filed under every ticket key in its
title (`[TAP-1665]`, bare `PRT-1221`): `TRIPS-n` keys are filed under `TAP-n`,
any other project's key as written, and a PR whose title has no ticket key is
left out (the Pull Requests tab still lists it). A key repeated in one title
counts once, and each key's list is newest update first. Only the newest PRs up
to **GitHub maximum results** (1 to 100) in Settings are fetched; `truncated`
says there were more, and the tab then notes that some tickets may show no PR
lines.

```
200 { available, login, total, truncated, updatedAt,
      byTicket: { "<KEY>": [{ repo, number, title, url, draft, updatedAt,
                              review, ci }] } }

review: { state: 'approved' | 'changes_requested' | 'awaiting', approvals } | null
ci:     { state: 'passing' | 'failing' | 'pending' | 'none',
          passed, failed, pending, failing: [name, …] } | null
```

`login` is the GitHub user, `total` GitHub's count of matching open PRs and
`updatedAt` the time the server answered; `repo` is `owner/name`. `review.state`
is the newest approval or change request on the PR, the same rule as
[Review status](#review-status) (an approval after a change request wins), and
`awaiting` when there is neither; `approvals` counts the reviewers whose latest
review approves. `ci.state` summarises the PR's latest commit: `passing` for a
success, `failing` for a failure or error, `pending` for pending, expected or any
state the dashboard does not recognise, and `none` when the commit has no checks.
`passed`, `failed` and `pending` count the first 100 checks and commit statuses,
and `failing` names the failed ones, each name once. A `null` `review` or `ci`
means GitHub's answer was unreadable, which is different from `awaiting` or
`none`; the card shows `review unknown` or a dash with `CI status unavailable`.

The route is behind the [setup gate](#setup-gate-and-apis): `409 SETUP_REQUIRED`
before setup, and `200` after it whatever GitHub does. A GitHub problem never
becomes an error, it only narrows what the answer reports: with no token, or
when GitHub fails `/user` or the search, the answer is `{ available: false,
login: null, total: 0, truncated: false, byTicket: {} }` plus `updatedAt`; when
one GraphQL batch of up to 50 PRs fails, those PRs are listed with
`review: null, ci: null` and the other batches are unaffected; when GitHub
reports an error on one PR's checks, that PR gets `ci: null` and keeps its
review. A token that cannot read checks and commit statuses is expected to show
up that way, as CI unknown on each PR while reviews still work; how GitHub
reports a refused field has not been checked against the live API, and Settings
validation does not probe for it. A poll costs one `GET /user`, one search and
one GraphQL request per 50 PRs, sent one after another; each call times out
after 15 seconds, and a timeout counts as that call failing. Requests made
while a load is running, with the same saved settings revision, share that
load. Nothing is cached: once it finishes the result is dropped, so the next
poll or **Refresh** asks GitHub again. The answer carries no tokens, no
upstream error text and no settings. There is no CLI command for it: `prs` and
`my-tickets` call their modules directly, so an agent reads this route over
HTTP.

The tab never waits on it. The cards render as soon as `/api/my-tickets`
answers, and PR lines fill in when the PR answer arrives. They load on the first
load, on every 90 second poll and on **Refresh**, but not when **Include Done**
is toggled: that changes which tickets come back, not which of your PRs are open,
so the lines already loaded stay. If a later PR refresh fails, the lines from the
last good answer stay and a note says so; if none has ever loaded, the tickets show without PR lines and say `PR status
unavailable`. A slow or failing PR route never shows the ticket error state. The
GitHub reads are in [`backend/ticket-prs.mjs`](backend/ticket-prs.mjs), and the
board's `data-testid` names are pinned by `e2e/my-tickets-board.spec.js`; treat
them as a contract.

**Filters and layout** — the filters are the ones under
[Local work filters](#local-work-filters) and apply to the board, so a Status
filter leaves one column and a column with no matching ticket disappears. Below
600px the toolbar folds Status, Sprint, Priority, Type and Clear behind a
**Filters** button beside Search (it says `N active` while any is set).
The board scrolls sideways inside itself and the page never does: columns are
280px wide, or 82% of the viewport below 600px so the next column peeks in and
snaps into place. Each column scrolls down on its own with its header in view,
and the board fills the rest of the viewport under the toolbar. The board's
sideways position and each column's scroll position survive a refresh, and the
board is keyboard-focusable (arrow keys scroll it).

### Slack threads

A ticket whose key heads a thread you started in `#ezat_claudio` gets a small
Slack chip at the right end of its card's top line — one per matching thread,
newest activity first. The chip is a speech bubble with the thread's reply count
beside it, and a filled dot when the thread needs a reply (its accessible name
says so in words). Clicking it opens a dialog with the full conversation: every
message in Slack order, rendered from its own mrkdwn, plus **Copy link** and
**Open in Slack** actions.
Only the thread's subject line is consulted, so the key must start it. Old
`TRIPS-NNNN` threads match `TAP-NNNN` because Jira's rename carried the numbers
over. The chips reuse the Slack tab's cached thread list, so they simply do not
appear — never an error — when Slack is not connected. The dialog also has a
**Claude session** section that attaches and detaches Claude Code sessions for the
thread on the [watcher](#watch).

### Sprints

A ticket carried across sprints shows the most relevant one (active → future →
last closed); the full list is in `sprints` on the JSON payload. The sprint pill
(accent-colored for the **active** sprint, dashed for a **future** one, struck
through when the ticket has only been in **closed** sprints) is on the Pull
Requests tab's ticket group headers; a My Tickets card has no pill and prints
the sprint's name in muted text under its summary only when the ticket is not in
a current sprint (nothing for a backlog ticket).

A ticket in one of the current **active** sprints gets an accent rail on its
card's left edge (`data-in-current-sprint`) and visually hidden text `In current
sprint`, so the current sprint's work reads as a scan rather than a read of
every card. A Done ticket can still belong to the active sprint. The rail is an
inset box-shadow rather than a border, so the 2px does not shift the card's
content out of alignment with the cards beside it.

In the toolbar, a header line names the **current active sprint** with its
dates and days remaining (e.g. `Nexus Sprint 17 · Aug 24 – Sep 6 · 2 days
left`), on one line that is cut off at the end when it does not fit. It is
derived from the sprint field of your own tickets rather than
from a board — no extra Jira call — so if none of your tickets are in the
active sprint it reads `No active sprint among your tickets`, and if your
tickets span several boards every active sprint is listed.

Sprint is a Greenhopper custom field whose id is instance-specific
(`customfield_10020` on `pathwise.atlassian.net`). Edit **Jira sprint field** in
Settings to override it. New/changed connections must pass field metadata checks;
at rendering time, absent sprint data means the ticket has no sprint (a sprint
pill reads `No sprint`; a My Tickets card shows no sprint name).

Story points are likewise instance-specific, and worth checking rather than
assuming: this instance uses `customfield_10058` ("Story Points") and leaves
the Jira Cloud default `customfield_10016` ("Story point estimate") empty on
every issue, so the usual default would quietly report zero everywhere. Edit
**Jira points field** in Settings to override it. List candidates for your instance
with `GET /rest/api/3/field` and check which one is actually populated. A
missing or wrong id degrades to "unestimated" — never to `0`, which is a real
estimate the code keeps distinct from "nobody estimated this".

While the My Tickets tab is active, the panel auto-refreshes every 90 seconds
with the same silent-background-update behavior as Pull Requests (countdown,
`Refresh` button, polling pauses while hidden). Pass `?includeDone=1`
(or tick _include Done_ / `node backend/cli.mjs my-tickets --include-done`) to keep
Done tickets; the default hides `statusCategory = Done`. Missing Jira credentials
close the setup gate and direct operational APIs return `409 SETUP_REQUIRED`.

### Review status

Each PR card also shows its review state via a small badge in the meta row —
`approved` (green), `changes requested` (red), or `awaiting review` (muted,
dashed). Hover a badge for a tooltip naming who approved / requested changes.

Review state comes from batched GitHub **GraphQL** requests
(`backend/review.mjs`), and reflects the **latest** review: an approval that followed an
earlier change request wins. If the token cannot read review data, the dashboard
can omit the badge when a runtime review fetch fails — open PRs are unaffected.
Fresh/changed integration setup also requires the GraphQL access probe.

### Approval threshold

The Pull Requests view also includes a section for open PRs that have fewer than
the configured number of distinct approved reviewers. Configure **Minimum PR
approvers** in Settings (defaults to `1`). Legacy `MIN_PR_APPROVER` is imported
during migration.

The comparison is strict, so a PR with exactly the configured number of approvals
is not listed. Each reviewer counts once, and only that reviewer's latest actionable
review counts — a later `CHANGES_REQUESTED` review removes an earlier approval.
Settings rejects invalid, zero, negative, fractional and non-integer values;
invalid legacy environment values use the default of `1` during migration.

This is a separate open-PR view that excludes your own PRs, not a second filter
of your own PRs. It is
grouped by ticket and rendered as masonry cards using the same responsive layout
as the Open PRs section.
The same filtered data is available from `GET /api/prs` in
`approvalThreshold`, `reviewDataAvailable`, `prsNeedingApprovals`, and
`approvalGroups`. The CLI prints the grouped section with `node backend/cli.mjs prs`.
When GitHub review data cannot be loaded, the normal open PR list remains
available and the approval section is reported as unavailable rather than
treating every PR as having zero approvals.

On top of the approval-count filter, a ticket group only shows here while its
Jira status is **Ready For Code Review** — same `Unticketed`-exempt,
Jira-status-unavailable-hides-ticketed-groups rules as the Open PRs section above.

### Ticket status

Each ticket group heading also shows the ticket's current Jira status using the
saved Jira connection. Configure the URL, email, token and custom fields through
Settings. Legacy Jira environment keys are imported as described under
[Automatic legacy migration](#automatic-legacy-migration). A failed status fetch
can omit status data; incomplete Jira setup restricts the whole UI to Settings.

The ticket status pill (and the card's side rail) is color-coded by status
kind — all site statuses are mapped in `ui/components/pr-card.js`:

| Kind      | Color         | Statuses                                                                                                                                                                                                                                                                                                |
| --------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued    | muted         | `To Do`, `Open`, `Backlog`, `Selected for Development`, `Parking lot`, `Needs Definition`, `Needs Grooming`, `Asynchronous Grooming`, `Assigned`, `Scheduled`, `Ready For Scheduling`, `Discovery`, `Duplicate`                                                                                         |
| Active    | accent (blue) | `In Progress`, `Work in progress`, `Pending`, `In Development`, `In Review`, `Ready For Code Review`, `Ready For Testing`, `Testing In Progress`, `Testing`, `QA`, `Awaiting Merge`, `Stakeholder Sign Off`, `Promote to UAT`, `Delivery`, `Ready for delivery`, `Impact`, `In Remediation`, `Reopened` |
| Done      | green         | `Done`, `Complete`, `Deployed`, `Closed`, `Resolved`, `Remediated`, `Hardening in UAT`, `Ready For Deployment`                                                                                                                                                                                          |
| Attention | red           | `Blocked`, `Impediment`, `Rejected`, `Active Incident`, `CS Escalation`                                                                                                                                                                                                                                 |

Matching is case-insensitive; any unmapped status falls back to muted. Note
that Jira files several review/test gates (e.g. `Ready For Code Review`,
`Ready For Testing`, `Awaiting Merge`) under its "To Do" category, but they
are mapped to active here since they are late-stage gates, not untouched
backlog.

## Releases

The **Releases** tab answers _"did the work in this release reach
`ops/development`?"_. A release is a Jira **fix version** of the `TAP`
project. For every ticket in the chosen version it lists the GitHub PRs linked
to that ticket and rolls them up into one merge state, with the tickets that
still need attention first. It is available in the **Releases** tab, via
`node backend/cli.mjs releases` and `GET /api/releases`.

Everything is read from Jira: the project's versions, a JQL search for the
version's tickets (`fixVersion = <id>`, plus `assignee = currentUser()` for
Mine) and Jira's development-status (`dev-status`) endpoints for each ticket's
PRs. **No GitHub call is made and no GitHub token is read.** Within each
merge-state group the ticket cards are masonry-packed like the PR sections. The
shared [local work filters](#local-work-filters) are not mounted on this tab.

### Version picker

The picker lists unreleased versions first, by release date (undated last),
then up to 20 released versions, newest first; archived versions never appear.
Names are shown as Jira has them (`EZAT | Sprint N | date`,
`AS | Sprint N | date`), and the payload tags each with a `family` of `EZAT`,
`AS` or `Other`. The default is the earliest unreleased **EZAT** version, else
the earliest unreleased version, else the newest released one.

Choosing a version saves its id in browser localStorage under
`dev-dashboard.releases`, so the next visit asks for that version first. Only an
explicit choice is saved, and only the id: if the server rejects the saved
version (Jira no longer lists it), the tab clears it and loads the default.
**Scope is never saved** — the tab always opens on **Mine**, your assigned
tickets; tick **All release tickets** for every assignee. The version is not
kept in the URL hash, which holds only the tab.

### Merge rule

A PR counts as **merged** only when Jira reports it `MERGED` into
`ops/development` from a source branch that is not an `ops/*` branch — a
promotion PR carrying one ops branch into another is not the ticket's own work.
A PR merged into any other base still shows as merged, with its base flagged,
but does not count. **Declined** PRs are shown muted and ignored. A status other
than open, merged or declined shows as `unknown` and does not count.

A ticket's state is rolled up from its PRs, leaving declined ones out:

| State         | When                                                                |
| ------------- | ------------------------------------------------------------------- |
| `merged`      | every PR counts as merged                                           |
| `partial`     | some PRs count as merged and some do not                            |
| `open`        | no PR counts as merged (open, unknown, or merged into another base) |
| `no-pr`       | no PR is linked, or every PR was declined                           |
| `unavailable` | looking up this ticket's PRs failed                                 |

Groups are shown in the order open, partial, no PR, unavailable, merged, so
what still needs attention reads first. There is **no draft state**: Jira's
dev-status carries no draft flag, so a draft PR reads as open.

### Which PRs belong to a ticket

Dev-status returns every PR in the ticket's repositories, including release
promotion PRs (titled like `[MERGE] DEV → QA`) and PRs that belong to other
tickets. A PR is kept only when the ticket key appears as a whole token, ignoring
case, in its title or its source branch: a key followed by more digits, or
preceded by more letters or digits, is a different ticket. A PR naming several
keys belongs to each of them. PRs with the same URL are shown once, and a URL
that is not a plain GitHub pull-request address is shown as text without a link.

### What the tab can and cannot tell you

- **Merge state can lag.** "Merged" is Jira's copy of GitHub's state, not a live
  GitHub answer, and can trail a fresh merge by a few minutes. The tab says so
  under its heading.
- **dev-status is an undocumented Jira endpoint** (`/rest/dev-status/latest/…`),
  so Atlassian can change it without notice.
- **The instance key trap.** Dev-status needs the full instance key of Jira's
  GitHub integration; `applicationType=GitHub` answers 200 with nothing. The key
  is discovered from a ticket's summary and remembered per Jira URL for the
  process. If Jira says a ticket has PRs but the detail comes back empty, the
  affected tickets are marked `unavailable` with the reason `instance-mismatch`
  and a banner points at the integration — the tab never shows "no PRs" in that
  case, and Refresh does not fix it. A remembered key that suddenly returns
  nothing is re-discovered before "no PRs" is trusted.
- **Truncation is shown.** A version with more than 100 matching tickets shows
  the first 100 by key, with a "totals may be incomplete" warning; the payload
  sets `truncated`.
- **A failed lookup stays local.** A timeout or HTTP error marks only that
  ticket `unavailable` (`prsError` is `timeout`, `http` or `instance-mismatch`);
  the other cards render and a banner counts the unavailable ones. Failures are
  never cached, so Refresh retries them. If the versions or search call itself
  fails, the tab keeps the cards already shown and says _Refresh failed —
  showing last update_, or shows an error when nothing has loaded yet.

### Refresh and Jira call budget

Unlike the other data tabs, Releases has **no auto-refresh**. It loads when you
first open the tab and when you act: pick a version, change scope or press
**Refresh**. A response that arrives after a newer choice is discarded.
Refresh sends `refresh=1`, which bypasses the server's PR cache.

The server remembers each ticket's successfully looked-up PRs for 60 seconds
(keyed by Jira URL and issue id), so reloading or flipping between Mine and All
is cheap. Dev-status detail lookups run at most 4 at a time, and every Jira call
times out after 15 seconds. A cold load of an N-ticket release is roughly N + 3
Jira calls: the versions list, a search (one call per 50 tickets), one summary to
learn the instance key and one detail lookup per ticket. With the key already
remembered it is N + 2; with every lookup cached it is just the versions and the
search. For example, 11 tickets cost 14 calls cold, 13 on Refresh and 2 within
the cache window. `node backend/cli.mjs releases` runs in its own process, so it shares
no cache with the dashboard and always starts cold.

### Configuration

The project key comes from the optional environment variable
`JIRA_RELEASES_PROJECT` (default `TAP`; the project was named `TRIPS` until 2026-10-27), read when the dashboard or the CLI
starts. There is no Settings field and no change to the saved-settings schema.
A value that is not a valid Jira project key (uppercase letters, digits and
underscores, starting with a letter) fails the request rather than stopping the
dashboard. The Jira URL, email and token are the saved connection used by My
Tickets.

### CLI, HTTP and response

`node backend/cli.mjs releases [--version <id|name>] [--all] [--json]` uses the
picker's default version and your tickets unless told otherwise. `--version`
takes a numeric id or an exact version name that matches exactly one version
(a name is resolved to an id and never reaches JQL); a missing value, or one
that is another flag, is a usage error. `--all` lists every assignee. `--json`
prints the payload below without `updatedAt`; otherwise the output lists the
tickets grouped by merge state with one line per PR (number, repo, state, base).
Errors go to stderr with a nonzero exit.

`GET /api/releases?version=<id>&scope=mine|all&refresh=1` takes all parameters
as optional: the default version, `mine` and cached data.

```
200 { versions: [{ id, name, released, releaseDate, family }],      // picker order
      version: { id, name, released, releaseDate } | null,           // requested, else default
      scope, total, truncated, updatedAt,
      tickets: [{ key, summary, status, issueType, priority, assignee, updated,
                  mergeState, prsStatus, prsError?,
                  prs: [{ repo, number, title, url, state, base, head,
                          updatedAt, countsAsMerged }] }] }
```

`version` is `null` only when the project has no versions, in which case no
search is made. `releaseDate`, `assignee`, `url` and `updatedAt` can be `null`.
`400` means a malformed or unknown `version`, or a `scope` other than `mine` or
`all`; `409 SETUP_REQUIRED` is the setup gate; `502` covers any other failure
(Jira unreachable or rejecting the versions or search call, an invalid project
key). Error bodies stay generic: no upstream text, JQL or credential reaches the
browser.

The rules above — version order, request validation, JQL, PR ownership and the
merge roll-up — are pure and live in [`backend/release-model.mjs`](backend/release-model.mjs);
the Jira calls, caches and concurrency are in [`backend/releases.mjs`](backend/releases.mjs).
The browser's grouping and remembered-version helpers are DOM-free in
[`ui/releases-data.js`](ui/releases-data.js). Tests are
`test/release-*.test.mjs` and `test/ui-releases-*.test.mjs`. The Releases
`data-testid` names (`releases-version`, `releases-scope`, `releases-refresh`,
`releases-meta`, `releases-list`, `releases-group-<state>`,
`release-ticket-<key>`) are pinned by `e2e/releases.spec.js` — treat them as a
contract.

## Slack

Optional, and deliberately the least privileged thing in the app: it holds no
Jira/GitHub dependency, sits outside the setup gate, and every failure renders as
"not connected" rather than an error.

### Why there is no OAuth app

Slack's public API only accepts tokens minted for a registered Slack app, and
this dashboard does not register one. Instead **Connect Slack** captures the
credentials the Slack _web client_ already uses after you sign in:

- the `xoxc-` user token from the web client's `localConfig_v2` localStorage entry
- the `d` session cookie

Both are written to `~/.config/slack/session.json` (mode `600`) and sent from the
dashboard server as `Authorization: Bearer …` plus `Cookie: d=…`. That pair
carries the same access as your browser session — verified against `auth.test`,
`conversations.list` and `search.messages`.

Treat it as an unsupported surface: Slack can rotate or invalidate these
credentials at any time, and when it does the tab simply flips back to
**Connect Slack**. Nothing else in the dashboard notices.

### Connecting

**Connect Slack** spawns [`backend/slack-connect.mjs`](backend/slack-connect.mjs),
which opens a dedicated Chromium profile at `~/.config/slack/browser-profile`,
waits for the Slack web client to finish signing in, copies the credentials, and
closes the window. The profile is reused afterwards, so a reconnect normally
needs no sign-in at all. Closing the window cancels the attempt.

The child process owns the whole exchange: no credential passes through the
dashboard server, its logs, or the browser. Failures are appended to
`~/.config/slack/connect.log` (mode `600`) and otherwise stay invisible.

Because the flow needs a real browser, it does not work inside the Docker image —
set `SLACK_WORKSPACE` to point the window at a different workspace, or
`SLACK_PROFILE_DIR` to reuse a different profile.

### What it shows

Two lists over `#ezat_claudio`, both ordered by latest activity and both flagged
**Needs reply** when the newest message in the thread is not yours:

- **Threads I started** — thread roots authored by you, with reply count, who
  replied last, and how long ago.
- **Mentions** — threads (or standalone messages) where someone wrote `<@you>`,
  grouped to one row per thread with the mentioning message as the preview.

A click on a row opens the thread's full conversation in the same in-app dialog
My Tickets uses, with **Open in Slack** and **Copy link** in its footer and the same
**Claude session** section ([Watch](#watch)); the
conversation is fetched on demand and cached for a minute. The lists paint as
soon as the two thread lists have been read; the **Needs reply** flags fill in a
moment later, one `conversations.replies` call per listed thread, because that is
the only call that has to look inside a thread. A payload with `enriched: false`
still has its flags on the way — the rows are usable and show no badge yet.

The server caches that result for five minutes and revalidates it in the
background: a cached copy is returned immediately, even when it is past the
five minutes, and the refresh happens behind the response. So the tab never
waits on Slack for a refresh, and a failed read backs off for a minute instead
of retrying on every poll.

The Slack tab label carries a badge: the unread mention count for
`#ezat_claudio`, or a dot when the channel has unreads but no unread mentions.
It comes from `client.counts` — another web-client-only method, parsed
defensively and cached for a minute — and it is hidden when Slack is
disconnected or when there is nothing unread.

The shaping rules (mrkdwn to text, epoch to ISO, "who spoke last") are pure and
live in [`backend/slack-model.mjs`](backend/slack-model.mjs); the Slack calls and
budgets are in [`backend/slack.mjs`](backend/slack.mjs). Field notes on the
underlying endpoints — including the `thread_ts === ts` root marker and the
`search.messages` paging quirks — are in
[`toolkit-mcp/docs/slack-web-session.md`](../../toolkit-mcp/docs/slack-web-session.md).

### Watch

The Slack tab can also watch Slack threads and wake the Claude Code sessions that
are working on them. You paste thread links on the **Watch threads** card, a session
attaches its own id to a link over HTTP, and a watcher inside the dashboard server
reads each watched thread on a poll paced by the interval (a poll is called a tick below).
When the newest message in a thread is somebody else's and newer than the last one already
announced, the watcher appends one plain-text line to an inbox file for every session
attached to that link. A session that follows its inbox with the Monitor tool wakes on that
line and reads the live thread. An idle background session that does not wake on its own is
stopped and resumed under the same session id by the watcher, after a settle gap, and a session
that has finished is resumed too. Delivery below gives the wake flow and the sessions that
are never stopped. In Slack, the watcher only reads: it never posts, reacts or edits.

**Links.** A pasted Slack link is the only input. The watcher parses the channel and
the thread out of it, so any channel works and there is no channel setting. It
accepts a message permalink (`…/archives/<channel>/p<digits>`), a reply permalink (the
same with `?thread_ts=…`, which names the thread's parent) and the
`app.slack.com/client/<team>/<channel>/thread/<channel>-<ts>` form the dashboard
hands out; every form of one thread is the same watched link. It rejects, with a
reason code, a channel-only link, another host, a non-https link, embedded
credentials, a bad timestamp and any text around the link (`not_a_link`,
`extra_text`, `not_https`, `credentials_not_allowed`, `not_slack_host`,
`not_a_thread_link`, `invalid_timestamp`). The stored link is rebuilt from the
validated parts and never echoed from what was pasted.

**Wake rule.** A link wakes its sessions when the thread's newest message was written
by someone other than you and is newer than the link's `lastNotifiedTs` (Slack
timestamps are compared as seconds and microseconds, not as floats). Attaching never
wakes: attach makes no Slack call, and the first read after an attach records the
newest message at or before the attach time as already seen, so only messages
posted after attaching count. Your own messages (including a reply a session posts as
you), reactions, edits and deleted messages never wake, and neither does a bot
message, which carries no user.

**Delivery.** Each wake renders the notice and delivers it to every attached session:
one line appended to that session's inbox,
`~/.config/dev-dashboard/slack-watch/inbox/<session-id>.log`, which the session
follows with the Monitor tool (`tail -n 0 -F` on that path). A session has one inbox
for all its links. For a session the CLI lists as finished (its entry in
`claude agents --json --all` has no `pid`) the watcher also runs
`claude --bg --resume <full session id> -- <notice>` from that session's own
working directory, with no other flag and at most once per session per tick: that is
the only form that continues the session under its own id. It never resumes a live
session (that would fork a copy), a session in an unknown state, or an id that is
not a full session id. A resumed session starts without a Monitor, so it has to arm
one on its inbox again to hear the next line, and because the resume carries only
one notice it should read its whole inbox once first.

**Live wake.** A session gets a wake when its inbox line is appended and the CLI lists it
as a background process (`kind: background`) with a numeric `pid` and a status of `idle`
or `busy`. A busy session is never stopped. If a later listing shows it busy after it was
seen idle, it woke on its own (`woke_itself`). A session that lists idle is stopped in the
pass that writes its line, with no grace wait, so it gets no time to wake on that line
first: the watcher runs `claude stop` on its 8-character id, which keeps the conversation.
It first lists again to check that this exact session is idle and that no other listed
session shares the 8 characters (`ambiguous_id` otherwise). A session that lists busy then
is not stopped and is `woke_itself`. One that lists finished or without a trusted `pid`
then (it was stopped, or lost its numeric `pid`, since the poll's listing) is not
`woke_itself`: nothing is
stopped, the wake keeps the notice owed and awaiting, and the next poll decides. The
resume follows the stop by the settle gap
(see Wake flow below), measured on the wall clock from the moment the stop returns. It
never runs inside the gap, whatever starts it, the Resume button included. The stopped
session loses its Monitor and the resumed one starts without any, so it has to arm one
again. If a stopped session is live again when the resume runs, the wake goes back to
awaiting with the same deadline and nothing is resumed. A session that a poll finds
finished during a wake (someone else stopped it, or it ended on its own) starts its settle
gap at the first listing that shows it finished. Unlike a session the watcher stopped, it
is resumed only while it is attached and the watcher is running: if it is detached, or the
watcher is paused or disabled, when the gap ends, nothing is resumed then and its wake
waits again. A later poll decides afresh while it stays attached; a detached session's
wake is dropped. A wake still awaiting 2 hours after its line ends `failed-permanent`
with `never_idle`. One wake serves a session however many links it is attached to.
Detaching a session from its last link drops its wake, unless the watcher itself has
stopped it: such a session is still resumed once, even when it was detached during the
gap. Interactive sessions,
sessions with no idle or busy status, sessions with an unknown pid, and every session
while the watcher is paused are never stopped; a live session with no idle or busy status
gets its line only (`inbox_only`). The settle gap and the 2-hour deadline are constants in
the code, not settings.

A session that follows its inbox with a Monitor lists `busy` even while it is idle
(measured, see Checked against the real CLI below), so it is never stopped and keeps its
Monitor. The watcher cannot see that such a session read its line, so its record stays
`waiting` with `awaiting_wake` and the link's `lastNotifiedTs` stays put until the
session lists idle, when the stop rule above applies, or the 2 hours end the wake as
`never_idle`. Claude's own daemon retires an idle background session after about 66
minutes (its log, `~/.claude/daemon.log`, showed `bg retire <id>: settled, idle 66m` on
2026-11-01; this is observed behavior, not something the dashboard reads or sets). A
retired session lists as finished and the ordinary resume wakes it, so only a session
idle for less than that needs the stop. A session that is already listed finished when its
line arrives is resumed on that tick with no settle gap, because the listing has no end
time; if someone else stopped it only seconds earlier, that resume can start a copy
under a new id, recorded `resume_forked`.

**Wake flow.** A wake is one awaited flow, not a series of timed stages. A poll, timed or
forced with **Check now**, that finds a notice owed for an attached session that lists idle
does the whole delivery in that same pass: it appends the inbox line, lists the session
again, stops it if it still lists idle, waits the settle gap, lists it again and resumes it
under the same session id with the notice. There is no grace wait before the stop. The
settle gap is 15 s (`SETTLE_MS`), a fixed constant in the code, not a setting. It is a
design constant, not a measured timing: the facts behind it are the two recorded under
Checked against the real CLI below (a resume 3 s after a stop forked a copy, one 10 s after
it continued), and no end-to-end wake time has been measured. While a session waits out its
gap, its delivery reads `waiting` with `settling`.

The wait never holds the poll, a forced check or another session: the next poll and a
forced check run normally while a session waits, sessions wake concurrently, and a session
has at most one flow, so a poll that finds one in flight starts nothing for it. The
interval paces only the Slack poll, so it does not move the wake. A poll still retries what
the flow could not finish: a busy session is retried until it lists idle, which can take up
to the 2-hour deadline, and a failed listing, stop or resume is retried on the next poll,
so such a wake can run late by up to one poll interval.

Every session's last delivery for a link has a status: `delivered`, `waiting` while a
wake runs, `failed-transient` while retries remain, or `failed-permanent`, with a reason
code and the time of the attempt. `delivered` means the session was woken, or got only
its inbox line and the reason says why. The reasons for `delivered` are `woke_itself`
(it woke on its own), `resumed` (the watcher resumed it), `inbox_only` (it is live but
neither idle nor busy in the listing, as an interactive session is, so it is never
stopped; it gets the inbox line only) and `not_listed` (it is absent from a good listing,
or the stop's fresh listing did not match it; as an interactive session attached by hand
may be, it gets the inbox line only). The reasons for `waiting` are `awaiting_wake` (idle
or busy, not yet woken or stopped; also a stopped session found live again when its
resume ran, a session that listed finished or without a trusted `pid` just before its
stop, and a finished session whose resume was held back by a detach, a pause or a
disable), `settling` (inside the settle gap after a stop, or in the first 15 s
after the watcher starts) and `live_at_resume` (a session listed finished was live when
the resume ran, as when something woke it just before; the next tick looks at it again).
The transient failures are `append_failed`, `listing_unavailable` (the session listing
could not be read), `spawn_failed`, `timed_out` and `stop_failed`. The permanent failures
are `untrusted_workspace`, `resume_forked` (the resume started a copy under a new id,
which is left alone and never cleaned up), `never_idle` (the wake was still awaiting 2
hours after its line) and `ambiguous_id` (another listed session shares the first 8
characters of the session id).

A transient failure is retried once per tick, repeating only the part that failed
(within one server run the inbox line is never appended twice for one notice), up to 3
attempts, then it is recorded `failed-permanent`, with its last reason. The failed
listings, stops and resumes of a wake count the same way across the whole wake, so a
session that is already stopped when the third attempt fails stays stopped. A permanent
failure is never retried for that notice. A `waiting` record costs no attempt.
`lastNotifiedTs` moves forward only once every attached session is delivered or has
failed permanently, so a `waiting` session holds it back, and one session that can never
be resumed does not make the others hear the notice again. The next new message tries
every session afresh.

Delivery is at least once. Statuses and wakes are kept in memory, and a `waiting` session
holds `lastNotifiedTs` back, so a server restart in the middle of a wake loses the wake,
delivers the notice again and appends the same inbox line a second time: the session can
read that line twice. Saving the stop state on disk would avoid it and was decided
against. A message that lands mid-tick can repeat a line too, but a session that has not
failed permanently is never skipped silently. The restart also loses the stop time of a
session the watcher had stopped, so for 15 s after the watcher starts no finished
session is resumed (its record shows `waiting` with `settling`); a session stopped just
before a restart is therefore not resumed inside its settle gap. When the dashboard shuts
down, the watcher cancels every pending settle wait and starts no stop or resume after
that, even if the shutdown lands while a `claude stop` is running; a session left stopped
that way is resumed after the next start, as any finished session is. At most 20
inbox lines are written per tick; the rest wait for the next tick. Every 10 minutes
the watcher detaches a session that was listed earlier since the server started but
is absent from two listings in a row, and deletes its inbox; a session never seen in
a listing is kept.

**Pause and resume.** One switch pauses the whole watcher. It is saved in the
settings, so a restart does not resume. While paused there are no Slack calls and no
inbox lines, every `lastNotifiedTs` is kept, and links and sessions can still be
added and attached. No session is stopped while paused, and a wake that is still awaiting
waits, its 2-hour deadline still running. A session the watcher stopped before the pause
is still resumed once its settle gap has passed, and link backoff does not hold that
resume back. A session a poll found already finished is not: it is not resumed while the
watcher is paused, and its wake waits again. A pause or a detach that lands while a stop
is already running does not undo it, and the session is then resumed as above. Resume reads the threads at once, so
a thread that got a new message from someone else during the pause wakes its sessions
once. Even when the Resume button runs a tick, a stopped session is not resumed inside
its settle gap.

**Interval and notice.** The interval is whole seconds, 180 by default, from 30 to 3600.
It paces only the Slack poll, which finds new replies, writes the notice line and starts a
wake; the settle wait of a wake is not paced by it. A saved change takes effect at once
and re-measures `nextCheckAt` from the last poll. The notice is one line of at most 200
characters, `There's a new message on {link}` by default. `{link}` is the only
placeholder and every occurrence is replaced by the stored link, so a notice holds
only the template and the link, never Slack text. Line breaks and other control
characters are rejected. A template without `{link}` is accepted and the card
warns that a session will not know which thread changed. The settings are described
under [Slack watch settings](#slack-watch-settings).

**Failures.** A rate limit (HTTP 429 with `Retry-After`) holds back every read until
the delay has passed. A network or 5xx failure, a missing Slack connection or a
rejected session backs off all reads, doubling from 60 seconds to 15 minutes until
a read succeeds. A thread that cannot be read (deleted, not a member, a missing
scope) or is longer than 20 pages of 200 messages backs off on its own link with the
same doubling, and the other links are still read every tick. Each link reports its
last read status (`ok`, `rate_limited`, `session_rejected`, `not_connected`,
`thread_unreadable`, `too_long` or `unavailable`).

**State on disk.** Everything is under `~/.config/dev-dashboard/slack-watch/` (directory
mode `700`, files `600`). `map.json` holds, per link, its key (channel id and thread
timestamp), the stored link, when it was added, the baseline time, `lastNotifiedTs`
and the attached session ids; the server is its only writer and each write goes
through a temporary file, an fsync and a rename. `inbox/<session-id>.log` holds one
notice per line and is removed when its session's last link is detached or removed,
or the session is pruned. Only keys, ids, timestamps and reason codes are stored or
logged: never Slack message text, user names, tokens or cookies. A session's name
appears only in the picker's reply and is never stored. The pause flag, interval and
notice are in `settings.json`. To roll back, stop the dashboard and delete the
`slack-watch` directory; an older build ignores the `slackWatch` settings section and
drops it on its next Settings save.

**Host only.** The watcher needs the `.claude` directory under your home and the
`claude` CLI on `PATH` for the session picker, the stop and the resume. Without the
directory, as in the Docker image, its state is `disabled` with the reason
`claude_home_unreadable`: no timer runs and adding, attaching and removing links is
refused with `409 WATCH_DISABLED` (detach still works, so inboxes can be cleaned
up). Disabled wins over paused. Without the CLI the picker lists only the sessions
already attached, and you can paste a full session id instead. The server starts the
watcher when it starts listening, and nothing is read until a session is attached to
a link.

**The card.** Once Slack is connected the Slack tab shows a **Watch threads** card:

- a textarea for links, one per line, with **Add**; refused lines stay in the box
  and their reasons are listed under it
- a table with one row per link: the link, **last checked** (`never` until it has
  been read), the last read status, the attached sessions, each with its last
  delivery status, how long ago and its reason code, a **Detach** button and a **Remove**
  button
- a countdown, **next check in N s**, ticking every second from `nextCheckAt`, with
  **checking…** while a poll runs, shown only while the watcher is running, and a
  **Check now** button beside it, which runs one poll at once and restarts the countdown
  (`POST /api/slack/watch/check`); the button is disabled while paused or disabled and
  while its own request is in flight
- an attach form: pick a link, then a session from the picker or paste a full
  session id, then **Attach**
- the watcher state (**Running**, **Paused**, or **Disabled** with its reason code),
  **Pause** while running and **Resume** while paused, and the interval and notice
  fields with **Save**

While the state is disabled, Add, Attach and Remove are disabled. The card polls only
the server's in-memory list, every 30 seconds, only while the Slack tab is open and
the page is visible, so it makes no Slack calls itself. Reason codes are shown as
the server sends them. A `waiting` status, and the reason under `delivered` or
`waiting`, are muted; the reason under a failure stays red.

**The thread dialog.** The dialog that opens from a My Tickets glyph or a Slack tab
row has a **Claude session** section for the thread it shows, on the same watcher as
the Watch threads card, so both screens behave the same. It lists the sessions
attached to that thread, each with a **Detach** button, or says "No session
attached". Its picker offers the sessions the card's picker offers
(`GET /api/slack/watch/sessions`), with the same labels, minus those already
attached to this thread; **Attach** stays disabled until one is chosen, and pasting a
session id stays on the card. **Attach** also puts a thread that is not yet watched on
the Watch threads list, because it uses the same attach route. **Detach** leaves the
thread on that list; removing a thread stays on the card. The thread is matched to
its watch entry by the `watchKey` the server hands the dialog, never by a link string.
A failed attach or detach shows the card's words for that error in the section and
leaves it as it was, and the buttons are disabled while a request is in flight. The
section reads the watch list and the picker once when the dialog opens and the watch
list once more after each successful attach or detach; it never polls, so it can lag
behind the card until the dialog is reopened. When the watcher is disabled or its list
cannot be read, the section says so in one sentence and offers neither picker nor
buttons; when the thread has no link, attaching is disabled and the section says "No
link to attach to".

**Checked against the real CLI.** The live wake was checked while it was built, against
the real `claude` CLI, on throwaway background sessions that the check created itself,
then stopped and removed; the session count was the same afterwards. The check script is
not part of this repository, so there is nothing here to re-run. What it did and saw:

- A real resume continued the same session id when it ran 10 seconds after a stop, and
  no copy appeared. The check starts at 10 seconds and stops at the first gap that
  continues, so 10 seconds is the smallest gap it probed, not a proven minimum.
- An earlier manual experiment (2026-11-01) saw a resume 3 seconds after a stop start a
  copy under a new id. Nothing between 3 and 10 seconds was measured.
- An idle background session with a Monitor armed on its inbox listed `status: busy`
  over a 30-second window, so the watcher never stops it.
- The shipped settle gap is 15 s. It is 5 s over the 10 s that worked, a design constant
  provisional on those two observations, not a measured minimum.
- The watcher itself, on the earlier build that waited a grace before the stop and resumed
  on a later poll, driven on a real throwaway session with a fake Slack reader and manual
  ticks, went `awaiting_wake`, then `settling` (an early tick resumed nothing), then
  `resumed` under the same session id, with zero copies and one inbox line.

Its limits: it is a one-time check made while building, not a standing test, and it is
not part of `npm test`; its Monitor measurement is driven by a model, so it is not
deterministic, and one run timed out on its own wait for that session to go quiet (a
flaky step in the check, not a product failure) before a re-run passed; and it says
nothing about later CLI versions. It ran on the earlier build, so the one awaited flow and
its 15 s settle gap have not been run against the real CLI yet, and no end-to-end wake time
has been measured.

**What is not verified.** The watcher is tested with fakes for Slack and the
`claude` CLI and has not been run against a live Slack workspace. The wake path was
tried only with background sessions: a Monitor on the inbox woke an idle one and
reached a working one, and a finished one ignored the line. Not yet checked: waking
an interactive session, whether an interactive session appears in the CLI's listing
(the watcher treats an unlisted session as inbox-only), whether a Monitor's
expiry notice wakes an idle session (a Monitor lives at most 30 minutes per arm, so
the session side has to arm it again on every expiry and every wake), and what Slack
answers when a reply timestamp is used as a thread timestamp (a message permalink
without `thread_ts` is keyed by its own timestamp). The session-side skill that
attaches, follows the inbox and re-arms the Monitor is not part of this repository
and is not built yet. Also unchecked: the smallest settle gap that continues the same
session id (only 3 seconds, which forked, and 10 seconds, which continued, were
observed), and whether a session the watcher stopped and then detached stays finished
after a server restart. The watcher never stops or removes a copy that a resume starts.

### HTTP

| Route                                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/slack/status`                  | `{ connected, connecting, user, team, savedAt, verified }`; never fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/slack/threads`                 | `{ available, channel, started[], mentions[], updatedAt, enriched }`; `enriched: false` while the reply flags are still being read; `available: false` when disconnected; each thread carries `url` and `watchKey`, the `<channelId>:<ts>` string the watch list uses as `key` for that thread, both empty when the thread has no link                                                                                                                                                                                                                                           |
| `GET /api/slack/pending`                 | `{ available, channel: { id, name, mentions, unread }, mentionsTotal, updatedAt }`; `available: false` when disconnected or unknown                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/slack/thread?ts=`              | one conversation: `{ available, thread: { ts, url, watchKey, channel, replyCount, truncated, updatedAt, names, messages[] } }`; `watchKey` is as for the thread lists; each message carries plain `text` and raw `mrkdwn`; `available: false` when disconnected, for a malformed `ts`, or for a thread Slack refuses                                                                                                                                                                                                                                                             |
| `POST /api/slack/connect`                | starts the sign-in window, `{ ok, connecting }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /api/slack/disconnect`             | deletes the stored session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/slack/watch`                   | the [watcher](#watch) state, answered from memory, no Slack calls: `{ state, reason?, nextCheckAt, settings: { intervalSeconds, noticeTemplate, paused }, links[] }`; `state` is `running`, `paused` or `disabled`, `reason` only if disabled; `nextCheckAt` is the time the next timed poll fires, `null` while one runs, paused, disabled or before the start; each link is `{ key, link, lastCheckedAt, lastStatus, sessions[] }` and each session `{ sessionId, delivery }`; `delivery` is `{ status, reason, at }` (`status` may be `waiting`) or `null` before any attempt |
| `GET /api/slack/watch/sessions`          | the session picker: `{ source, sessions[] }`; `source` is `claude` (from `claude agents --json --all`) or `map` (the CLI was unusable, so only the ids already attached); each session is `{ sessionId, state, activity?, name?, attached }` with `state` `live`, `finished` or `unknown` (from the CLI's `pid`) and `activity` `idle`, `busy` or `null` (not sent for `map`); `name` is a transient label, only here                                                                                                                                                            |
| `POST /api/slack/watch/links`            | body `{ links: [...] }`, at most 50; answers `{ results[] }`, one per input in order: `{ input, ok: true, key, added }` or `{ input, ok: false, reason }`; a link already watched is accepted with `added: false`                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/slack/watch/remove`           | body `{ link }`; removes the link and its attachments, answers `{ ok, removed }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /api/slack/watch/attach`           | body `{ link, sessionId }` with a full session id (UUID); adds the link if it is unknown, makes no Slack call (also while paused), is idempotent, answers `{ ok, key, inbox }` with the inbox path to follow                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /api/slack/watch/detach`           | body `{ link, sessionId }`; answers `{ ok }`, also when the pair was not attached, and also while disabled; the session's inbox goes with its last link                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PUT /api/slack/watch/settings`          | body `{ intervalSeconds?, noticeTemplate? }`, either may be omitted; answers `{ ok, settings }` with the stored values; `paused` is not settable here                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /api/slack/watch/check`            | no body; runs one poll now, the same poll a timed tick runs (so it also starts the wake of a notice it finds owed), then restarts the countdown, so the next timed poll is one full interval later; answers `{ ok: true, state, checked }`, with `checked` false when a poll was already running; `409 WATCH_PAUSED` while paused, reading nothing from Slack, and `409 WATCH_DISABLED` while disabled; it never bypasses a rate-limit or link backoff                                                                                                                           |
| `POST /api/slack/watch/pause`, `/resume` | no body; answers `{ ok, state }`; both are idempotent, and `resume` reads the threads before it answers                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

`status` verifies the session with `auth.test` at most once a minute.
`verified: false` means the token exists but Slack could not be reached — still
not an error. These routes, the `/api/slack/watch*` routes included, deliberately
bypass the `SETUP_REQUIRED` gate: a missing GitHub or Jira configuration must not
affect Slack, and vice versa. A watch route still answers when GitHub and Jira setup
is incomplete, while `/api/services` keeps answering `SETUP_REQUIRED`.

The watch routes run behind the dashboard's usual Host and Origin checks: a
non-loopback `Host`, a foreign `Origin` or a cross-site or same-site `Sec-Fetch-Site` gets `403`,
and a request that sends a `Content-Type` other than `application/json` gets `415`.
A local POST with no `Origin` or `Content-Type` header is accepted, so `curl` works;
a route that reads a body (`links`, `remove`, `attach`, `detach`, `settings`)
needs a JSON object, `pause` and `resume` need none, and a body over 64 KiB is
refused. Failures answer `{ code, error, errors[] }` with these codes:

| Status | Code                 | When                                                                                     |
| ------ | -------------------- | ---------------------------------------------------------------------------------------- |
| `400`  | `INVALID_LINK`       | the link is not one the parser accepts, or `links` is not an array or holds more than 50 |
| `400`  | `INVALID_SESSION`    | `sessionId` is not a full session id                                                     |
| `400`  | `INVALID_JSON`       | the body is not a JSON object                                                            |
| `413`  | `BODY_TOO_LARGE`     | the body is over 64 KiB                                                                  |
| `409`  | `WATCH_DISABLED`     | `links`, `remove` or `attach` while the watcher is disabled                              |
| `409`  | `REVISION_CONFLICT`  | `settings`, `pause` or `resume` when the settings file no longer matches what was loaded |
| `422`  | `INVALID_SETTINGS`   | `settings` holds a value that fails validation; `errors[]` carries `slackWatch.<field>`  |
| `503`  | `PERSISTENCE_FAILED` | `settings`, `pause` or `resume` while no settings record is loaded                       |

Anything else, including the `403` and `415` refusals above, answers
`OPERATION_FAILED` and never echoes an error message.

## Services

Edited in **Settings → Local services** and persisted in the settings store.
The initial defaults in [`backend/config.mjs`](backend/config.mjs) mirror these `scripts/run.sh`
commands:

| id          | label             | dir                | command             | port |
| ----------- | ----------------- | ------------------ | ------------------- | ---- |
| `be`        | Portage Backend   | `Portage-backend`  | `npm run start:dev` | 8000 |
| `fe`        | Portage Frontend  | `Portage-frontend` | `npm run dev`       | 3000 |
| `legacy`    | TravelTracker API | `TravelTracker`    | `npm run start:be`  | 8081 |
| `legacy-ui` | TravelTracker UI  | `TravelTracker`    | `npm run serve`     | —    |
| `queue`     | Portage Queue     | `Portage-backend`  | `npm run queue:dev` | —    |

Each service uses its project `.nvmrc`, or the monorepo root `.nvmrc` only when
the project file is absent. Exact release pins such as `20.18.0` and `v20.18.0`
are supported; aliases and version ranges are not. The installation is resolved under `NVM_DIR`
(default `~/.nvm`), and its bin directory is prepended to `PATH`. With neither
pin file present, the inherited `PATH` is unchanged.

Start and restart reject empty, unreadable, or unsupported pins and installations
without executable `node` and `npm`, before clearing logs or freeing ports.
Restart validates before stopping the running service. Successful pinned starts
log the selected Node version and executable path.

## Port freeing

Both the dashboard and every service **free their own port before binding**:

- The dashboard frees its own port (`6500`) so a stale instance can't block startup.
- **Each service frees its app port before starting** (e.g. `8000`, `3000`, `8081`).
  So if the app is already running on your terminal (via `run.sh`) and you Start
  that service from the dashboard, it kills the old process holding the port and
  takes over — no `EADDRINUSE`.

The shared helper lives in [`backend/port.mjs`](backend/port.mjs).

## UI layout

The dashboard browser UI is a React + MUI application under `ui-react/`, built
with Vite into `dist/` and served by the existing Node server through
[`backend/static.mjs`](backend/static.mjs). Production uses the built assets; Vite is a
development/build tool, not the production server. Use Node 24 (`nvm use` from
the repository root), install the committed lockfile with `npm ci`, and build
with `npm run build`. `npm run dev:ui` runs Vite for frontend development and
proxies the existing `/api/*` endpoints to the local dashboard server.
`team-velocity.html` remains a separate standalone page.

Run `npm run lint` to check JavaScript and JSX with ESLint. `npm run format`
formats JavaScript, JSX, CSS, HTML and JSON files; use `npm run format:check`
to verify formatting without changing files.

```
ui-react/
  main.jsx              React entry; mounts the themed App shell
  App.jsx               readiness gate, hash routes and one shared service feed
  theme.js              compact dark MUI theme
  lib/api.js            one browser API boundary
  hooks/                shared service event, polling and API hooks
  components/           shell, reusable MUI primitives, filters and card wrappers
  panels/               Home, Services, PRs, My Tickets, Releases, Slack and Settings
  styles.css            theme variables plus the established bespoke panel CSS
ui/
  dom.js                esc / slug / clamp / timeAgo
  home-data.js          Home's counting / sprint scoping / urgency ordering (DOM-free)
  work-filters.js       shared PR, ticket and action filtering (DOM-free)
  releases-data.js      release grouping and remembered version (DOM-free)
  ticket-board.js       My Tickets column order and CI / review wording (DOM-free)
  components/           domain-free helpers and tested card/diff data rendering

ui-react/styles/        app-owned bespoke styles, imported by the Vite entry
```

React owns the shell, route state, theme, panel state, loading/polling and
interaction behavior. The panels compose shared React primitives for buttons,
cards, filters, listboxes, terminal output and status; domain-free selectors
and established card/diff helpers preserve existing calculations, escaping
and data-testid contracts. Masonry uses CSS multi-column packing with intact
cards and sibling spacing at 760px and 1700px; Services retains an explicit
CSS grid, Home blocks remain indivisible and My Tickets is a horizontally
scrolling board of columns that scroll on their own (see
[My Tickets](#my-tickets)). Legacy DOM panel controllers,
entry points, stylesheet tree and the API compatibility re-export have been
retired.

`GET /api/config` supplies the tail line count, derived Jira browse URL and setup
status used to choose Settings-only or ready-mode boot.

The DOM is labelled with `data-testid` throughout for Playwright and agent use —
treat those names as a contract and don't rename them.

## Notes

- The dashboard server uses Node built-ins at runtime; `nodemon` is a
  development dependency used by `npm run dev`.
- On shutdown the dashboard SIGTERMs each service's process group, then exits.
- **Logs are cleared on every start/restart** — a service always begins with a
  fresh in-memory buffer and empty `logs/<id>/out.log`, so previous-run output
  never lingers in the tail or the agent-readable file.
- `logs/<id>/out.log` holds a rolling buffer (last 64 KB per service) and is
  gitignored — never committed.
- The manager is an in-process class (`backend/manager.mjs`); the CLI and the HTTP
  server both use the same `Manager`, so `logs` is consistent whether the
  dashboard is running or not.
