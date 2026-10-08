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
- **My Tickets** — Jira tickets assigned to you (`assignee = currentUser()`),
  grouped by status category with status-name sub-groups, each ticket showing
  the sprint it is in and a header line naming the current active sprint. An
  _include Done_ checkbox controls whether Done tickets are shown.
- **Releases** — the tickets of one Jira fix version (the picker defaults to the
  earliest unreleased EZAT version), each with its GitHub PRs, grouped by
  whether the work reached `ops/development`. It opens on your own tickets;
  **All release tickets** widens it. See [Releases](#releases).
- **Settings** — saved integrations, token replacements, local services and
  advanced options.

The visible view lives in the URL hash (`#/home`, `#/services`, `#/prs`,
`#/my-tickets`, `#/releases`, `#/settings`), so a reload — or a link you paste to
yourself — lands where you left off. A bare URL or an unrecognised hash is
canonicalized to Home when ready, or Settings during setup. During setup, deep links, title clicks
and back/forward navigation also resolve to Settings; operational panels and the
service feed are not mounted. Log fetching pauses while Services is hidden.

> The dashboard port (`6500`) and tail line count are configurable in
> [`config.mjs`](config.mjs).

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
- Run CLI commands in the container: `docker compose exec dashboard node cli.mjs logs`.
- `docker compose config` prints the `.env` values in plain text. Do not paste its
  output anywhere.
- After changing dashboard code, run `docker compose up --build` again.
- The image pins the Node versions listed in `NODE_PINS` in the Dockerfile. When a
  sibling repo changes its `.nvmrc`, add the version there and rebuild. Until
  then the container refuses to start and names the missing version.
- PR diffs run `git` in the sibling repos and authenticate to GitHub with
  `GH_TOKEN`. SSH remotes do not work inside the container.

## Settings and setup

### Saved configuration and credentials

The dashboard persists configuration outside the project:

| Path | Contents |
| ---- | -------- |
| `~/.config/dev-dashboard/settings.json` | Versioned non-secret settings (`schemaVersion: 1`), revision, migration origin and integration acceptance metadata |
| `~/.config/github/token` | GitHub token |
| `~/.config/jira/token` | Jira API token |

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
integration variables or the defaults in `config.mjs` do not override saved
configuration. An unreadable, malformed or unsupported settings file is not
silently overwritten or backfilled; setup stays closed for repair. Host, dashboard
port, tail count and log-buffer limits remain runtime constants in `config.mjs`.

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

| Endpoint | Contract |
| -------- | -------- |
| `GET /api/config` | Tail count, derived Jira browse URL and `setup` (readiness, errors, revision, origin, connection status) |
| `GET /api/settings` | Editable saved settings, revision, token presence/source and setup status; no tokens |
| `PUT /api/settings` | Full editable configuration plus `expectedRevision`; optional `credentials.githubToken` / `credentials.jiraToken`; omitted/blank replacements retain saved tokens |
| `POST /api/settings/validate` | JSON object body with optional `expectedRevision` (sent by the browser); stale revisions return `409 REVISION_CONFLICT` before probes. Revalidates saved settings and returns public state with the current revision; `setup`/connection errors determine the result |

JSON bodies are limited to 64 KiB. Saves return `409 REVISION_CONFLICT` or
`409 SERVICE_IN_USE` for conflicts, `422` for invalid fields/confirmed probe
failures, and `503 VALIDATION_UNAVAILABLE` for unavailable validation
(`PERSISTENCE_FAILED` for write failures). Malformed JSON returns `400` and
oversized bodies `413`. Responses use sanitized errors. A setup revocation
closes existing SSE streams with a `setup-required` event; the browser returns
to Settings on that event or an operational `SETUP_REQUIRED` response.

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
node cli.mjs status                        # list services and status
node cli.mjs prs                           # list your open PRs
node cli.mjs my-tickets [--include-done] [--json]
                                           # list Jira tickets assigned to you
node cli.mjs releases [--version <id|name>] [--all] [--json]
                                           # list a Jira fix version's tickets and
                                           # whether their PRs merged
node cli.mjs team-velocity [--sprints N] [--out PATH]
                                           # rebuild team-velocity.html (whole-team
                                           # sprint velocity, last 8 sprints)
```

> `npm start` runs the **dashboard server** — the npm script for starting a
> single service is `start:svc`. `status`, `prs`, `my-tickets`, `releases`, and
> `team-velocity` have no npm script; run them through `cli.mjs` directly
> (`node cli.mjs --help` lists every command).

The CLI reads live logs from the dashboard over HTTP when it is running (so
`logs` shows the real captured output). If the dashboard is down, control
commands run their own manager in-process.

Every operational command first checks setup, including direct GitHub/Jira
commands and offline service controls. If the dashboard reports `SETUP_REQUIRED`
or the persisted setup is unready, the command exits nonzero with a Settings
diagnostic instead of falling back. Ready offline fallback uses saved service IDs
and configuration; `node cli.mjs --help` works before setup.

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
   - `GET /api/releases?version=<id>&scope=mine|all&refresh=1` (see [Releases](#releases))
    - `GET /api/config` and the [Settings APIs](#setup-gate-and-apis)

## Home

The landing view, and the one screen meant to answer *"what should I be doing
right now?"*. Reach it through the Home tab or page title once setup is ready;
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
independently and stay open across refreshes; the rows are the same
`ticketRowHtml` the My Tickets tab uses, so a ticket looks the same everywhere.

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
  reviewers are never fetched ([`review.mjs`](review.mjs) asks only for
  submitted reviews), so that is not knowable without a new call. The tile and
  queue group mean: *open PRs by other people, under the approval threshold,
  that you have not reviewed yet* — drafts excluded.
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
`node cli.mjs prs` / `GET /api/prs`. Cards show the PR title, owner, its status
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
in JQL) — as sections grouped by status category (**To Do**, **In Progress**,
**Done**), with sub-groups per status name sorted A→Z and tickets newest-first
within each status. Available in the **My Tickets** tab, via
`node cli.mjs my-tickets` / `GET /api/my-tickets`. Rows show the ticket key
(linked to Jira), summary, status pill (same color mapping as PR ticket
status), sprint pill, priority, issue type, and relative update time.

### Sprints

Each row carries a sprint pill next to its status pill: accent-colored for the
**active** sprint, dashed for a **future** one, struck through when the ticket
has only been in **closed** sprints, and `No sprint` for backlog tickets. A
ticket carried across sprints shows the most relevant one (active → future →
last closed); the full list is in `sprints` on the JSON payload.

A ticket in one of the current **active** sprints also gets an accent rail and a
faint tint on its row (`data-in-current-sprint`), so the current sprint's work
reads as a scan rather than a read of every pill. The status pill keeps its own
color — the two signals are independent, since a Done ticket can still belong to
the active sprint. The rail is an inset box-shadow rather than a border, so the
3px does not shift the row's content out of alignment with the rows below it.

Above the list, a header line names the **current active sprint** with its
dates and days remaining (e.g. `Nexus Sprint 17 · Aug 24 – Sep 6 · 2 days
left`). It is derived from the sprint field of your own tickets rather than
from a board — no extra Jira call — so if none of your tickets are in the
active sprint it reads `No active sprint among your tickets`, and if your
tickets span several boards every active sprint is listed.

Sprint is a Greenhopper custom field whose id is instance-specific
(`customfield_10020` on `pathwise.atlassian.net`). Edit **Jira sprint field** in
Settings to override it. New/changed connections must pass field metadata checks;
at rendering time, absent sprint data produces `No sprint`.

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
(or tick _include Done_ / `node cli.mjs my-tickets --include-done`) to keep
Done tickets; the default hides `statusCategory = Done`. Missing Jira credentials
close the setup gate and direct operational APIs return `409 SETUP_REQUIRED`.

### Review status

Each PR card also shows its review state via a small badge in the meta row —
`approved` (green), `changes requested` (red), or `awaiting review` (muted,
dashed). Hover a badge for a tooltip naming who approved / requested changes.

Review state comes from batched GitHub **GraphQL** requests
(`review.mjs`), and reflects the **latest** review: an approval that followed an
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
`approvalGroups`. The CLI prints the grouped section with `node cli.mjs prs`.
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

| Kind | Color | Statuses |
| ---- | ----- | -------- |
| Queued | muted | `To Do`, `Open`, `Backlog`, `Selected for Development`, `Parking lot`, `Needs Definition`, `Needs Grooming`, `Asynchronous Grooming`, `Assigned`, `Scheduled`, `Ready For Scheduling`, `Discovery`, `Duplicate` |
| Active | accent (blue) | `In Progress`, `Work in progress`, `Pending`, `In Development`, `In Review`, `Ready For Code Review`, `Ready For Testing`, `Testing In Progress`, `Testing`, `QA`, `Awaiting Merge`, `Stakeholder Sign Off`, `Promote to UAT`, `Delivery`, `Ready for delivery`, `Impact`, `In Remediation`, `Reopened` |
| Done | green | `Done`, `Complete`, `Deployed`, `Closed`, `Resolved`, `Remediated`, `Hardening in UAT`, `Ready For Deployment` |
| Attention | red | `Blocked`, `Impediment`, `Rejected`, `Active Incident`, `CS Escalation` |

Matching is case-insensitive; any unmapped status falls back to muted. Note
that Jira files several review/test gates (e.g. `Ready For Code Review`,
`Ready For Testing`, `Awaiting Merge`) under its "To Do" category, but they
are mapped to active here since they are late-stage gates, not untouched
backlog.

## Releases

The **Releases** tab answers *"did the work in this release reach
`ops/development`?"*. A release is a Jira **fix version** of the `TRIPS`
project. For every ticket in the chosen version it lists the GitHub PRs linked
to that ticket and rolls them up into one merge state, with the tickets that
still need attention first. It is available in the **Releases** tab, via
`node cli.mjs releases` and `GET /api/releases`.

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

| State | When |
| ----- | ---- |
| `merged` | every PR counts as merged |
| `partial` | some PRs count as merged and some do not |
| `open` | no PR counts as merged (open, unknown, or merged into another base) |
| `no-pr` | no PR is linked, or every PR was declined |
| `unavailable` | looking up this ticket's PRs failed |

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
  fails, the tab keeps the cards already shown and says *Refresh failed —
  showing last update*, or shows an error when nothing has loaded yet.

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
the cache window. `node cli.mjs releases` runs in its own process, so it shares
no cache with the dashboard and always starts cold.

### Configuration

The project key comes from the optional environment variable
`JIRA_RELEASES_PROJECT` (default `TRIPS`), read when the dashboard or the CLI
starts. There is no Settings field and no change to the saved-settings schema.
A value that is not a valid Jira project key (uppercase letters, digits and
underscores, starting with a letter) fails the request rather than stopping the
dashboard. The Jira URL, email and token are the saved connection used by My
Tickets.

### CLI, HTTP and response

`node cli.mjs releases [--version <id|name>] [--all] [--json]` uses the
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
merge roll-up — are pure and live in [`release-model.mjs`](release-model.mjs);
the Jira calls, caches and concurrency are in [`releases.mjs`](releases.mjs).
The browser's grouping and remembered-version helpers are DOM-free in
[`ui/releases-data.js`](ui/releases-data.js). Tests are
`test/release-*.test.mjs` and `test/ui-releases-*.test.mjs`. The Releases
`data-testid` names (`releases-version`, `releases-scope`, `releases-refresh`,
`releases-meta`, `releases-list`, `releases-group-<state>`,
`release-ticket-<key>`) are pinned by `e2e/releases.spec.js` — treat them as a
contract.

## Services

Edited in **Settings → Local services** and persisted in the settings store.
The initial defaults in [`config.mjs`](config.mjs) mirror these `scripts/run.sh`
commands:

| id        | label                | dir               | command              | port |
| --------- | -------------------- | ----------------- | -------------------- | ---- |
| `be`      | Portage Backend      | `Portage-backend` | `npm run start:dev`  | 8000 |
| `fe`      | Portage Frontend     | `Portage-frontend`| `npm run dev`        | 3000 |
| `legacy`  | TravelTracker API    | `TravelTracker`   | `npm run start:be`   | 8081 |
| `legacy-ui`| TravelTracker UI    | `TravelTracker`   | `npm run serve`      | —    |
| `queue`   | Portage Queue        | `Portage-backend` | `npm run queue:dev`  | —    |

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

The shared helper lives in [`port.mjs`](port.mjs).

## UI layout

The dashboard browser UI is a React + MUI application under `ui-react/`, built
with Vite into `dist/` and served by the existing Node server through
[`static.mjs`](static.mjs). Production uses the built assets; Vite is a
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
  panels/               Home, Services, PRs, My Tickets, Releases and Settings
  styles.css            theme variables plus the established bespoke panel CSS
ui/
  dom.js                esc / slug / clamp / timeAgo
  home-data.js          Home's counting / sprint scoping / urgency ordering (DOM-free)
  work-filters.js       shared PR, ticket and action filtering (DOM-free)
  releases-data.js      release grouping and remembered version (DOM-free)
  components/           domain-free helpers and tested card/diff data rendering

ui-react/styles/        app-owned bespoke styles, imported by the Vite entry
```

React owns the shell, route state, theme, panel state, loading/polling and
interaction behavior. The panels compose shared React primitives for buttons,
cards, filters, listboxes, terminal output and status; domain-free selectors
and established card/diff helpers preserve existing calculations, escaping
and data-testid contracts. Masonry uses CSS multi-column packing with intact
cards and sibling spacing at 760px and 1700px; Services retains an explicit
CSS grid and Home blocks remain indivisible. Legacy DOM panel controllers,
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
- The manager is an in-process class (`manager.mjs`); the CLI and the HTTP
  server both use the same `Manager`, so `logs` is consistent whether the
  dashboard is running or not.
