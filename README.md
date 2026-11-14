# EZAT Dev Dashboard

A small dev-service controller. It runs each EZAT service
(Portage Backend / Frontend, TravelTracker API / UI, Queue) as its own
independently-controllable child process, exposes a dark-mode browser dashboard
with a per-service **Actions** menu (Start, Stop, Restart), and provides an agent-ready log
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
validation details. Once setup is ready, a compact top bar puts **Home → My Tickets
→ Slack** first. Pull Requests, Releases and Services follow in a separate tools
group, with Settings at the end. Below 1200px the tools move into a **Tools**
disclosure (a menu icon on phones), while the first three links stay visible.
The menu supports Tab, Enter and Escape and closes on navigation or an outside
click. All seven views remain available:

- **Home** — manually generated, browser-saved team/person sprint velocity.
  See [Home](#home). Use its tab or click the
  **EZAT Dev Dashboard** title to return to it.
- **My Tickets** — Jira tickets assigned to you (`assignee = currentUser()`) as a
  kanban board with one column per status, each card carrying your open PRs
  with their CI and review state and any Slack threads, under a header line
  naming the current active sprint. An _include Done_ checkbox controls whether
  Done tickets are shown. A Claude icon on each card launches background Claude
  sessions for the ticket. See [My Tickets](#my-tickets) and
  [Claude launcher](#claude-launcher).
- **Slack** — optional. One connect button captures your own Slack web session;
  once connected, one card shows your recent `#ezat_claudio` threads as a board
  (the My Tickets layout) next to the thread watcher. Nothing else in the app
  depends on it. See [Slack](#slack).
- **Pull Requests** — other-assigned Jira tickets in Ready For Code Review, grouped
  automatically into To Review, Reviewing and Reviewed, including tickets without PRs,
  and a Spec review lane of open `ezat-specs` spec PRs with no code PR yet.
  See [PR review board](#open-prs).
- **Releases** — the tickets of one Jira fix version (the picker defaults to the
  earliest unreleased EZAT version), each with its GitHub PRs, grouped by
  whether the work reached `ops/development`. It opens on your own tickets;
  **All release tickets** widens it. See [Releases](#releases).
- **Services** — one card per service, each showing its status and a log
  viewport that tails the last 40 lines (_Show full_ reveals everything). The
  card header is two rows: name, directory, port and a status chip (a green dot
  for running, red for exited with an error, grey for stopped or a clean exit),
  then the **checkout** select and an **Actions** menu with Start, Stop and
  Restart. The select runs the service from another git worktree of its repo.
  See [Worktree picker](#worktree-picker).
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
- The [Claude launcher](#claude-launcher) is host only too. The image has no
  `claude` command, so a launch is refused with `listing_unavailable`, and
  `claude/` is in `.dockerignore`.

## Settings and setup

### Saved configuration and credentials

The dashboard persists configuration outside the project:

| Path                                                         | Contents                                                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/dev-dashboard/settings.json`                      | Versioned non-secret settings (`schemaVersion: 1`), revision, migration origin, integration acceptance metadata and the `slackWatch` section |
| `~/.config/dev-dashboard/checkouts.json`                     | Worktree each repo's services run from; written by the checkout picker (see [Worktree picker](#worktree-picker))                             |
| `~/.config/dev-dashboard/slack-watch/map.json`               | Watched Slack links and the session ids attached to each; written by the Slack watcher only (see [Watch](#watch))                            |
| `~/.config/dev-dashboard/slack-watch/inbox/<session-id>.log` | One notice line per wake for an attached session; plain text, created and removed by the watcher                                             |
| `~/.config/github/token`                                     | GitHub token                                                                                                                                 |
| `~/.config/jira/token`                                       | Jira API token                                                                                                                               |
| `~/.config/slack/session.json`                               | Slack web-session credentials (`xoxc-` token + `d` cookie), only after you connect Slack                                                     |
| `claude/<KEY>/status.json`, `launch.json`                    | Claude launcher state per ticket, in the dashboard directory, not under `~/.config`; gitignored (see [Claude launcher](#claude-launcher))    |

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
tickets, team velocity, releases and diff) return `409 SETUP_REQUIRED` before doing their work.
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

The Slack routes and the `/api/claude/*` routes (see
[Claude launcher](#claude-launcher)) also answer before setup is complete, because
they need neither GitHub nor Jira.

### Slack watch settings

The Slack watcher has three settings, kept in a `slackWatch` section of
`settings.json`. They are edited on the Slack tab's **Watch threads** view (and
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
and configuration; `node backend/cli.mjs --help` works before setup. In that in-process
fallback, `start`, `stop` and `restart` exit 1 and print the manager's error to stderr when it
returns `{ ok: false }` (for example `service did not stop`) instead of the `(in-process)`
success line.

## Agent interface

An agent can read the same logs three ways:

1. **CLI** — `npm run logs -- <id> --lines 40`
2. **Files** — rolling tail written to `logs/<id>/out.log` (gitignored)
3. **HTTP**
   - `GET /api/logs/:id?lines=N`
   - `GET /api/services`
   - `POST /api/services/:id/{start|stop|restart}`
   - `GET /api/repos/:dir/worktrees` and `PUT /api/repos/:dir/checkout` (a repo's git worktrees, and which one its services run from; see [Worktree picker](#worktree-picker))
   - `GET /api/repos/checkout-matches?key=TAP-n` (which worktree of each service repo belongs to a ticket; read at click time only, see [Worktree picker](#worktree-picker))
   - `GET /api/events` (SSE live status)
   - `GET /api/prs`
   - `GET /api/review-tickets` (other-assigned review-ready Jira tickets with all linked open PRs in watched repos; see [PR review board](#open-prs))
   - `GET /api/spec-reviews?limit=3` (all eligible directly requested `ezat-specs` specs plus up to `limit` others; see [Spec review lane](#spec-review-lane))
   - `GET /api/my-tickets?includeDone=0|1`
   - `GET /api/team-velocity` (all-team/person sprint aggregates; see [Home](#home))
   - `GET /api/ticket-prs` (your open PRs keyed by ticket, with review, CI and review-comment state; see [My Tickets](#my-tickets))
   - `GET /api/releases?version=<id>&scope=mine|all&refresh=1` (see [Releases](#releases))
   - `GET /api/claude/tickets`, `POST /api/claude/launch`, `POST /api/claude/answers`, `POST /api/claude/approve`, `POST /api/claude/continue` and `POST /api/claude/rereview` (see [Claude launcher](#claude-launcher))
   - `GET /api/claude/usage?sessions=<uuid>,...` (token tallies per session; see [Claude usage](#claude-usage))
   - `GET /api/health` (integration health; see [Integration health](#integration-health))
   - `POST /api/claude/chat/send`, `POST /api/claude/chat/stop` and `GET /api/claude/chat/stream?session=<uuid>` (SSE; chat with a session, with or without a ticket; see [Chat](#chat))
   - `GET /api/active-sprint-tickets?keys=A-1,B-2` (which of those tickets are in an active Jira sprint; see [Bot bar](#bot-bar))
   - `GET /api/config` and the [Settings APIs](#setup-gate-and-apis)

## Integration health

`GET /api/health` answers `{ generatedAt, integrations: { github, jira, slack } }`; each entry is
`{ status: 'ok' | 'degraded' | 'unknown', lastOkAt, lastFailure: null | { kind, status, at, retryAfterSec } }`.
It is memory only: no upstream call, answered before the setup gate, and it holds no URL, header,
body or secret. My Tickets (Jira, GitHub, Slack), Pull Requests (GitHub, Jira) and Slack (Slack) show
a note from it in their toolbar when an integration is `degraded`; it is read once when a screen
becomes active and again on each refresh, never on a timer.

- **Kinds.** `auth` (401, or 403 without a rate-limit signal), `rate_limit` (429, or 403 with
  `x-ratelimit-remaining: 0` or `Retry-After`; the retry time comes from `Retry-After` or
  `x-ratelimit-reset`), `upstream` (5xx and any other 4xx), `timeout` (a `TimeoutError` or
  `AbortError`) and `network` (everything else a failed fetch raises). A `rate_limit` with a retry time
  blocks later calls to that integration without a request until the time passes, at most 900 s. A
  `Retry-After` in HTTP-date form is ignored (GitHub and Atlassian send seconds).
- **Error envelope.** A classified upstream failure answers `502`
  `{ code: 'UPSTREAM_FAILED', error: '<fixed sentence>', errors: ['<kind>'] }` with one of `Jira
rejected the token.`, `GitHub is rate limiting requests.`, `Slack did not answer in time.`, `<X>
could not be reached.` or `<X> is having trouble answering.`. The underlying error text stays inside
  the server, and a plain error stays `OPERATION_FAILED`.
- **What counts.** The record is made at the response headers, so a body read that times out is not
  counted (the route answers `OPERATION_FAILED` and health stays `ok`). Any 4xx other than 401, 403 and
  429 (a 404 for a deleted PR, a 422) records the integration as `degraded` / `upstream` until the next
  good call. The board note words its retry time once per health answer, not per second.
- **Log lines** (stderr, `[tag] {json}`, one per event, never a stack, body, query, header, token or
  chat text). `[http]` `{ method, route, status, code, name, errCode, message }` is written only for a
  status of 500 or more: every 4xx logs nothing, and a rate-limit cool-down answer (`coolDown: true`)
  is not logged again, since `GET /api/health` already says why. `route` is the pathname only.
  `message` is the first line, scrubbed of `Bearer` / `Basic` values, `ghp_`, `github_pat_` and `xox*-`
  tokens, URL userinfo (`scheme://[token]@host`) and URL queries, cut to 200 characters, and absent
  under `/api/claude/chat` and `/api/slack/` and for any `SyntaxError`. `[server]`
  `{ step: 'listen' | 'startup', port?, name, code, message }` exits with code 1 as before, and
  `[process]` `{ event: 'unhandledRejection' | 'uncaughtException', name, code, message }`.
- **Process handlers** (installed by `start()` only). An unhandled rejection is logged and the process
  continues; an uncaught exception is logged, runs the graceful shutdown (stops the detached services)
  once and exits 1, and a second one during shutdown exits at once.

## Home

The landing view is a **Velocity** workspace, replacing the Sprint, KPI,
Needs You and Services widgets. Reach it through the Home tab or page title
once setup is ready; a bare URL or unknown hash also lands here in ready mode.
The dedicated My Tickets, Pull Requests, Slack and Services screens are unchanged.

**Generate velocity** explicitly loads Jira sprint history and saves one aggregate
snapshot for every team and person in this browser. Later visits restore it
immediately, including its original **Generated** local date/time. **Refresh**
explicitly replaces it. Home never fetches velocity automatically: no mount,
reload, tab activation, focus, visibility, polling, countdown or TTL refresh,
even for old, missing or invalid saved data. Without a usable snapshot, Generate
remains an actionable empty state. Home no longer requests personal tickets or
PRs; the application's shared service feed still operates independently.

**Team** defaults to **Nexus** and remembers explicit changes across reloads.
In All displayed sprints, an unavailable saved team stays selected with a named
no-history state, rather than silently switching teams. **Person** defaults to **Everyone** (the whole
team); selecting a person or a row in the **People** breakdown
scopes the chart locally, with no request. Total points include all statuses over
the same displayed sprint window, including zero totals, Unassigned and Unknown
assignee where present. Thin bars use the chart's status colors and a shared
point scale across people. People and the Person selector sort by total points,
highest first within the selected sprint window, with alphabetical ties. This is
not a productivity ranking. Display
labels are disambiguated consistently across the selector, rows and chart.
Person selection is not persisted: Team changes and reloads reset Everyone;
Refresh retains the selected person only if that identity still exists in the
selected team/sprint window. The selectors remain usable during generation.

The selectors cascade left to right: **Sprint → Team → Person**. **Sprint** defaults
to **All displayed sprints**, followed by unique global sprints in descending numeric
order. Team-specific names such as Nexus Sprint 22 and Mobile Sprint 22 share
**Sprint 22**, regardless of Jira ID; nonstandard names match exactly. Choosing a
sprint limits Team to teams containing it and Person/People to those with sprint
memberships, including zero-point and unestimated work, Unassigned and Unknown.
An eligible Team and Person are retained; otherwise Team switches to the first
eligible team and Person resets to Everyone. Automatic Team changes are remembered
like explicit changes. Team changes keep Sprint and reset Person; Person changes
keep both parents. Everyone, individual charts and People status bars use the same
sprint window and shared team/person scales, with the selected sprint in the caption.
All mode restores the full team and people choices. Refresh reconciles these same
dependencies, returning to All only if the global sprint disappeared. Reload keeps
only Team. All filtering uses the full saved snapshot without changing it or fetching.

**Sprint history · story points** shows up to eight latest active/closed sprints
per team, oldest to newest, with Completed, In progress and Not started stacks
on a zero-based scale. Future sprints are excluded; missing end dates sort as
oldest, not invented dates. Totals and exact sprint/status values are available
without hovering; zero estimates remain zero and unestimated memberships are
counted separately. Activating a sprint bar opens its details, reveals the
selected row and focuses its heading; simply restoring, filtering or refreshing
does not move focus there. Narrow charts scroll horizontally inside the pane.

### Snapshot semantics and failure safety

- Points use the **current Jira status, estimate and assignee at generation**
  for each retained sprint membership, not historical ownership or delivered
  points at sprint closure. Teams derive from sprint names, not Jira board IDs.
  Carried issues count in each sprint membership, not as unique delivered work.
- History completeness is **not verified**. A possible 5,000-issue query-limit
  warning is conservative; absence of that warning does not prove completeness.
  Name-based identity fallback may merge same-name people and changes on rename.
- A failed Refresh or invalid response retains the last-good chart, saved data
  and Generated time, with an explicit stale/error note and manual retry. A
  failed first Generate leaves Generate available. Concurrent generation is guarded.
- A storage quota/access failure does not discard successfully generated data:
  it stays usable in memory with **Could not save velocity in this browser; this
  update may not survive reload.** Reload restores a previous valid saved
  snapshot, if available, or the empty state; it never triggers recovery fetching.
  A later successful save clears the warning. Team preference storage failure is
  nonfatal, but the choice may not survive reload.

### API and browser storage

`GET /api/team-velocity` returns `{ boards, keep, coverage, updatedAt }`.
Each alphabetically ordered board is `{ name, series, people }`; each person is
`{ id, displayName, series }`, aligned and zero-filled to the same team sprint
window. Series entries contain `{ sprint: { id, name, state, endDate }, points,
count, unestimated, byStatus: { done, inProgress, notStarted } }`. `keep` is 8;
`coverage` is `{ completeness: 'unknown', possibleTruncation,
maxIssuesPerQuery: 5000 }`, and `updatedAt` is the successful generation timestamp.
The response contains aggregates and pseudonymous person IDs, not raw issues,
account IDs, emails or credentials; pseudonymization is not anonymization.

The read route is [setup-gated](#setup-gate-and-apis), sends no-store responses,
and rejects cross-site/same-site browser requests before Jira reads with sanitized
`403 OPERATION_FAILED`. Upstream failure returns a sanitized `502` rather than
an empty success. There is no server-side team/person filter; those views use
the saved all-team result locally.

Browser-local localStorage records are separate from work filters:

- `dev-dashboard.home-velocity`: `{ version: 1, team }`, defaulting to Nexus
  when absent/invalid; written on explicit or cascading Team changes.
- `dev-dashboard.home-velocity.snapshot`: `{ version: 2, snapshot }`, holding
  the entire API aggregate and original timestamp. Only validated whitelisted
  fields are restored/saved. Invalid structure, impossible arithmetic,
  inconsistent team/person totals and old/personless snapshots are rejected without
  repair, overwriting on read or automatic fetch. Legitimate fractional values
  are preserved with floating-point tolerance. Explicit Generate is required
  when no usable snapshot exists; valid empty results remain generated snapshots.

The adapter is [`backend/home-velocity.mjs`](backend/home-velocity.mjs), snapshot
validation/storage is [`ui/home-velocity.js`](ui/home-velocity.js), and chart
interaction is [`ui-react/components/TeamVelocityChart.jsx`](ui-react/components/TeamVelocityChart.jsx).
Coverage lives in `test/home-velocity.test.mjs`, `test/home-velocity-route.test.mjs`,
`test/home-velocity-preferences.test.mjs` and `e2e/home-velocity.spec.js`.
Home reuses the server's team aggregation helpers without generating or changing
`team-velocity.html`; the standalone CLI/report remains separate and unchanged.

## Open PRs

The **Pull Requests** tab is a Jira-first review board using the same shared
board shell as My Tickets and Slack. Each card is one Jira ticket assigned to
someone other than Jira's authenticated current user, in **Ready For Code Review**.
Your own and unassigned tickets are excluded; eligible tickets with no PRs remain.

Each card lists every linked **open** PR across the **current watched repositories
in Settings**, from any author, including drafts and any configured specs repo.
Links come from ticket keys in PR titles, with the existing `TRIPS-n` → `TAP-n`
alias. Multiple repositories share one ticket card, each PR labelled by repository;
a PR naming two eligible tickets can appear on both cards. Closed/merged history,
unwatched repos and branch-only/Jira-development links are not fetched. Unticketed
PRs do not create cards. Cards retain Jira links, sprint cues, PR links and the
existing diff action.

### Automatic review lanes

Progress is derived from **all linked open PRs before filters**, never saved or
manually moved. With complete discovery and review evidence:

- **Reviewed** requires at least one PR, every PR currently approved by anyone,
  no drafts and no standing changes requests.
- **Reviewing** means at least one current approval or standing changes request,
  but not all work qualifies as Reviewed. An approved draft stays here. It does
  not mean someone is currently reading the PR.
- **To Review** covers the rest, including no linked PRs and drafts without
  actionable review activity. Comments and pending reviews alone do not count.

Missing/incomplete discovery takes priority and keeps **every ticket To Review**;
unknown review evidence keeps the affected ticket there even if its other PRs are
approved. Known PRs remain visible with an incomplete-data warning. Dismissed or
superseded approvals do not count. CI and the configured minimum-approver threshold
are not lane gates. Hover a lane heading or reach it with **Tab** for its meaning;
Escape, blur or mouse leave dismisses the help.

The tab reads `GET /api/review-tickets`, which pages Jira eligibility and watched-repo
open PRs rather than using the legacy own-PR result cap. It returns
`{ total, tickets, prCoverage: { available, complete, repos, reasons }, updatedAt }`;
each ticket carries its linked `prs` and each PR its current review evidence.
Coverage describes only the configured watched repos, not every GitHub repository.
Jira failure is a queue error, not an empty queue. GitHub failure retains the Jira
tickets and known PRs without implying completion or a confirmed absence of PRs.
The read route is setup-gated, uses no-store responses and rejects cross-site or
same-site browser requests before upstream reads. Deploy the backend route before
or with the UI; there is no fallback to the old PR sections.

While active, the board refreshes every **90 seconds** and shows a countdown;
polling pauses while hidden or backgrounded. **Refresh** starts a guarded load and
restarts the countdown. New PR/review evidence moves cards automatically in either
direction while preserving scroll and focus. A failed refresh labels the retained
snapshot as the last successful update, not current progress.

The card's **Claude** button opens a review dialog that shares the My Tickets dialog's look: the
key and summary with the review state as a pill in the header, then **Start code review** and
**Re-review** side by side, launch/error feedback and **Close**. There is one filled button by
state: **Start code review** while there is no review, **Re-review** once a review session exists
and can take a message (then starting another review is a quiet button named **Start new review**,
with the same behaviour); while the review works both are off and the reason is one line. A message
about a send has a **×** and clears once the review stops working. After a re-review, `Last
re-review requested <time>` shows as quiet text. The PR icon has no
hover/focus tooltip but retains the accessible name `Claude code review for <KEY>`;
My Tickets tooltips are unchanged. The same Start control handles first review and
re-review through the existing [Claude launcher](#code-review), independently of
the My Tickets workflow. Start disables during submission or when the server's
review state refuses another launch. Status refreshes while the dialog is open
on the active tab and the page is visible; reopening refreshes it too. Completion
means the session finished, not that the review passed.

Close, Escape or a genuine backdrop click dismisses the native modal; dragging
from its content to the backdrop does not. It survives filtering/lane movement
but closes on leaving the tab or ticket removal. Focus returns to the PR opener
or the board if the opener is filtered out. This dialog has no prompt editor,
answers form or Go to session control, and the PR card has no review-status badge.
Review templates are editable through the shared **Prompts** editor in the My Tickets Claude
dialog (see [Custom prompts](#custom-prompts)); no editor button is added to the review dialog.

Next to **Start code review**, **Re-review** sends a message to the ticket's existing review
session, asking it to review the linked PRs again (see [Code review](#code-review)). It is off
until a review session exists and is idle, and says why (`Start a code review first.`, or that the
session is running). After it is sent the dialog shows when it was last requested.

### Spec review lane

The fourth column, **Spec review**, lists open PRs in `TransActComm/ezat-specs` that carry
the `spec` label and whose title names a ticket (`TAP-n` or `TRIPS-n`). A spec drops out when
an open or merged PR in Portage-backend, Portage-frontend or TravelTracker names the same key
in its title or head branch. Specs with no ticket key are not listed. Each card shows its keys
as Jira links, the PR, its author, age in days, reviews by others, a Draft chip on a draft PR and a
review chip (below). The repos and label are fixed in code, not the Settings watched list, and spec
cards ignore the work filters.

The lane initially shows **all eligible specs directly requesting your review**, followed by the
**three newest eligible other specs**. Each group is ordered newest first by creation time. **Load more**
requests six others, then nine, and so on, without limiting your requested cards. Each successful answer
replaces the whole list rather than appending it. Refresh and polling keep the last successfully expanded
count, even if fewer others remain; tab switches keep it, while reloading the page resets it to three.
Load more reads only the spec feed, not tickets or Slack. Load more and manual Refresh are disabled while
a spec request is pending; ticket/Slack polling still settles independently. Concurrent spec triggers
are skipped rather than queued. No Load more button appears after a proven end.

The feed is `GET /api/spec-reviews?limit=3`; omission defaults to 3. `limit` counts **eligible others**,
not directly requested specs. It accepts one canonical decimal integer from **1 through 1000**.
Blank, repeated, signed, fractional, exponent, whitespace, leading-zero and out-of-range values return
`400 INVALID_SPEC_LIMIT` before any GitHub call. Existing Host/setup guards remain; cross-site or same-site
browser requests get `403 OPERATION_FAILED` before count validation or any GitHub call.
Successful lookups answer 200 with `{ available: true, total, specs, hasMore, updatedAt }`;
`total` equals the returned `specs.length`, including requested cards, not the global eligible total.
`hasMore` is true only after observing another eligible nonrequested spec beyond the selected window;
that lookahead card is not returned. The button is not included in the card count. At the 1000-other
count bound, explicit GitHub-search-limit wording replaces Load more rather than implying unlimited loading.
Each spec carries `number`, `title`, `url`, `author`, `draft`, `keys`, `ageDays`, `reviewsByOthers`,
`review` and boolean `reviewRequested`.

An upstream/eligibility failure answers 200 with
`{ available: false, total: 0, specs: [], hasMore: false, updatedAt }`; false `hasMore` here does not claim
exhaustion. A failed or incomplete refresh/expansion clears the spec lane and hides Load more, but keeps
ticket lanes and an already-open spec dialog. Refresh retries the last successful count, not the failed
larger count. Only a GitHub search ceiling failure adds `reason: 'search_limit'`; the note explains the
1000-match ceiling rather than showing a partial requested set or inventing an end to the others list.
Viewer identity, request lists, search counts/cursors and raw upstream errors are not returned.

GitHub discovery is selective: fixed reviewer-specific requested/other searches are batched in one
GraphQL POST where possible. Every lookup completes requested pagination and scans others only until
the eligible window plus lookahead, or a proven end. A common default asks for four other candidates,
not the entire spec repository; filtered candidates or requested pagination can require more calls.
Expansion re-reads the prefix. A warm single-page feed can still take one spec POST before and after
this change: savings are default payload and unnecessary paging, **not guaranteed fewer API calls**.
Each search connection has GitHub's 1000-match ceiling; inability to establish the complete requested
set or the others window/lookahead within it is unavailable with `search_limit`.

Spec/request/review data is fetched on each feed load; only the existing code-key lookup is cached for
10 minutes, so Refresh does not bypass that cache and a new code PR hides its spec within 10 minutes.
GitHub search indexing and pagination are not an atomic live snapshot: a newly requested spec absent
from the index can remain undiscovered until indexing catches up. Observed current fields reject stale
closed/unlabelled hits and reclassify changed requests; there is no exhaustive fallback or instant
completeness guarantee. The card's **Claude** button opens a dialog with one
action, **Start spec review**, **Re-review** or **Review again** (see below), which posts
`{ key, phase: 'spec-review', pr }`; `pr` is required. The server fills the built-in review template
or `prompts/spec-review.md` with the validated key and PR number (see [Custom prompts](#custom-prompts)), and the
session is named `<KEY>-spec-review`. Its state is in the ticket's [Claude launcher](#claude-launcher)
entry, where `blocks.specReview` appears only once a spec review was launched.

`review` is the signed-in user's own state on the PR, worked out fresh from GitHub when the feed is read.
`current` means their newest submitted review is on the PR's
current head commit; `stale` means it is on an earlier commit, so the PR has new commits since their
review; `none` means they have no submitted review, or the lookup has no head commit. A missing viewer
login makes discovery unavailable rather than claiming that every requested spec is known.
The dashboard stores nothing for it. A `current` card shows a **Reviewed** chip, a `stale` card shows
**New commits since your review**, and `none` shows no chip. The dialog's action reads **Start spec
review** for `none`, **Re-review** for `stale` and **Review again** for `current`; all three send the
same launch and stay enabled.

`reviewRequested` is true only when GitHub has a pending direct **User** review request for the
authenticated viewer. Requests for another user or a team do not count. A true card has an amber-tinted
background, an amber edge and a **Your review requested** chip; false or absent keeps the ordinary
appearance. This is independent of `review`: a previously reviewed spec stays visible and is highlighted
if requested again, alongside its existing review chip. The highlight clears when the feed reports the
request removed on a fresh feed load, subject to GitHub search indexing lag.

The built-in spec review prompt requests an unattended review as the signed-in user. A custom
`prompts/spec-review.md` replaces those instructions in full. The launch enforces part of its limits on
the command line, for this session only, and no prompt can widen them: the built-in tools are only `Read`,
`Skill` and `ToolSearch` (no `Bash`, `Edit`, `Write`, `Grep`, `Glob`, `WebFetch` or `Agent`); it gets no
`--add-dir`, so no workflow state folder; it loads only the servers that the `.mcp.json` of the launch
directory (`~/pathwise`) names, with `--strict-mcp-config`. That file is untracked, and a session that can
write there can change it, so the session gets whatever servers the file lists at launch. The file should
name `toolkit-mcp` only. Today it names `toolkit-mcp` alone, and in the manual probe on this machine the
claude.ai connectors and the Playwright, memory, wiki and taskboard servers were not loaded; and a deny list
blocks 28 toolkit tools (GitHub PR create, merge, update, label, assignee and reviewer writes, PR comment and
review-comment writes, thread resolve and review dismissal; Jira issue, comment, link and transition writes;
Confluence page writes; the Figma comment post; Slack login and logout) and the `Read` tool on 28 named paths,
covering secrets, configuration, SQL dumps, CSV table exports and uploads, and browser and test-runner auth
state: `~/.config`, `~/.ssh`, `~/.aws`, `~/.claude.json`, `.env*`, `config.json` and `config.json.*`,
`.mcp.json`, `*.sql`, `*.csv`, `./TravelTracker/files`, `./.worktrees`, `./.corpus_runs`, `.playwright`,
`./.playwright-mcp`, `cypress.env.json`, `auth.json`, `~/.claude/.credentials.json`, `~/.claude/projects`,
`~/.claude/history.jsonl`, `~/.bash_history*`, `~/.local/share`, `~/.git-credentials`, `~/.npmrc`, `~/.netrc`,
`~/.docker`, `~/.gnupg` and `//ezat`. That deny list is an explicit list of named tools and paths, not an
exhaustive one: a `Read` inside the working directory is otherwise unrestricted, and other reads follow the
user's own settings. Its tool entries are all `toolkit-mcp` tools, because the file names no other server
today. The deny rules cover `Read` only, because `Grep` and `Glob` are not available to this session. The
read tools, `github_submit_pr_review` and the Slack `slack_prepare_write` and `slack_confirm_write` pair stay
allowed.

Everything else below is only the built-in prompt's instruction, not enforced by the launch or
automatically added to a custom template. By default, the session is told to submit one
`COMMENT` review on the spec PR (never an approval or a changes request, since `github_submit_pr_review`
accepts any event; the merge and the push are blocked by the launch), to mention nobody, quote no Jira or
Slack text and link nowhere but that PR. It is told to reply once in the ticket's existing `#ezat_claudio`
thread, found by searching the ticket key there and never from a Slack link in the ticket or the PR, with
`expected_destination` set to `ezat_claudio`; the reply is a two-line summary of the verdict counts and a
link to the review, and no other link. It skips Slack when there is no thread or more than one matches, and
sends only when its preview shows no mentions and no warnings. It reads only the skill files it loads, and it
makes no other write. If the session cannot finish the review, it posts nothing. A ticket with no existing
thread gets no Slack reply, and no thread is created.

The residual is inherent, and this repo cannot close it. The session must keep `github_submit_pr_review`,
`slack_prepare_write` and `slack_confirm_write`, and the user allows them, so an instruction injected through
the spec, its ticket or the Slack thread can still submit a review with any event on any PR the user can
review, or post what it can read to any Slack destination. Only the prompt stops those. Closing it is the
user's decision: narrow their own `mcp__toolkit-mcp__*` allow rule to named tools, run the session with
`--restricted` and an exact allowlist, or use tools whose arguments are locked (a review locked to `COMMENT`
on `ezat-specs`, a Slack write locked to one channel). The dashboard never edits a settings file, and
`mcp__toolkit-mcp__*` stays allowed in the user's own settings, so every other session keeps it. The
dashboard records nothing beyond the existing `spec-review` record in the ticket's `launch.json` (session
name, launch time and session id). A finished review is visible as the PR review itself, and its Slack reply
as the message in that thread.

### Local work filters

Pull Requests has **Search**, **Ticket prefix**, **Repository** and **Review state**.
Prefix options are sorted unique project prefixes from all fetched ticket keys,
not PR titles or currently visible cards; **All** is the default. Prefix matches
exactly and combines with the other filters. A match keeps the whole ticket,
every PR line and its original lane, so hiding a pending repo cannot manufacture
Reviewed. Matching PR-free tickets remain under All repository/review states;
a specific repository/review state requires a matching PR. Missing or unreadable
review evidence is **Unknown**, separate from awaiting review. Counts are tickets,
not PRs, and **Clear filters** resets all four controls. On narrow screens the
dropdowns and Clear sit behind **Filters** beside Search. The old Section filter
and four PR sections are retired on this screen only.

My Tickets has **Search**, **Status**, **Sprint**, **Priority** and **Type**;
sprint membership includes a ticket's full sprint history, using IDs when available.

Search is immediate, case-insensitive and literal (punctuation is not a regular
expression). Search and dropdowns combine with AND over already fetched data,
without extra requests or changing server eligibility. Counts show matching
versus fetched items (tickets on the PR board); an empty filtered list says
**No matches**. Fetch-cap and stale-data warnings still apply. **Include Done**
remains the separate remote-scope control.

**Clear filters** resets only its own view and saves that reset.
Each set of filters survives tab switches, refreshes and reloads in version-1
browser localStorage (`dev-dashboard.work-filters`), including all four PR values:
Search, Ticket prefix, Repository and Review state. With no valid saved choices,
Search is empty and every dropdown is **All**; valid saved choices take precedence.
Clear followed by reload keeps those defaults. Previously saved version-1 prefix
strings are restored without a migration; obsolete saved Section values are ignored.
Malformed, unsupported or invalid saved state falls back
to defaults; blocked/full storage leaves filtering usable in memory. A selected
option missing from refreshed data stays selected until cleared, so it cannot
silently broaden the list. Filters are browser-local and are not shared in URLs.

### Legacy PR feeds

`GET /api/prs` retains its existing own-PR, draft, approval-threshold and
merge-candidate contracts. The CLI's
`node backend/cli.mjs prs` retains its own-PR and approval output.
Neither is the new review queue. `/api/ticket-prs` remains the
own-author PR feed used by My Tickets. My Tickets, Slack and the existing
diff viewer keep their behavior.

Configure the GitHub owner, repositories and token through **Settings**. Missing
credentials close the all-integrations setup gate; environment tokens are
supported for [legacy migration](#automatic-legacy-migration).

### PR merge candidates to ops/development

The legacy PR API still supplies merge candidates: your Jira tickets in
**Promote to UAT** whose linked PR is open and targets `ops/development`.
This is no longer a section on Pull Requests; it is not one of the board's lanes.

## My Tickets

The dashboard shows Jira tickets assigned to you (`assignee = currentUser()`
in JQL) as a **kanban board**: one column per Jira status among your tickets,
with the most recently updated ticket first in each column. Available in the
**My Tickets** tab, via `node backend/cli.mjs my-tickets` / `GET /api/my-tickets`.
Each card also carries your open PRs with their CI, review and review-comment
state, and any Slack threads for the ticket. A card whose open PRs are all
approved turns green.

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
points (`5 pt`, absent when unestimated) and time since the last update. A row under
them holds the [Slack chips](#slack-threads) at its start and the
[Claude icon](#claude-launcher) at its right edge. Below are the summary, clamped to
two lines with the full text in its tooltip, and one line per open PR. The status
and the issue type are not on the card: the column names the status, and Type
stays a filter.

**PR lines** — one link per PR, opening it in a new tab: a CI glyph, `repo #number`
(the repository name without its owner), the review state in words, up to two
review-comment chips (below) and a `Draft` tag for a draft. The glyph differs in
shape as well as colour: a check for passing CI, a cross for failing, an open
ring for pending and a dash for no checks or unreadable ones. Hover a line for
the CI summary, for example `CI failing: lint,
unit-tests (2 of 9 failed)` (at most three failing checks are named); the same
text is in the line's accessible name. The review state reads `approved`,
`changes requested` or `awaiting`, and `review unknown` when it could not be read.
A ticket with two open PRs shows two lines, a PR whose title names two tickets
shows on both cards, and a ticket without a PR shows none.

**Comment chips** — below the PR's name, after the review state, a line shows up
to two small chips counting the PR's GitHub review threads: a person glyph for
threads a person started and a sparkle glyph for Copilot's. A thread belongs to
whoever wrote its first comment; threads started by any other bot or by a deleted
account are in neither chip, and neither are the comments on the PR's main
conversation. A chip reads `unresolved/threads`, for example `2/5`, in amber
while any thread is still open, and the thread count with a check, in muted
text, once all are resolved. A chip is absent when its author has no threads, so
a PR with none shows no chips, and none show when the comment counts could not be
read. GitHub is asked for the first 50 threads of a PR (`reviewThreads(first:
50)`); a PR with more shows a plus (`3/50+`), stays amber whatever the resolved
state, and its `unresolved` is a floor, because threads past the 50 are not
counted. Hover a chip for its words, for example `Human: 2 unresolved, 3
resolved, 9 comments` (the last number is every comment in those threads). The
chips are hidden from assistive tech; the line's accessible name carries the
same words, and also the other-bot threads (`Other: 1 unresolved, 0 resolved, 2
comments`), the conversation comments (`Conversation: 3 comments`), `showing the
first 50 of 63 threads` when cut off and `comments unavailable` when unreadable. Except for the plus on a cut-off
chip, those have no mark on the screen, and the line's own hover text stays the
CI summary.

The Copilot threads are found by the account's login (`copilot-pull-request-reviewer`,
with or without `[bot]`, or `copilot`, in any case). The query's field names and
that login were checked against GitHub's documentation only, never against the
live API. If chips never appear on a PR that has review comments, GitHub
rejecting the query is the probable cause, and it degrades silently to no
chips (the PR's `comments` is `null`, see PR data below); if Copilot's
threads show in neither chip, the login is probably wrong and they are counted
under other bots.

**Green card** — a card turns green when it has at least one open PR and every PR
line reads `approved`: an 8 % green tint, a green hairline and a seal (a check in
a circle) after the key, named `All PRs approved` for assistive tech and in its
tooltip. The card carries `data-all-approved="true"`. A PR whose review is
unknown is not approved, and a PR that reads `changes requested` never is, so a
card with one never turns green even when its other PRs are approved. The green
does not look at CI or drafts: an approved draft with failing CI still counts. It
looks only at the PR lines the card shows, so when `truncated` says some of your
PRs were not fetched, a PR that is missing is not counted. A card with no PR is
never green.

**PR data** — the lines come from `GET /api/ticket-prs`, which the tab calls on its
first load, on every 90 second poll and on **Refresh**. It lists **your** open PRs
(authored by the GitHub user the saved token belongs to) in the watched
repositories from Settings, drafts included and whatever their ticket's Jira status.
This is separate from the other-assigned [PR review board](#open-prs).
A PR is filed under every ticket key in its
title (`[TAP-1665]`, bare `PRT-1221`): `TRIPS-n` keys are filed under `TAP-n`,
any other project's key as written, and a PR whose title has no ticket key is
left out (the legacy `/api/prs` feed still includes it). A key repeated in one title
counts once, and each key's list is newest update first. Only the newest PRs up
to **GitHub maximum results** (1 to 100) in Settings are fetched; `truncated`
says there were more, and the tab then notes that some tickets may show no PR
lines.

```
200 { available, login, total, truncated, updatedAt,
      byTicket: { "<KEY>": [{ repo, number, title, url, draft, updatedAt,
                              review, ci, comments }] } }

review: { state: 'approved' | 'changes_requested' | 'awaiting', approvals } | null
ci:     { state: 'passing' | 'failing' | 'pending' | 'none',
          passed, failed, pending, failing: [name, …] } | null
comments: { human, copilot, other, conversation, threads, truncated } | null
          human, copilot, other: { threads, unresolved, comments }
```

`login` is the GitHub user, `total` GitHub's count of matching open PRs and
`updatedAt` the time the server answered; `repo` is `owner/name`. `review.state`
follows the rule under [Review status](#review-status): a change request that
still stands makes it `changes_requested` even when another reviewer approved
later; with none standing, the newest approval or change request decides, and it
is `awaiting` when there is neither. `approvals` counts the reviewers whose
latest approval or change request is an approval, so it can be above 0 while the
state is `changes_requested`. The board reads each PR's newest 100 reviews; when
GitHub reports older ones outside that window (an older change request could
still stand there), or does not say, `review` is `null` and the line reads
`review unknown`, never `approved`. The Pull Requests tab pages through every
review and has no such window. `ci.state` summarises the PR's latest commit:
`passing` for a success, `failing` for a failure or error, `pending` for pending, expected or any
state the dashboard does not recognise, and `none` when the commit has no checks.
`passed`, `failed` and `pending` count the first 100 checks and commit statuses,
and `failing` names the failed ones, each name once. A `null` `review` or `ci`
means GitHub's answer was unreadable, which is different from `awaiting` or
`none`; the card shows `review unknown` or a dash with `CI status unavailable`.

`comments` is the count behind the comment chips. `human`, `copilot` and `other`
each hold `{ threads, unresolved, comments }` for the review threads whose first
comment was written by a person, by Copilot, or by anyone else (any other bot, a
deleted account, a thread with no readable first comment): the threads read, how
many of them are not resolved, and the sum of every comment in them, replies
included. `conversation` is the number of comments on the PR's main conversation,
outside any review thread. `threads` is GitHub's own count of the PR's review
threads and `truncated` is `true` when it is larger than the threads read (the
query reads `reviewThreads(first: 50)`), so the three buckets then hold partial
counts. `comments` is `null` when GitHub's answer for the PR could not be read: its
batch failed or answered without data, GitHub reported an error on that PR, a
thread list or total came back malformed, or the PR was not asked about. That is
different from a PR with no threads, which has zeros. It holds counts and one
boolean only, no login, title or comment text.

The route is behind the [setup gate](#setup-gate-and-apis): `409 SETUP_REQUIRED`
before setup, and `200` after it whatever GitHub does, except that a browser
request from another site is refused (below). A GitHub problem never
becomes an error, it only narrows what the answer reports: with no token, or
when GitHub fails `/user` or the search, the answer is `{ available: false,
login: null, total: 0, truncated: false, byTicket: {} }` plus `updatedAt`. Review
and CI come from one GraphQL batch per 50 PRs and the comment counts from another,
so a failure in one lane never blanks the other: when a review and CI batch fails,
those PRs are listed with `review: null, ci: null` and keep their `comments`; when a
comment batch fails, those PRs get `comments: null` and keep their review and CI;
when GitHub reports an error on one PR's checks, that PR gets `ci: null` and keeps
its review and comments, and an error on one PR's comment fields nulls only that
PR's `comments`. A token that cannot read checks and commit statuses is expected
to show up that way, as CI unknown on each PR while reviews still work; how GitHub
reports a refused field has not been checked against the live API, and Settings
validation does not probe for it. Neither has the comment query: its field names
(`reviewThreads`, `isResolved`, the comment author's `__typename` and `login`, the
PR's comment `totalCount`) and the Copilot reviewer login were checked against
GitHub's documentation only. If GitHub rejects the query, every PR gets `comments:
null` and the board shows no chips, with no error anywhere. A poll costs one
`GET /user`, one search and two GraphQL requests per 50 PRs (review and CI, then
comments), sent one after another, and the answer waits for both; each call times
out after 15 seconds, and a timeout counts as that call failing. Requests made
while a load is running, with the same saved settings revision, share that
load. Nothing is cached: once it finishes the result is dropped, so the next
poll or **Refresh** asks GitHub again. A load costs many GitHub calls and there is
no result cache, so a browser request whose `Sec-Fetch-Site` is `cross-site` or
`same-site` (a page from another site or another port) gets `403` with the
generic `OPERATION_FAILED` body, before anything is sent to GitHub. The
dashboard's own page (`same-origin`), a typed address (`none`), `curl` and any
request that sends no `Sec-Fetch-Site` are answered as above. The answer carries
no tokens, no upstream error text and no settings. There is no CLI command for
it: `prs` and `my-tickets` call their modules directly, so an agent reads this route over
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
board is keyboard-focusable (arrow keys scroll it). The Slack tab's board is the
same frame, so all of this holds there too (see [UI layout](#ui-layout)).

### Slack threads

A ticket whose key heads a thread you started in `#ezat_claudio` gets a small
Slack chip at the start of the links row under its card's figures — one per matching thread,
newest activity first. The chip is a speech bubble with the thread's reply count
beside it, and a filled dot when the thread needs a reply (its accessible name
says so in words). Clicking it opens a dialog with the conversation in Slack
order, rendered from its own mrkdwn, plus **Copy link** and **Open in Slack**
actions. The conversation can be truncated.
Only the thread's subject line is consulted, so the key must start it. Old
`TRIPS-NNNN` threads match `TAP-NNNN` because Jira's rename carried the numbers
over. The chips reuse the Slack tab's thread list: only threads created within
the last rolling 28 days appear, even if an older thread has a new reply. A
thread disappears when it passes the cutoff, and its open dialog closes. An
incomplete refresh shows only rows confirmed by that refresh, with a warning on
both My Tickets and Slack. In that listing, omitted chips return only if the
current **Load more eligible threads** retrieves them; My Tickets picks them up
on its next shared-list read. Chips do not appear when Slack is not connected.
The dialog also has a **Claude session** section that attaches and detaches
Claude Code sessions for the thread on the [watcher](#watch).

A thread with a Claude session attached through the watcher draws its chip filled
(a low-opacity fill inside the bubble's outline) and in the support colour, and its
label (the tooltip and accessible name) adds `Claude session attached`, or `2
Claude sessions attached` for two. An unattached chip is unchanged, and so is
every chip when the watcher is disabled. The count rides
on the thread list: each row of `started` in `GET /api/slack/threads` carries
`attachedSessions`, the number of sessions the watch list holds for that thread
(`0` for none, and for a row with no `watchKey`). It is worked out on every
answer from the watch list, not cached with the Slack thread list, and it is `0`
on every row when the watcher is disabled (no Claude home directory, as in the
Docker image) or the watch list cannot be read; the route still answers `200`.
`mentions` rows do not receive `attachedSessions`, and an unavailable result comes
through as it was. The board never reads `GET /api/slack/watch`. It reads
`/api/slack/threads` once more when the thread dialog closes, so an attach or
detach made in the dialog shows when it closes. Two other readings of "attached" were
not built: a chip drawn on every card, grey without a thread, and a Slack colour
on the comment chip.

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

The retained legacy PR renderer shows review state via a small badge in the meta row —
`approved` (green), `changes requested` (red), or `awaiting review` (muted,
dashed). Hover a badge for a tooltip naming who approved / requested changes.

Review state comes from batched GitHub **GraphQL** requests
(`backend/review.mjs`). Each reviewer's latest approval or change request counts;
`COMMENTED`, `DISMISSED` and `PENDING` reviews are ignored. **A change request
that still stands outranks approvals:** while any reviewer's latest approval or
change request is a change request, the PR reads `changes requested` and never
`approved`, even when another reviewer approved after it. A reviewer's own later
approval clears their request. With no request standing, the newest approval or change request decides.
The one exception is a change request from an account with no login (a deleted
user): it cannot be tied to a reviewer, so it counts only while it is the newest
approval or change request on the PR, and a later approval overrides it.
`approvals` and the [approval threshold](#approval-threshold) count approvers
only, so a PR can show `changes requested` and still have approvals. The same
rule feeds the My Tickets board through the shared `summarizeReviews` function.
If the token cannot read review data, the dashboard can omit the badge when a
runtime review fetch fails — open PRs are unaffected.
Fresh/changed integration setup also requires the GraphQL access probe.
The [PR review board](#automatic-review-lanes) uses a separate current-evidence
normalizer, including dismissals and fail-closed completeness; its lane rules do
not change this legacy contract.

### Approval threshold

The legacy PR API/CLI includes open PRs that have fewer than
the configured number of distinct approved reviewers. Configure **Minimum PR
approvers** in Settings (defaults to `1`). Legacy `MIN_PR_APPROVER` is imported
during migration.

The comparison is strict, so a PR with exactly the configured number of approvals
is not listed. Each reviewer counts once, and only that reviewer's latest actionable
review counts — a later `CHANGES_REQUESTED` review removes an earlier approval.
Settings rejects invalid, zero, negative, fractional and non-integer values;
invalid legacy environment values use the default of `1` during migration.

This is a separate open-PR feed that excludes your own PRs, not a second filter
of your own PRs. It is grouped by ticket.
The same filtered data is available from `GET /api/prs` in
`approvalThreshold`, `reviewDataAvailable`, `prsNeedingApprovals`, and
`approvalGroups`. The CLI prints the grouped section with `node backend/cli.mjs prs`.
When GitHub review data cannot be loaded, the normal open PR list remains
available and the approval section is reported as unavailable rather than
treating every PR as having zero approvals.

In the legacy API, on top of the approval-count filter, a ticket group appears only while its Jira
status is **Ready For Code Review**; `Unticketed` groups are exempt, and unavailable
Jira status hides ticketed groups. This legacy threshold does not affect the new
PR board's ticket membership or lanes.

### Ticket status

Each ticket group heading also shows the ticket's current Jira status using the
saved Jira connection. Configure the URL, email, token and custom fields through
Settings. Legacy Jira environment keys are imported as described under
[Automatic legacy migration](#automatic-legacy-migration). A failed status fetch
can omit status data; incomplete Jira setup restricts the whole UI to Settings.

The ticket status pill (and the card's side rail) is color-coded by status
kind — all site statuses are mapped in `ui/jira-status.js`:

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

## Claude launcher

My Tickets and Pull Requests share the host-only launch transport. Pull Requests offers the
independent [Start code review](#code-review) action; the workflow dialog below is My Tickets only.

Each card on the **My Tickets** board ends its top line with a **Claude icon**. It shows where
the ticket stands with Claude and opens a dialog with one row per action, each holding two buttons:

- **Investigate and plan** starts a background Claude session that investigates the ticket,
  writes a plan and stops at the approval gate.
- **Implement plan** starts a second session that builds the plan you approved.
- **Groom ticket** starts a third, independent session that runs your `groom-ticket` skill on
  the ticket, whatever its Jira status. It is not part of the investigate and implement
  workflow: see [Groom ticket](#groom-ticket).
- **E2E check** opens a new browser for you to sign in to, then starts a fourth, independent
  session that runs your `e2e-ticket-check` skill against it: see [E2E check](#e2e-check).
- **Go to session**, one beside each of those, copies the command that joins or resumes that
  row's own session in a terminal. Its accessible name is the full one, `Go to investigate and
plan session`, `Go to implement plan session`, `Go to groom ticket session` or `Go to e2e check session`.

Each of these My Tickets launches is fire and forget. The dashboard runs `claude --bg` from `~/pathwise`, names the
session after the ticket and the phase, `<KEY>-investigate-and-plan`, `<KEY>-implement-plan`,
`<KEY>-groom` or `<KEY>-e2e-ticket-check`, and returns. It never opens a terminal and never removes a session. It stops and resumes a session
only to send a message to it: your saved answers (and a resend) or your approval to the planning
session (see [Saving and sending answers](#saving-and-sending-answers) and
[Approving the plan](#approving-the-plan)), or a re-review to the review session (see
[Code review](#code-review)). All of those go through one send path, described under
[Saving and sending answers](#saving-and-sending-answers), and it never sends text into a running
one. The Jira summary never reaches the launch: the request carries only the key and the phase. By
default the prompts are the built-in text with the key and the key in lower case filled in, and
for the two workflow phases the path of the ticket's `status.json` too (you can replace them, see
[Custom prompts](#custom-prompts)), so the summary is never part of what a session is told to do. The built-in workflow prompts tell the session
to use your `orchestrator` skill
(step 1 for Investigate and plan, step 3 for Implement plan) and to treat ticket text as data. The
planning session writes `02-plan.md`, `02-checklist.md` and `02-spec.md` in
`~/pathwise/.orchestrator/<key in lower case>/`, creates no branch, commit, push or pull request,
and writes the questions it would have asked you into `status.json` instead, each with lettered
options (a, b, c) inline in the question text, a recommended default and the phase that asked it,
in under 450 characters because the dashboard cuts a question off at 500. Once every question
has an answer you saved, the dashboard sends the planning answers back to that same planning
session, which is told to update the plan, checklist and spec and then set `done`. Once it has,
you approve the plan with **Approve plan** (see [Approving the plan](#approving-the-plan)) and only
then can Implement plan start. A question the implement session later asks is answered the same
way and resumes that same implement session, which continues the approved implementation. Implement
builds what the plan, checklist and spec say: they are the single source of truth, and the session
does not read the saved answers as decisions. It commits its changes in the worktree on that
worktree's own branch, never pushes or opens a pull request, and leaves a short report beside the plan.

### Requirements and limits

- **Host only.** It needs the `claude` command on `PATH` and a `~/pathwise` directory that
  `claude` trusts: run `claude` there once and accept the trust prompt, or a launch fails with
  `untrusted_workspace`. The Docker image has no `claude`, so there every launch is refused with
  `listing_unavailable`. Workflow sessions also need your user-level `orchestrator` skill;
  review needs `pr-review-transact` and the applicable publishing skills in `~/pathwise`.
- **Your permission mode.** The dashboard passes no permission flag, so a session runs under your
  own Claude settings and permission mode and can do what your user can.
- **No dashboard tokens.** A launched session does not inherit `GH_TOKEN`, `GITHUB_TOKEN`,
  `JIRA_API_TOKEN` or `JIRA_TOKEN` from the dashboard's environment (the same four names the
  dashboard keeps out of the services it starts). It uses its own credentials and MCP servers;
  the rest of the environment is inherited.
- **One workflow session per ticket at a time.** A workflow launch or a saved answer is refused
  while a workflow session of the ticket works, or was launched less than 30 seconds ago and is
  not listed yet. The reason
  names the phase: `session_running` when the phase you asked for is the one running,
  `investigate_running` when you ask for Implement plan while Investigate and plan runs (the
  dialog says `Investigate and plan is still running.`) and `implement_running` when you ask for
  Investigate and plan while Implement plan runs (`Implement plan is running.`). A saved answer is
  always refused as `session_running`. The running reason comes before `not_planned`,
  `plan_missing` and `questions_unanswered`. A launch is also refused when
  `claude agents --json --all` cannot be read, because the decision rests on it. A groom session
  neither blocks nor is blocked by these: only a running groom session refuses another Groom
  ticket launch. Code review is independent of both workflow and grooming, with its own
  duplicate/unknown-state guards (see [Code review](#code-review)).
- **Local state.** Everything the dashboard knows about a ticket's Claude work is in
  `claude/<KEY>/` in the dashboard directory. `/claude/` is gitignored and `claude` is in
  `.dockerignore`. Workflow sessions get that folder (and only it, not the dashboard's source)
  through `--add-dir`. Groom, review and e2e check sessions get no `--add-dir` and are not instructed to
  write workflow state there.

### Icon and dialog

The icon's colour, badge shape and words all carry the state, so no state is colour alone. Its
label and tooltip read `Claude: <state word>`.

| Icon                         | State word                                                                 | Meaning                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Blue, turning ring (spinner) | `working`, `starting`                                                      | The session is listed as working, or it was launched under 30 seconds ago and is not listed yet. The ring stops turning (and stays a ring) when the system asks for reduced motion.                                                        |
| Amber, filled dot            | `blocked, needs you`, `has questions for you`                              | The CLI lists the session as blocked (attach to it), or no session works and a question has no answer you saved.                                                                                                                           |
| Amber, filled dot            | `answers not sent`                                                         | Every planning question has an answer you saved and the plan flag is `true`, but the planning answers (or a change to them) have not been sent to the planning session. **Save answers** sends them; until then Implement plan is blocked. |
| Green, check                 | `plan ready`, `implemented`                                                | The phase's flag is `true` and no question is open; for `plan ready` the plan file `02-plan.md` exists, `done` is `true` and nothing is waiting to be sent.                                                                                |
| Red, cross                   | `plan file missing`, `ended without finishing`, `session no longer listed` | The planning flag is `true` but there is no `02-plan.md`; the session finished without setting its flag; or it has been unlisted for 30 seconds or more without setting its flag.                                                          |
| Red, cross                   | `plan not done`                                                            | The plan flag is `true`, the plan file exists and nothing is waiting to be sent, but the session has not set `done`. Check the session before implementing.                                                                                |
| Muted, no badge              | `not started`, `status unavailable`                                        | Nothing was launched for the ticket; or the CLI listing failed or showed a state the dashboard does not know.                                                                                                                              |

The icon shows the ticket's current phase, the one launched last. Grooming does not count: it
shows only for a ticket with no workflow record, then with the same four looks, from the groom
session's own state, and its label and tooltip read `Claude grooming: <phrase>`. An e2e check
does the same after groom (a ticket with a workflow record or a groom record keeps that icon), and
its label reads `Claude e2e check: <phrase>`. The dialog opens
from it as a native modal. The header holds the ticket key and summary and the state as a pill (a
mark and a word, never colour alone; workflow state only). The body opens with the workflow as a
strip of three steps in order, **Investigate and plan**, **Approve plan**, **Implement plan** (one
above the other below 560px wide). Each step shows its state word (`Ready`, `Running`, `Waiting`,
`Plan ready`, `Approved 7:39 AM`, ...) over a rail that takes the state's colour, and its one
button. Only the step to act on now has the primary (filled) button, so there is never more than
one; once a plan exists and is approved, **Investigate and plan** becomes a quiet outlined re-run
and **Implement plan** is the primary. **Approve** is a done step (a check and the time) rather
than a disabled button once approved. A step that has a session shows a small **Go to session**
chip under its button; a step with none shows no chip and no text about it. Why a step is off is one
line under the strip (`Approve the plan first.`), and a reason that two steps share is said once;
while a session works or the status is unavailable the pill and the steps already say so, so those
lines are only for screen readers (each button points at its reason with `aria-describedby`). When
the state is `plan ready`, the path `~/pathwise/.orchestrator/<key in lower case>/02-plan.md` shows
in the Implement step, because starting it is your approval. **Groom ticket** sits apart under a
hairline, labelled `Independent`, with its note and, once it has a session, its own chip; the
**E2E check** row follows it with its own chip and, once done, a **View e2e result** link. The
outcome of an approval or a save is a short inline message beside what caused it, with a **×** to
dismiss it; it also clears by itself once the ticket stops working, so it never outlives the state
it described.

The header also shows the tokens the ticket's sessions used (`~1.2M tokens`, or `at least 1.2M tokens`
for a lower bound; nothing when zero), from one `GET /api/claude/usage` per dialog open that carries
every phase's session id (see [Claude usage](#claude-usage)); the bot bar never asks. A `failed`
workflow session the CLI still lists gets a **Continue** button (see
[Continue a failed session](#continue-a-failed-session)). On a done implement row **Use in Services**
runs the services of the repo that holds the ticket's worktree from it (see
[Worktree picker](#worktree-picker)).

When a workflow session asked questions, the dialog also shows a reminder that nothing is sent
to the session until every question has an answer, and the questions as a numbered list. Each
shows a muted `Investigate and plan` or `Implement plan` label after the question text, naming the
phase that asked it (a question with no tag reads as `Investigate and plan`), and has a multi-line
answer box with your saved answer filled in. The box grows with its text, from about
two lines to about twelve, then scrolls; that is CSS only (`field-sizing: content`), so a browser
without it shows a fixed-height box that scrolls. Password-manager overlays are turned off on the
boxes. A question that has a saved answer shows a tick (accessible name `Answered`); a draft you
have not saved does not count. The footer is pinned below the scrolling body, so **Save answers**
is on screen without scrolling. At its left is **Prompts**, which opens the prompt editor (see
[Custom prompts](#custom-prompts)); it is there whether or not the ticket has questions, so with
none the footer holds **Prompts** and **Close**. With questions it also holds the count
(`N of M answered`), the line saying what the last save did and **Save answers**, the one filled
button there. The questions are cards under a heading with the count, a slim progress bar and
**Resend answers**, which sends the saved planning answers to the planning session again even when
nothing changed (for a send that never arrived; see
[Saving and sending answers](#saving-and-sending-answers)); it is off while you have unsaved edits
and while a session works. **Approve plan** is open only once the planning session has marked the
plan `done` (see [Approving the plan](#approving-the-plan)); it says why when it is off, and the
step reads `Approved` with the time afterwards.
**Save answers** saves only the answers you changed
and, when every question of a phase has one, sends that phase's answers to the session that asked
them (see [Saving and sending answers](#saving-and-sending-answers)). It is enabled when you
changed an answer, or when every answer is saved but one phase's set was not sent (the retry). The
boxes are disabled while a session works or the status is unavailable. Escape and a click on the
backdrop close the dialog.

The board reads every ticket's state from one `GET /api/claude/tickets` every 15 seconds while the
My Tickets tab is open and the page is visible, and straight after a launch or a save.

Each **Go to session** button copies the command for its own phase's session, one of these
strings, built only from ids that pass a pattern check and never from listing text:

| That phase's session                                                      | Copied                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------- |
| Has a process (live, busy or idle), or is blocked                         | `claude attach <id>` (the 8-character short id) |
| Finished, with no process                                                 | `cd ~/pathwise && claude --resume <sessionId>`  |
| No longer listed, but its transcript is on disk                           | the same resume string (see below)              |
| Never launched, not listed and no transcript found, or its id fails check | No chip is shown                                |

The resume string always starts with `cd ~/pathwise &&`, the launcher's own directory. It also works
for a session that started elsewhere: the CLI finds a conversation by its session id (checked against
CLI 2.1.323 with a session started in another directory); `claude attach` needs no `cd`.

**A session the CLI no longer lists** (`claude rm` removed it, or the CLI pruned it; its conversation
is kept) used to lose its chip, its Copy and its Chat. `launch.json` keeps only the 8-character short id,
so the dashboard recovers the full session id from the transcript on disk: the one regular file
`~/.claude/projects/*/<short id>*.jsonl` (a folder of that name does not count). It is recovered only for
a session a launch record names, only while the CLI listing itself is available (a failed listing never
turns every session into a missing one), and only when the 8-character prefix matches exactly one
session id among all transcripts; two different ids behind one prefix, or no transcript, recover nothing
and the session stays without a chip. A recovered id is a finished session: it has no process, so it is
always resumed, never attached. It fills that phase's `goTo` side and
`sessionIds` entry in `GET /api/claude/tickets` (so the Sessions drawer's Copy and
[Chat](#chat) work for it) and its `lastActive`; the listing still wins whenever it shows the session,
and the card's state is derived as before, from the flag files and the listing, not from the transcript
(with the phase flag set it reads `done`, with none it still reads `failed`, `session_missing`). While a
[Chat](#chat) turn of this dashboard is writing to the session, the card and the drawer row read working and
the Copy command goes away, as for a listed session. When the browser refuses the clipboard
write, the dialog shows the command in a read-only field. The dialog shows one `Copied` (or one
such field) at a time, for the button you used last. Both buttons work at once after Implement plan
has launched, each pointing at its own session even when the two are in different states, so the
planning session stays reachable then.

### State files

`claude/<KEY>/status.json` is shared with the session. The key must match `^[A-Z]{1,10}-\d{1,7}$`
before any path is built, and a folder under `claude/` with another name is ignored (`claude/chat/`
holds the records of standalone chats, see [Chat](#chat)).

`nodemon.json` makes `npm run dev` ignore `claude/`. Without it, every write to these files (a launch,
a saved answer, the session's own updates) would restart the dashboard and cut off the request in
flight. nodemon reads the file only at start-up, so restart `npm run dev` once after pulling it.

```json
{
  "investigate-and-plan": false,
  "implement-plan": false,
  "done": false,
  "approved": false,
  "questions": [
    {
      "id": "q1",
      "question": "Which repo owns the fix?",
      "answer": null,
      "phase": "investigate-and-plan"
    }
  ]
}
```

- **The session** writes `questions` (once, near the end of planning, or by appending one object
  whenever Implement is blocked by something the plan, checklist and spec do not settle) and changes its
  own flag to `true` as its very last action, after everything else is saved. Every new question
  carries `"phase": "investigate-and-plan"` from the planning session or `"phase": "implement-plan"`
  from the implement session; the built-in prompts require it. Existing questions are preserved as
  they are, including one with no `phase`. `done` is also the session's: it means the planning
  phase is complete, every question answered and the plan,
  checklist and spec updated. A planning session that asked no questions sets `done` to `true` in
  the same edit as its flag; one that asked questions leaves it `false` and sets it `true`, as its
  very last action, after the answers have been sent to it (see
  [Saving and sending answers](#saving-and-sending-answers)). The dashboard never sets `done` to
  `true`. `approved` is not the session's: it never sets or changes it.
- **The dashboard** creates the file at an Investigate launch with both flags `false`, `done`
  `false`, `approved` `false` and no questions, replacing any earlier file (a re-run resets it). At an Implement
  launch it rewrites the file from what it can read: the planning flag `true`, the implement flag
  `false`, `done` and `approved` as they were and the first 20 readable questions, each whole, with
  `answer` kept only where you saved that answer and a valid `phase` kept, while a question with no
  tag gains none; anything else a session left in the file is dropped. When it sends planning
  answers it sets `done` to `false` first, and `approved` to `false` too when the answers differ
  from the last send (the plan is being revised and needs approving again); a resend of unchanged
  answers leaves `approved` as it was, and an implement answer changes neither. Approve writes
  `approved: true` with `done: false` just before it resumes the session. Otherwise it writes only
  the `answer` of an existing question, when you save. Both keys are added when the file has none.
- **Reads are defensive.** A flag counts only when it is exactly `true`, and so do `done` and
  `approved`: a file with no `done` or `approved`, or one that is not a boolean, reads as `false`
  (it is not unreadable), so a `status.json` written before the field existed reads `false` and
  needs one Approve before Implement plan opens. A question is read only
  when its `id` matches `^[A-Za-z0-9_-]{1,32}$` and its `question` is a string; a `phase` that is
  not `investigate-and-plan` or `implement-plan` is ignored, and so is `implement-plan` until an
  implement record exists, so the question reads and counts as planning either way. The board
  shows at most 20 questions, each cut to 500 characters, as plain text. A file over 1 MiB, or one
  that is not a JSON object, is unreadable: the card shows no flags and no questions, every action
  that depends on it is refused with `status_unreadable`, and only an Investigate launch overwrites
  it.

`claude/<KEY>/launch.json` is written by the dashboard only, because `status.json` has no place for
which session belongs to which phase and a re-run reuses its session name.

```json
{
  "investigate-and-plan": {
    "name": "ABC-123-investigate-and-plan",
    "launchedAt": 1731100000000,
    "id": "ab12cd34",
    "answered": { "q1": "<sha-256 hex of the id, question and answer you saved>" },
    "sent": { "at": "<ISO time>", "answers": { "q1": "<the same hash, at the time of the send>" } },
    "approved": { "at": "<ISO time>" }
  },
  "implement-plan": {
    "name": "ABC-123-implement-plan",
    "launchedAt": 1731100500000,
    "id": null,
    "answered": { "q2": "<sha-256 hex of the id, question and answer you saved>" },
    "sent": { "at": "<ISO time>", "answers": { "q2": "<the same hash, at the time of the send>" } }
  },
  "groom": { "name": "ABC-123-groom", "launchedAt": 1731100900000, "id": "ef56ab78" },
  "e2e-ticket-check": {
    "name": "ABC-123-e2e-ticket-check",
    "launchedAt": 1731100950000,
    "id": "cd78ef90",
    "browserId": "b-0a1b2c3d",
    "browserStoppedAt": 1731101900000
  },
  "pr-review-transact": {
    "name": "ABC-123-pr-review-transact",
    "launchedAt": 1731101000000,
    "id": "ab34cd56"
  }
}
```

A phase key is absent until that phase is launched. It is written before the CLI runs (`id` is
`null`) and rewritten once afterwards, when the listing shows the session. Each phase finds its own
session from its own record: by its recorded `id`; with none, by the newest listed session with
the recorded name that started at or after `launchedAt`. The two phases have different names, so
one phase's session is never taken for the other's, and a session of the same name started by hand
earlier is never taken for either. Sessions launched before names were per phase keep their old
name and are still tracked by their saved `id` (or, with none saved, by that recorded name). An
Investigate launch drops the `implement-plan` entry, and with the rest of the investigate record
whatever `sent` it held; it keeps the `groom`, `pr-review-transact`, `spec-review` and `e2e-ticket-check` entries. Groom,
review and e2e check launches each replace only their own record, have no flags or answers, and leave `status.json`
alone. Relaunch uses the existing record/session tracking, not a separate review-history store.
`answered` appears once you save an answer, on the record of the lane that asked the question (see
below). `sent` is written on that same record when its answers were really delivered to its
session, and again at each re-send, and holds the time and the hash of every question of that lane
(the same hash as `answered`) at that moment. It is written only after the resume succeeded, so a
failed send leaves it as it was and the next save retries it. `approved` is on the investigate
record only: the time Approve was delivered, dropped with the next send of changed answers.

Folders are mode `0700` and files `0600`, and every dashboard write is a temp file, fsync and
rename, under one lock per ticket. Workflow state writes require no workflow session to be
working; independent groom/review launches update their own launch records even while the
workflow runs. A residual race is a workflow session you resume by hand while an answer is
being saved. A failed launch other than `timed_out` puts the earlier files it changed back (a
first launch leaves no folder). After `timed_out` they stay, because the session may exist.

The plan counts as present when `02-plan.md` is a regular file in
`~/pathwise/.orchestrator/<key in lower case>/`, the workspace the planning prompt pins. It is
checked only when the planning flag is `true` and when Implement plan launches.

### Saving and sending answers

**Save answers** always saves first: each changed answer goes into `status.json`, with its hash on
the launch record of the phase that asked that question. A save with nothing changed
(`answers: []`) saves nothing. Partial answers just save and send nothing, so you can answer one
question and come back. Then, in the same request, the dashboard decides lane by lane whether to
send the saved answers to the session that asked them, planning answers first and implement answers
after. A lane sends only when all of these hold; otherwise the reply says
`send: { status: "skipped", reason }` with the first that fails:

1. Every question of that phase has an answer you saved (`incomplete`; a ticket with no questions
   never sends, and a phase with no questions has nothing to send).
2. For planning answers, the planning flag is `true` (`not_planned`). An implement answer has no
   such gate: the implement session exists only once Implement plan has started.
3. For planning answers, Implement plan has never been launched for the ticket
   (`implement_started`: after that, planning answers only save). An implement question's answer is
   not skipped for this; it is delivered to the implement session.
4. At least one answer of that phase is new or differs from what that phase's session was last sent
   (`unchanged` otherwise), judged by the hash in that record's `sent`. So a save that changes
   nothing never re-sends answers that were already delivered (after a failed send, where `sent`
   was never recorded, the same save sends them), and typing a cleared answer back as it was
   restores `unchanged`.

To send, the dashboard reads a fresh listing and finds that phase's session by its saved `id`, or
with none saved by its recorded name (`listing_unavailable`, `session_not_found`). A session with
a process is stopped first, which the existing stop does only for an idle one: a busy session
fails the send as `session_running`, one that is no longer listed as `session_not_found`, and any
other stop failure as `resume_failed`. After a stop the dashboard polls a fresh listing once a
second (`FINISH_POLL_MS`) until the session has no process at all, for at most 30 polls
(`FINISH_POLL_LIMIT`); a session whose listing still shows a process, or whose state it cannot
tell, is never resumed, because resuming a session that has not gone yet makes the CLI start a
copy of it. If the cap passes the send fails as `live_at_resume` and nothing was written. A
session with no process (already finished) is resumed with no wait. Once it is gone the dashboard
resumes the same session with that phase's notice; for planning answers it also sets `done` to
`false` in `status.json` first, so a session that finishes at once and sets it `true` is never
overwritten (an implement answer writes no status). The Save request waits for all of this, so it
can take several seconds when a live session had to be stopped (up to about 30 when it is slow to
go), and the ticket stays locked meanwhile. Only after the CLI delivered the resume does the
dashboard record that lane's `sent`; a resume that
found no such session counts as `session_not_found`, a session still live at that moment as
`live_at_resume`, and anything else (including the CLI reporting that it started a copy) as
`resume_failed`.

The two lanes are sent one at a time, planning first; normally only one is ever pending, because an
implement record makes planning answers skip. A lane whose send fails keeps its saved answers and
its earlier `sent`, so the next **Save answers** retries only what is still pending; the reply then
reports the first failure.

**Every dashboard send uses this one path** (`deliverToSession` in `backend/claude-launcher.mjs`):
saving answers, **Resend answers**, **Approve plan** and **Re-review**. Each passes only what is
specific to it (the notice, what to write just before the resume and what to put back if the resume
does not deliver), so the stop, the poll and the resume are never repeated per action. The Slack
watcher's wake is the one other caller of the sessions module's `stop` and `resume`: it is a
multi-tick state machine with its own settle gap and is deliberately left separate.

**Failures are logged.** A send that fails to stop, to see the session finish or to resume writes one
line to the server's stderr: `[claude] <stop|wait|resume> failed {...}` with the reason, the CLI's
exit code, the CLI's output cut to 2 KB, the session's short id and the ticket key. The notice is
never logged (it is replaced by `[notice]` if the CLI echoed it), and nothing is logged for a send
that succeeded. The sessions module stays silent for callers that pass no ticket, which is how the
Slack wake keeps its no-CLI-output guarantee.

By default the planning notice (the message in `prompts/answers.md` if you wrote one, see
[Custom prompts](#custom-prompts)) names the ticket, says you answered the open questions, lists
the ids (it reads "answers to questions q1, q2" the first time and "changed answers to questions
q2" after a send, naming the answers that are new or differ from the last send) and points at
`status.json`, where the answers are in `questions[].answer`. The dashboard never puts answer text
in it. On every planning delivery the session reads the latest status and plan, checklist and spec
under `.orchestrator/<key in lower case>/`, applies all current decisions, and reassesses ambiguities and
follow-up questions. It may revise still-unanswered questions in place; answered questions and their
history stay unchanged, with new or revised follow-ups appended under fresh increasing `qN` ids and
`answer: null`, tagged with `"phase": "investigate-and-plan"`. This loop can repeat after each
answer delivery. A **Decision documentation** section
in the plan maps question ids and decisions to their effects and affected doc sections, separating
confirmed decisions from provisional defaults. The session updates all three artifacts in place,
removes superseded assumptions, aligns scenarios and checklist proving commands, and records concrete
project-doc paths and required implementation-time updates in the plan/checklist rather than editing
them during planning. It implements nothing and stops at the approval gate. Only after no unanswered
questions remain and all three artifacts reflect the latest decisions may its last action set `done`
to `true`; otherwise it keeps or resets `done` to `false` and stops for the next answer delivery. Status
edits preserve unrelated state and leave the planning flag intact.

An implement answer gets the `answers-implement` message instead (`prompts/answers-implement.md`
when you override it). It has the same placeholders and no planning-approval stop: it tells the
session the plan is approved already, resumes the implementation and its verification with the
latest decisions, and appends any new blocker as a question tagged `"phase": "implement-plan"`. It
applies only the answers to implement questions; the plan, checklist and spec are the source of truth
for every other decision, because a planning answer saved in the dashboard can be older than a plan
you changed in the CLI. It commits its changes in the worktree on that worktree's own branch and
never pushes or opens a pull request. It sets only `"implement-plan": true` when it finishes, never
`done` or `approved`. The dashboard's `sent` line for a delivered implement
answer is the same `Answers sent. Claude is updating the plan.` as for planning answers.

The reply is `{ ok, key, send, ticket }` with `send` `{ status, reason? }`, `status` being `sent`,
`skipped` or `failed`. A failed send is not an HTTP error: the answers stay saved (they are never
rolled back), that lane's `sent` is not recorded, and the call answers `200` with `send.status`
`failed`. The next **Save answers** retries it, with or without edits: with nothing changed the
dialog posts `answers: []`, which saves nothing and runs the same decision. **Resend answers** posts
`{ answers: [], resend: true }`. It is the planning lane's action: the same decision with the one
gate that skips an unchanged set (`unchanged`) lifted, so every saved planning answer goes again
(the notice reads "answers (sent again) to questions q1, q2"), whether or not the plan is `done`.
An implement answer that was already sent is not forced again; a pending implement change is sent
by its own gate 4 comparison. Every other gate still applies. A resend records the planning `sent`
and resets `done` like any planning send, and leaves `approved` alone because nothing changed.
After a save the dialog shows one of:

| `send`                         | The dialog says                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `sent`                         | `Answers sent. Claude is updating the plan.`                                                              |
| `skipped`, `incomplete`        | `Saved. N questions still need an answer; nothing was sent.` (`1 question still needs an answer` for one) |
| `skipped`, `unchanged`         | `Saved. The answers had not changed, so nothing was sent.`                                                |
| `skipped`, `not_planned`       | `Saved. The plan is not ready yet, so nothing was sent.`                                                  |
| `skipped`, `implement_started` | `Saved. Implement plan has started, so nothing was sent.`                                                 |
| `failed`, with a reason below  | `Answers saved, but they could not be sent: <reason>. Save again to retry.`                               |

The reason in that last line is the dialog's sentence for the code, without its closing full stop:
`Claude status is unavailable` (`listing_unavailable`), `The Claude session could not be found`
(`session_not_found`), `A Claude session is already running for this ticket` (`session_running`),
`The Claude session is still running` (`live_at_resume`), `The Claude session could not be
resumed` (`resume_failed`) or `A custom prompt file could not be used. Fix or remove it in the
dashboard's prompts folder` (`prompt_unreadable`, from a bad `answers.md` or
`answers-implement.md`; see [Custom prompts](#custom-prompts)). A save is still refused
(`CLAUDE_REFUSED`, `session_running`) while a session works.

Limits:

- **Answers go to the session that asked.** Planning questions are delivered to the
  `investigate-and-plan` session and implement questions to the `implement-plan` session. After an
  Implement launch, planning answers only save (the plan is already being implemented) while
  implement answers are delivered. A question with no `phase` reads as planning, so an older
  `status.json` behaves exactly as it did before.
- **The settle gap is a design constant.** The 15 seconds after a stop are the Slack wake's
  `SETTLE_MS` (see [Watch](#watch)), not a measured timing there or here. The watcher's record is
  that a resume 3 seconds after a stop started a copy and one 10 seconds after continued. That no
  copy appears here is not checked against the real CLI (see the manual check). A copy makes the
  send fail as `resume_failed`, and it may exist.
- **A crash can send twice.** A crash between a successful resume and recording `sent` leaves
  `sent` as it was, so the next **Save answers** sends the same notice again. So does a failed
  write of `launch.json` there, which reaches you as an HTTP error rather than `send.failed`.
- **`done` is the session's word.** A planning session that never sets it shows red
  (`plan not done`) and cannot unlock Implement plan, and an old `status.json` with no `done` reads
  `false`.

### Answers and the Implement gate

**Implement plan** launches only when the status file is readable (`status_unreadable`), the
planning flag is `true` (`not_planned`), the plan file exists (`plan_missing`), no planning
question is unanswered (`questions_unanswered`), no planning answer is waiting to be sent
(`answers_not_sent`) and `done` is `true` (`plan_not_done`) and you approved the plan
(`not_approved`), in that order, and neither phase's session works (`session_running` or
`investigate_running`, which come first). A question the implement session asked is not the plan's
to answer, so it never blocks Implement or Approve. A refused launch starts nothing and changes no
file.

For each answer you save, the dashboard records a hash of it (SHA-256 of the question id, the
question text and the answer, untrimmed) on the record of the phase that asked it, and counts an
answer only when its text still matches. A tagged question counts only the hash on its own phase's
record; a question with no valid tag counts a match on any workflow record, the union an older
`status.json` relies on. An `implement-plan` tag counts only once an implement record exists:
until then the question reads and counts as planning, so a tag written into `status.json` by
itself cannot take a question out of the planning gates. A save or a clear also drops that
question's hash from the other workflow record, so a hash recorded before the question was tagged
cannot answer it again after you clear or replace it. A best-guess default that a session copied
into `status.json` itself, or an answer or a question edited after you saved it, therefore reads as
unanswered: it keeps the planning gates closed, or its own phase's answer unsent, until you save
it. This is accident-proofing, not a security boundary: a launched session can write the
whole `claude/` folder, `launch.json` included, so a hostile session could forge the hashes. Your
real protection is that Approve plan and Implement plan are manual clicks, made after you read the
plan (the dialog shows its path) and the answers you saved yourself.

### Approving the plan

**Approve plan** tells the planning session that you approved its finished plan, and unlocks
Implement plan. It is open only when the plan is ready and done: the status file is readable, the
planning flag is `true`, the plan file exists, no planning question is unanswered, the planning
answers were all sent and `done` is `true`. Otherwise `POST /api/claude/approve` is refused (`409`
`CLAUDE_REFUSED`, the reason in `errors[0]`) with the first reason that applies: `status_unreadable`,
`not_planned`, `plan_missing`, `questions_unanswered`, `answers_not_sent` or `plan_not_done`, then
`implement_started` once Implement plan has been launched and `already_approved` after an approval;
`session_running` and `investigate_running` come first while a session works. A question the
implement session asked does not block an approval. Nothing is written on a refusal.

An approval is sent as the answers are: the idle session is stopped, the dashboard waits for it to
go (the poll above), sets `done` to `false` and `approved` to `true` in `status.json` (adding the key to an older
file; nothing else in the file changes) and resumes the session with the approval message
(`prompts/approve.md`, see [Custom prompts](#custom-prompts)). The session re-reads the plan,
checklist and spec against your answers, fixes only a genuine inconsistency inside
`.orchestrator/<slug>/`, implements nothing, and sets `done` back to `true` as its last action. The
flag goes in just before the resume rather than after it so that `status.json` has one writer
while the session works. If the resume does not deliver, `status.json` is put back exactly as it
was and nothing is recorded; the reply is `200` with `send.status` `failed` and a reason, as for
answers, and **Approve plan** can be pressed again. After a delivery `launch.json` holds
`approved: { at }` on the investigate record and the entry carries `flags.approved` and
`approvedAt`. The dialog shows `Approval sent. Claude is checking the plan.` or `Approval not
sent: <reason>. Press Approve plan to retry.`

Implement plan stays its own step and its launch is the only thing that starts an implement
session. Changed planning answers withdraw the approval (see
[Saving and sending answers](#saving-and-sending-answers)): the plan is being revised, so it needs
approving again after the session marks it `done`. An implement answer never changes `done` or
`approved`.

### Continue a failed session

**Continue** asks the same finished session of a ticket to carry on when its workflow state is
`failed` and the CLI still lists the session (`reason` `ended_without_flag`, `plan_not_done` or
`plan_missing`). `POST /api/claude/continue` takes `{ key }` and sends the built-in `continue` message
(`{KEY}`, `{SLUG}` and `{STATUS_FILE}` only; `prompts/continue.md` replaces it) through the shared send
path (`deliverToSession`), so the one-writer mark applies and an idle session is stopped, waited for and
resumed under its own id. It writes neither `status.json` nor `launch.json`, before or after: a failed
send leaves every file as it was, and the effect shows as `working` on the next listing.

- **Block.** `blocks.continue` exists only on a `failed` entry: `null`, or `session_not_found` when the
  session is missing or only recovered from its transcript (use [Chat](#chat) for those). The dialog
  shows **Continue** beside the workflow strip with the reason in words when it is disabled.
- **Refusals** (`409` `CLAUDE_REFUSED`): `session_running` (working, or held by a chat turn),
  `not_failed` (none, waiting or done) and `session_not_found`; `502` `CLAUDE_FAILED`
  `listing_unavailable`. A `prompts/continue.md` that cannot be used is `send: { status: 'failed',
reason: 'prompt_unreadable' }`, and a failed resume is `resume_failed`; both can be retried.
- **Reply.** `{ ok, key, send, ticket }`, as for answers. A session that is working but quiet
  (stalled) and an orphan are out of scope.

### Groom ticket

**Groom ticket** runs your `groom-ticket` skill (from `~/pathwise/.claude/skills/groom-ticket/`)
on a ticket, in a background session named `<KEY>-groom`. It stands apart from the workflow: any
ticket in any Jira status can be groomed, nothing but the key is needed, and there are no flags,
no `status.json` and no gates either way. A running groom session does not stop Investigate,
Implement or a saved answer, and those do not stop it; only a running groom session refuses
another Groom launch (`session_running`, and `listing_unavailable` when the CLI listing fails).

- **Read-only until you say so.** The built-in prompt tells the session the skill's read-only rule
  holds for the whole session: no Jira write and no Slack post until you tell it to in a later
  message. That is the prompt's instruction, not something the dashboard enforces; the session
  still runs under your permission mode. It asks nothing in chat: it puts each open decision in
  the output with lettered options and a recommended default.
- **Output.** The session writes `~/pathwise/.orchestrator/<key in lower case>/groom.md`
  (overwriting an earlier one) and ends with a chat summary of at most ten lines: the readiness
  verdict, the open decisions with their options and that path. While the groom session is
  `done` the dialog shows the path under the row. The dashboard reads only the first 512 bytes of
  `groom.md`, for its first line `Readiness: READY`, `Readiness: NEEDS_INFO` or `Readiness: BLOCKED` (a
  closed enum, case-sensitive, optional leading `#`, `>` or `*`; anything else is no verdict; never
  logged), and shows it as a **Readiness** chip beside **View groom notes** and in the bot's bubble. It
  cannot answer the decisions: use the row's **Go to session** and reply in the session. A
  `NEEDS_INFO` or `BLOCKED` readiness before any plan exists shows one note under the workflow strip
  (`claude-groom-warning`); Investigate and plan stays enabled, because the verdict is advisory and
  gates nothing. The built-in groom prompt asks for that line; a custom `prompts/groom.md` is not
  upgraded and shows no chip until it asks for the line (see [Custom prompts](#custom-prompts)). The
  ticket entry's `groom` gains an optional `verdict`, only while it is `done`.
- **State.** The ticket entry gains `groom: { state, reason }`, `blocks.groom` and `goTo.groom`.
  `state` is `none` (never groomed), `working` (`running` or `starting`), `waiting` (`blocked`),
  `done` (`finished`), `failed` (`session_missing`) or `unknown` (`listing_unavailable` or
  `unrecognised_state`). `blocks.groom` is `listing_unavailable`, `session_running` or `null`.
  Nothing else in the entry (`state`, `reason`, `phase`, `flags`, `questions`, `unsent`, the other
  `blocks` and `goTo` sides) changes because of grooming, so a ticket that was only groomed is
  `state` `none` there. The card's icon follows the groom session only for such a ticket.
- **Launch.** `POST /api/claude/launch` with `phase` `groom`. It lists sessions fresh, reads the
  `groom` prompt before writing anything (an unusable `prompts/groom.md` is `CLAUDE_REFUSED` with
  `prompt_unreadable`), records the session in `launch.json` and starts it with no `--add-dir`.
  A failed start rolls the record back, except after `timed_out`.

### E2E check

**E2E check** runs your `e2e-ticket-check` skill (from `~/pathwise/.claude/skills/e2e-ticket-check/`)
against a browser you have already signed in to. It is independent of the workflow, like grooming:
any ticket, no flags, no `status.json`, no gates either way. Only a running e2e session of the same
ticket refuses another (`session_running`).

- **Dialog.** The row's button opens a two-step dialog over the Claude dialog. Step 1 takes the
  address (the DevTools tab's default is the placeholder) and **Launch browser** starts a new
  DevTools browser labelled `E2E <KEY>`; a server rejection such as an invalid URL shows
  inline. The browser is headless by default, so no window opens or takes your desktop focus; tick
  **Show browser window** (unchecked by default) to open a normal visible window instead. Step 2
  names its port. Sign in through **Open live view** (the DevTools viewer, view-only until Take
  control), or in the window if you showed it, using a throw-away test client, never a real
  one. The DevTools tab's own launch form has the same **Show browser window** checkbox. The mode is
  kept on the browser's record, so stopping and starting it again keeps it; a record saved before
  the option existed starts headless. **I've logged in, start check** is the only thing that starts the session. The live view is a
  modal over the dialog, so Start cannot be reached while it is open. The dialog opens no event
  stream of its own.
- **Session.** `POST /api/claude/launch` with `phase` `e2e-ticket-check` and the `browserId`,
  from `~/pathwise` with no tool limits and no `--add-dir`. The server fills the built-in template or
  `prompts/e2e.md` from the validated ticket key and the browser's port (looked up in the DevTools
  registry, never taken from the client); see [Custom prompts](#custom-prompts). The built-in text
  names the skill, says the session is unattended, and tells it to attach
  with `agent-browser --session e2e-<key in lower case> connect <port>` and to pass that `--session`
  on every agent-browser command, so concurrent checks stay apart. By default the session writes
  `~/pathwise/.orchestrator/<key in lower case>/e2e.md`, whose first line is `Verdict: PASS`,
  `FAIL`, `PARTIAL` or `BLOCKED: <reason>`. The dashboard reads only that first line (the first 512
  bytes, the closed enum `PASS`, `FAIL`, `PARTIAL` or `BLOCKED`; the text after `BLOCKED:` is never
  read) and shows it as a **Verdict** chip beside **View e2e result** and in the bot's bubble
  (`TAP-1 · Done ✓ · Fail`) and live-region message (`TAP-1 e2e: done, verdict fail`); it is advisory
  and gates nothing. The row also shows the session's state, a **Go to e2e check session** chip, and
  once `done` a **View e2e result** link that opens `e2e.md` in the artifact viewer. The entry's `e2e`
  gains an optional `verdict`, only while it is `done`.
- **Browser.** The dashboard stops the browser, never removes it (the signed-in profile stays on
  disk and the browser stays in the DevTools tab as stopped), in two cases. Closing the dialog at
  step 2 before Start (Close, Esc, the backdrop; also closing while Launch browser is still
  opening) stops it, and a failed stop is ignored. And when the next `GET /api/claude/tickets` finds
  the session `done` or `failed`, it stops the browser once, under the ticket's lock, and writes
  `browserStoppedAt` (or `browserStopFailed` with the error code, which is logged and not retried)
  into the record; a browser that is already stopped or gone is only marked, and a failed stop never
  fails the listing. While Start is in flight, closing does nothing and the dialog going away stops nothing: the launch
  outcome decides. After a `timed_out` start no close path stops it, because a session may exist:
  only the finish-time stop does. A relaunch
  before a poll saw the earlier session finish, or closing the dashboard tab at step 2, leaves a
  browser running; stop it in the DevTools tab.
- **State.** The ticket entry gains `e2e: { state, reason }`, always present and read like `groom`,
  `blocks.e2e` and `goTo.e2e`, the last two only for a ticket with an e2e record. `blocks.e2e` is
  `listing_unavailable`, `session_running` or `null`. A bot appears for the session on the
  [bot bar](#bot-bar).
- **Launch refusals.** A malformed `browserId` (not `b-` and eight hex digits) is `400`
  `INVALID_TICKET`. An id the registry does not list is `409` `CLAUDE_REFUSED` `browser_not_found`,
  and one that is stopped (or on a port outside 9300-9399) `browser_not_running`; the dialog then
  returns to step 1 with `That browser is no longer running. Launch a new one.` Nothing is
  written on a refusal.

### Code review

**Start code review** in the Pull Requests dialog launches a background session named
`<KEY>-pr-review-transact` in the same trusted `~/pathwise` workspace. It sends
`{ key, phase: 'pr-review-transact' }` through `POST /api/claude/launch`. Review has no planning
prerequisite, workflow flags or answers, and its launch transaction never reads, writes or
restores `status.json`. The refreshed combined ticket entry may still read workflow state.
Workflow and groom sessions neither block nor are blocked by review.

- **Re-review.** **Re-review** posts `{ key }` to `POST /api/claude/rereview`. It needs a review
  record whose session the listing still shows, neither working nor waiting on you; otherwise it is
  refused (`CLAUDE_REFUSED`) with `no_review_session`, `session_not_found`, `session_running` or the
  listing's own reason. It is independent of the workflow: no status file is read or written. The
  idle session is stopped, polled until gone and resumed through the shared send path above with
  the message in `prompts/rereview.md` (default: review the linked PRs again since the last review,
  same guardrails as the first review, no code changes, publish only through the skills with their
  confirmations). `rereview: { at }` is added to the review record in `launch.json` only once the
  message was delivered, and the ticket entry reports it as `reviewResentAt` and the block as
  `blocks.rereview`. A failed send is `200` with `send.status` `failed` and a reason
  (`live_at_resume`, `resume_failed`, `session_not_found`, `prompt_unreadable`).
- **New review sessions.** The server fills the built-in delegation template or
  `prompts/review.md` from the validated key (see [Custom prompts](#custom-prompts)). This applies
  to **Start code review** and **Start new review**; **Re-review** continues the existing session
  with the separate `prompts/rereview.md` message. The unchanged built-in launch text asks Claude
  to use `pr-review-transact` for the ticket and its linked PRs.
  It directs inspection of existing reviews/unresolved threads against the latest PR head,
  verification of prior findings, and reporting remaining/new issues without duplicating
  already resolved findings. It forbids implementing fixes or code changes and follows, rather
  than overrides, the skill's approval/comment/Jira-transition rules. Ticket text, PR content,
  comments and linked pages are explicitly untrusted data in that built-in text. Client
  prompt/title/summary/URL fields do not enter the prompt. A custom file replaces the whole
  template; none of those directions are automatically prepended.
- **Publishing is skill-governed, not read-only.** The built-in prompt directs discovery and use of
  applicable skills in `~/pathwise` to publish actionable findings/review on the relevant PRs
  and reply concisely in the ticket's **existing Slack thread**, summarizing outcomes and
  blockers. All skill permission/confirmation requirements still apply under your own Claude
  permission mode. A missing thread or required posting confirmation must be reported as a
  blocker, never replaced with an invented/new thread or a claim of success without a confirmed
  post/review. The dashboard adds no Slack posting or thread-finding integration; the invoked
  skills govern external writes, including review decisions and Jira transitions.
- **Independent lifecycle.** `launch.json['pr-review-transact']` tracks the session; ticket
  entries expose `review: { state, reason }` and `blocks.review`. Review is `none` before launch,
  `working` (`running` or `starting`), `waiting` (`blocked`), `done` (`finished`), `failed`
  (`session_missing`) or `unknown` (`listing_unavailable` or `unrecognised_state`). Start refuses
  a working/starting review (`session_running`), an unavailable listing or an unrecognised
  review-session state. A blocked or finished session, or one missing after the 30-second start
  window, can be relaunched using the same button. The backend checks a fresh listing under the
  existing per-ticket lock, even if the browser's cached state is stale. Ordinary launch
  failure restores the previous launch bytes; timeout retains the record because a session may
  exist. Investigate resets preserve both review and groom records.
- **Completion is not approval.** The dialog reports launch/session lifecycle and errors, not
  review quality or verified publishing outcomes. Review never changes workflow flags,
  questions, My Tickets icon state or the other Go to session sides; it only adds `goTo.review`
  (for a ticket with a review record, the same attach or resume command as any other phase), which
  the Sessions drawer's copy icon reads. The review dialog has no Go to session chip. Tests cover prompt intent with a
  fake CLI and intercepted browser APIs; actual Claude reviews, PR publication and Slack
  replies have not been exercised by those tests.

Deploy backend and built UI together through the normal build/restart. There are no new
dependencies, environment settings or storage migrations. Preserve launch/status files and
browser localStorage on rollback; older code ignores review records and treats prefix as transient.

### Custom prompts

All six launch prompts (investigate, implement, groom, review, spec-review and e2e) and the
messages sent with your answers, your approval, a Continue and a re-review are editable templates:
eleven in all, in the registry order investigate, implement, answers, answers-implement, approve,
continue, rereview, groom, review, spec-review, e2e. By default they use the original built-in text. You can change
each one in the app (see **Edit in the app** below) or by hand. See also the standalone
[prompt guide](prompts/README.md). Both edit the same file, a file of that name in the `prompts/`
folder of the dashboard (the repo root, next to `claude/`), so a hand edit and an app edit always
agree:

| File                           | Replaces                                             | Placeholders                                                     |
| ------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `prompts/investigate.md`       | the Investigate and plan prompt                      | `{KEY}`, `{SLUG}`, `{STATUS_FILE}`                               |
| `prompts/implement.md`         | the Implement plan prompt                            | `{KEY}`, `{SLUG}`, `{STATUS_FILE}`                               |
| `prompts/answers.md`           | the message sent with your saved planning answers    | `{KEY}`, `{SLUG}`, `{STATUS_FILE}`, `{QUESTION_IDS}`, `{CHANGE}` |
| `prompts/answers-implement.md` | the message sent with your saved implement answers   | `{KEY}`, `{SLUG}`, `{STATUS_FILE}`, `{QUESTION_IDS}`, `{CHANGE}` |
| `prompts/approve.md`           | the message sent when you approve a plan             | `{KEY}`, `{SLUG}`, `{STATUS_FILE}`                               |
| `prompts/continue.md`          | the message sent by **Continue** to a failed session | `{KEY}`, `{SLUG}`, `{STATUS_FILE}`                               |
| `prompts/rereview.md`          | the message sent for a re-review                     | `{KEY}`, `{SLUG}`                                                |
| `prompts/groom.md`             | the Groom ticket prompt                              | `{KEY}`, `{SLUG}`                                                |
| `prompts/review.md`            | the prompt for a new code review session             | `{KEY}`, `{SLUG}`                                                |
| `prompts/spec-review.md`       | the spec review prompt                               | `{KEY}`, `{SLUG}`, `{PR}`                                        |
| `prompts/e2e.md`               | the E2E ticket check prompt                          | `{KEY}`, `{SLUG}`, `{PORT}`                                      |

`{KEY}` is the validated ticket key, `{SLUG}` the key in lower case (the `.orchestrator/` folder name),
`{STATUS_FILE}` the absolute path of the ticket's `status.json`, `{QUESTION_IDS}` the ids of the new
or changed answers joined with `, `, and `{CHANGE}` is `answers` for a normal send with no prior
successful answer send for that phase's session, `changed answers` for a later normal send with
new or changed answers, and `answers (sent again)` for an explicit resend (`resend: true`), which
only the planning lane has, whether or not the answers changed. `{PR}` is the validated spec PR
number, and `{PORT}` is the running browser's port (9300-9399), read from the DevTools registry,
not client text. Any placeholder not listed for that template stays in the text as written, so in
`groom.md`, which has no status file, `{STATUS_FILE}` is left as literal text. The file is read as
UTF-8, trimmed, and otherwise used as written.

The two answers messages take the same placeholders. `answers-implement` is the continuation
message for a question the implement session asked: it continues the approved implementation and
its verification instead of stopping at the planning approval gate. The question-writing templates
(investigate, implement, answers and answers-implement) depend on the `phase` key: every **new**
question carries `"phase": "investigate-and-plan"` or `"phase": "implement-plan"` and exactly the
keys id, question, answer and phase, while every existing question is preserved as it is,
including one with no `phase`, and an answered question's id, text, answer and phase never change.
A custom file you wrote earlier is not upgraded automatically: if you customized
`investigate.md`, `implement.md` or `answers.md`, add that tag instruction and the preservation
wording by hand, or press **Reset to default** to take the built-in text. `answers-implement.md`
and `continue.md` are new, optional override names.

A change to a built-in prompt never reaches an override you saved or wrote by hand, and your
`prompts/*.md` files are local, gitignored state the dashboard does not touch. After the built-in
`implement` and `answers-implement` text changed (see below), edit your `prompts/implement.md` and
`prompts/answers-implement.md` by hand or press **Reset to default** in the Prompts editor; the same
goes for a custom `groom.md`, which shows no **Readiness** chip until it asks for that line (see
[Groom ticket](#groom-ticket)).

The built-in `implement` prompt names `02-plan.md`, `02-checklist.md` and `02-spec.md` as the single
source of truth and tells the session not to take decisions from the `answer` fields in the status
file; the built-in `answers-implement` message applies only the answers to implement questions
(`"phase": "implement-plan"`). Both built-in texts also tell the session to commit its changes in the
worktree on that worktree's own branch and to never push or open a pull request. The built-in
`continue` message is the one **Continue** sends (see [Continue a failed session](#continue-a-failed-session)).

- **Edit in the app.** **Prompts**, at the left of the Claude dialog's footer, swaps the dialog's
  body for an editor in the same dialog. The footer then holds **Back**, at the left where
  **Prompts** was, and **Close**. The editor loads the eleven prompts once when it opens, not on
  the dialog's 15 second refresh; if the load fails it shows the error and a **Retry** button.
  Each prompt has:
  - a badge: `default` (no file, so the built-in text), `custom` (a usable file) or
    `unusable file` (a file that exists but cannot be used, see below; the box then holds the
    built-in text and a note says that saving replaces the file and Reset removes it, and to
    check that a folder is not in its place if either fails);
  - a text box with the prompt's text (the file's trimmed text for `custom`), the placeholders it
    takes, and an `Unsaved changes` tag while the box differs from what is saved;
  - **Save**, enabled only when the box differs from what is saved and is not blank. It writes the
    trimmed text and one newline to `prompts/<name>.md`, creating the folder if it is missing;
  - **Reset to default**, enabled unless the badge says `default`. It deletes the file;
  - a result line: `Saved.`, `Reset to default.` or why the request failed (see **A save can
    fail** below).

  A saved prompt applies from the next launch or send. A save replaces the whole file with the
  box's text, so a file you changed by hand while the editor was open is overwritten (the last
  write wins). **Back**, **Close** and Escape discard text you have not saved; the answers you
  were typing in the dialog survive **Back**.

- **A missing `{STATUS_FILE}` is a warning, never a block.** While the text in the box of a prompt
  that takes `{STATUS_FILE}` (investigate, implement, answers, answers-implement or approve) lacks
  the literal `{STATUS_FILE}`, the editor says so under the box as you type: "This prompt does not
  contain {STATUS_FILE}, so the session cannot find status.json: questions, the flags and done
  will not work." **Save** stays enabled and the server never refuses a prompt for it.
- **Absent means built-in.** A missing file is never an error. `npm run claude:prompts` creates
  `prompts/` and writes the eleven built-in templates into it, placeholders intact, for you to edit
  by hand. It prints `wrote <path>` or `kept <path>` for each and never overwrites a file that
  exists. It needs no Settings setup.
- **Applied at once.** The files are read on every launch and every send, never cached, so an edit
  (in the app or by hand) applies to the next one with no restart. A save is atomic (a temporary
  file renamed into place), so a launch never reads half a prompt. nodemon does not watch `.md`
  files, so `npm run dev` does not restart either.
- **A save can fail.** The save goes through the same write as the dashboard's token files: the
  saved file is mode `600`, and it fails if the `prompts/` folder or any folder above it is a
  symbolic link, or if a folder is in the file's place. **Reset to default** refuses a symlinked
  `prompts/` (or a symlinked folder above it) the same way, removing nothing, and cannot remove a
  folder in the file's place. Reading is looser: a symlinked `prompts/` folder is read as usual
  (it is used and shown, but can be neither saved to nor reset), and a prompt file that is itself
  a symbolic link is followed on read; **Save** replaces the link with a regular file. A refused
  save or reset is `502` `CLAUDE_FAILED` with `prompt_not_changed`, and the editor says "The
  prompt file could not be changed. Check that prompts/ is a real folder you can write to, with
  nothing in the place of the file." A text the server refuses (`INVALID_PROMPT`, see below) shows
  the reply's `error` text, `INVALID PROMPT`.
- **Size.** The 20,000 limit counts JavaScript string length, so an emoji counts as two. The save
  request is a JSON body of at most 64 KiB, and a prompt of 20,000 ASCII or CJK characters, or
  10,000 emoji, fits (up to about 60 KB). A prompt that is valid but too big to save is possible only with
  control characters, which JSON writes as six bytes each; **Save** then fails with `413`
  `BODY_TOO_LARGE`, and the file can still be used and read.
- **Who can change a prompt.** The Host, Origin and `Sec-Fetch-Site` checks stop a web page in
  your browser, but anything that can reach the dashboard port without browser headers can change
  the prompts, and the settings: a local user, or a container or VM that shares the host's
  loopback (`curl` works by design). It is the same trust boundary as the settings route, which
  such a caller can use too; there is no owner-only channel. Prompts steer every later launch, so
  run the dashboard only where everything that can reach `127.0.0.1` is trusted.
- **A bad file is an error, not a fallback.** A file that exists but cannot be used (it cannot be
  read, it is not a regular file such as a folder, it is empty, it holds a NUL byte, or it is over
  20,000 characters once trimmed) is `prompt_unreadable`, and the built-in text is not used in
  its place. A launch is then refused with `CLAUDE_REFUSED` and `prompt_unreadable`, after the
  other launch refusals and before anything is written or started, so no state file changes. A
  send fails with `send` `failed` and `prompt_unreadable` before the session is listed, stopped
  or touched: the answers stay saved, `done` is untouched and the next **Save answers** retries.
  The dialog says
  `A custom prompt file could not be used. Fix or remove it in the dashboard's prompts folder.`
- **Why not under `claude/`.** Sessions are given `claude/` (`--add-dir`), and a session that has
  read untrusted ticket text must not be handed a way to rewrite the prompt of the next launch.
  The folder is outside it; its contents are gitignored except for `prompts/README.md`, and the
  whole folder is in `.dockerignore`. That is a grant, not a
  sandbox: a session runs as your user and under your permission mode.

A custom file replaces its entire template after substitution; the dashboard does not prepend
unattended reminders, security instructions or the built-in text. For unattended custom prompts,
include an explicit reminder not to ask questions or wait for replies, and define how to report
blockers without bypassing required permissions. Preserve any task-specific safety and output
instructions you need. Spec-review CLI restrictions still apply independently of custom text;
E2E browser validation and automatic stopping are unchanged. `review.md` starts a new review
session; `rereview.md` is only the continuation message (not `re-review.md`). The guide
`prompts/README.md` is documentation, not a registered prompt.

Each built-in investigate and implement prompt carries the protocol the dashboard relies on: the
questions go into `status.json`, each new one tagged with its asking phase, the phase flag (and
`done`) is set as the very last action, and
the session never asks in chat. The built-in investigate prompt also tells the session to give
every question lettered options (a, b, c) inline in the question text, with its recommended
default, and to keep each question under 450 characters. That wording lives in the built-in text
only: a `prompts/investigate.md` you made earlier keeps its own words until you add the
instruction (and the `phase` tag) by hand or press **Reset to default**. The dashboard does not
check that a custom file keeps any of this. A prompt that drops it
leaves sessions red (`ended without finishing`, `plan not done`) and **Implement plan** locked; the
editor's `{STATUS_FILE}` warning is the only guard. To go back to the built-in text, press **Reset
to default** or delete the file.

### Routes and errors

| Route                               | Purpose                                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/claude/tickets`           | `{ listing, updatedAt, tickets, lastActive }`; `listing` is `ok` or `unavailable`; `tickets` keyed by ticket key (entry below); `lastActive` is `{ key: { phase: ISO } }`, sparse |
| `POST /api/claude/launch`           | body `{ key, phase }` (`spec-review` also takes `pr`, `e2e-ticket-check` also takes `browserId`, else `400 INVALID_TICKET`); answers `{ ok: true, key, phase, name, id, ticket }` |
| `POST /api/claude/answers`          | body `{ key, answers }`; answers `{ ok: true, key, send, ticket }`                                                                                                                |
| `POST /api/claude/continue`         | body `{ key }`; answers `{ ok: true, key, send, ticket }` (see [Continue a failed session](#continue-a-failed-session))                                                           |
| `GET /api/claude/usage`             | `?sessions=<uuid>,...`; token tallies per session (see [Claude usage](#claude-usage))                                                                                             |
| `GET /api/claude/prompts`           | `{ ok: true, prompts }`; eleven entries in the order investigate, implement, answers, answers-implement, approve, continue, rereview, groom, review, spec-review, e2e             |
| `PUT /api/claude/prompts/<name>`    | body `{ text }`; answers `{ ok: true, prompt }`, the entry with `source` `custom` and the trimmed text                                                                            |
| `DELETE /api/claude/prompts/<name>` | answers `{ ok: true, prompt }`, the entry with `source` `default`; a file that is not there is fine                                                                               |

`tickets` holds an entry for every folder under `claude/` and none for a ticket never launched (the
board shows it as not started). With no ticket folder the route answers without running the CLI;
otherwise concurrent callers share one `claude agents --json --all`. An entry is
`{ phase, state, reason, flags, questions[], unanswered, unsent, groom, review, specReview, e2e, blocks, goTo }`
(`groom` and `blocks.groom` are described under [Groom ticket](#groom-ticket);
`e2e`, `blocks.e2e` and `goTo.e2e` under [E2E check](#e2e-check);
`review`, `blocks.review` and `goTo.review` under [Code review](#code-review), `specReview` and `blocks.specReview` under [Spec review lane](#spec-review-lane)):

- `phase` is `investigate-and-plan`, `implement-plan` or `null` (no workflow launched). `flags` holds
  the two phase flags and `done`, as read (`done` is `false` when missing).
- `state` is `none`, `working`, `waiting`, `done`, `failed` or `unknown`, and `reason` refines it:
  `running`, `starting`, `blocked`, `questions`, `answers_not_sent` (`waiting`), `plan_ready`,
  `implemented`, `plan_missing`, `plan_not_done` (`failed`), `ended_without_flag`,
  `session_missing`, `listing_unavailable`, `unrecognised_state` or `null` (for `none`). The
  icon's state word comes from `reason`.
  A session the CLI lists as `working`, `blocked`, `done` or `stopped` (ended with `claude stop`,
  listed with a null pid) is recognised; `stopped` is a finished, resumable session exactly like
  `done`. Any other listed state is `unrecognised_state`.
- `specReview` is `{ state, reason }`, read like `review` from the spec-review record: `none` with a
  null reason until a spec review is launched. `blocks.specReview` is present only for a ticket with
  that record; it is `session_running` while the spec review works, `listing_unavailable` when the CLI
  listing failed, and `null` otherwise.
- Each question is `{ id, question, answer, phase }`, with `answer` `null` unless it is one you
  saved and `phase` the lane that asked it (`investigate-and-plan` or `implement-plan`, and
  `investigate-and-plan` for a question with no valid tag); `unanswered` counts the open ones
  across both phases.
- `blocks` is `{ investigate, implement, answer, groom, review }` (plus `specReview` and `e2e` for a ticket with that record, and `continue` on a `failed` entry, see [Continue a failed session](#continue-a-failed-session)), each a reason string or `null` (why that
  action is refused now). It is what the dialog words beside a disabled item. While Investigate
  and plan runs it is `session_running`, `investigate_running` and `session_running`; while
  Implement plan runs it is `implement_running`, `session_running` and `session_running`. The
  running reason comes before `not_planned`, `plan_missing`, `questions_unanswered`,
  `answers_not_sent` and `plan_not_done`, in that order. So `blocks.implement` is
  `answers_not_sent` when no planning question is open but the planning answers are waiting to be
  sent, and `plan_not_done` when they are sent (or nothing is waiting) and `done` is not `true`.
- `unsent` is `true` when either phase has a complete set of saved answers that differ from what
  its own session was last sent, under the conditions that would let its **Save answers** send,
  and no session works. The same conditions make `answers_not_sent` the Implement block for the
  planning lane.
- `goTo` is always `{ investigate, implement, groom }` (plus `review` for a ticket with a review record and `e2e` for one with an e2e record), each side `{ kind, command }` (`kind` is `attach`
  or `resume`) or `null`: `null` for a phase with no launch record, a session that cannot be
  joined (not listed and no transcript to recover it from), or an unavailable listing, so a ticket never launched has every side `null`. It used to
  be one `{ kind, command }` or `null` for the current phase only, so anything reading `goTo`
  must now read a side.

`launch` takes `phase` `investigate-and-plan`, `implement-plan`, `groom`, `pr-review-transact`, `spec-review` or `e2e-ticket-check`;
extra properties such as `summary` or `prompt` in the body are ignored. Its answer has `name`
(the action's session name), `id` (the session's
8-character id, or `null` while the listing does not show the session yet) and `ticket` (the
refreshed entry). `answers` takes
`{ "<question id>": "<text>" }` with at most 20 entries, each text at most 2000 characters and an
empty text clearing that answer, and an optional `resend` forces the planning set again; only the
`answer` of an existing question changes, and nothing is written when any entry is invalid. There
is no phase in the body: the server routes each id to the phase that asked it and refuses the batch
if that phase has no launch record. The empty array `[]` is also accepted: it saves nothing and
runs the send decision (the retry). The reply's `send` is described under
[Saving and sending answers](#saving-and-sending-answers).

A prompt entry is `{ name, label, source, text, placeholders }`. `name` is one of `investigate`,
`implement`, `answers`, `answers-implement`, `approve`, `continue`, `rereview`, `groom`,
`review`, `spec-review` or `e2e`; a path with any other name matches no prompt route. `label` is its
human-readable editor heading. `source` is
`default` (no file), `custom` (a usable file) or `unusable` (a file that exists but cannot be
used). `text` is the file's trimmed text for `custom` and the built-in text for the other two, so
a fix can be saved from it, and `placeholders` lists the `{WORD}`s the prompt takes. `PUT` needs a
string `text` that is not empty once trimmed, at most 20,000 characters once trimmed and free of
NUL bytes; anything else, a missing `text` included, is `400` `INVALID_PROMPT` and nothing is
written. A text without
`{STATUS_FILE}` is never refused. See [Custom prompts](#custom-prompts) for what a saved file does.

The launcher and prompt routes bypass the `SETUP_REQUIRED` gate like the
Slack routes, because they need neither GitHub nor Jira. They run behind the same Host, Origin, `Sec-Fetch-Site` and JSON
`Content-Type` checks (`403` and `415`), a local POST that sends none of those headers is accepted
so `curl` works, bodies are JSON objects of at most 64 KiB, and responses carry
`Cache-Control: no-store`. Failures answer `{ code, error, errors[] }`, with `errors[0]` the reason:

| Status | Code             | When                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `INVALID_TICKET` | `key` does not match `^[A-Z]{1,10}-\d{1,7}$`, `phase` is none of the supported launch actions, `pr` is bad for `spec-review`, or `browserId` is not `b-` and eight hex digits for `e2e-ticket-check`                                                                                                                                                  |
| `400`  | `INVALID_ANSWER` | `answers` is neither `[]` nor a plain object of at most 20 entries, an id is malformed or names no existing question, a text is not a string of at most 2000 characters, or the ticket has no status file or no launch record for the question's phase                                                                                                |
| `400`  | `INVALID_PROMPT` | `PUT /api/claude/prompts/<name>` with a `text` that is missing, not a string, empty once trimmed, over 20,000 characters once trimmed, or holding a NUL byte                                                                                                                                                                                          |
| `409`  | `CLAUDE_REFUSED` | `session_running` (the action asked for runs), `not_failed` (Continue), `investigate_running`, `implement_running`, `not_planned`, `plan_missing`, `questions_unanswered`, `answers_not_sent`, `plan_not_done`, `prompt_unreadable`, `status_unreadable`, `unrecognised_state` (review), or `browser_not_found` and `browser_not_running` (e2e check) |
| `502`  | `CLAUDE_FAILED`  | `listing_unavailable`, `untrusted_workspace` (exit code 1 and `Workspace not trusted`), `timed_out` (no answer within 30 seconds; the session may exist; for an e2e check the browser is left for the finish-time stop), `spawn_failed`, or `prompt_not_changed` (a prompt save or reset the disk refused)                                            |

`INVALID_JSON` and `BODY_TOO_LARGE` come from the shared body reader. CLI output, the prompt a
launch sends and the name are never logged or returned beyond the validated `id` and the computed
`name`; only the prompt routes return prompt text, the saved or built-in template.

### Manual check before first use

The tests use a fake CLI and never start a real session, so run this once before relying on the
launcher (use a throwaway ticket):

1. With `~/pathwise` trusted, click **Investigate and plan**. Confirm the session starts, the icon
   shows the turning ring, questions (if any) appear in the dialog, and `claude/<KEY>/status.json`
   shows `"investigate-and-plan": true` when the session finishes. With no questions `done` is
   `true` too and the icon is green; with questions the icon is amber (`has questions for you`)
   and `done` is `false`.
2. Copy the investigate row's **Go to session** for a live, a blocked and a finished session and
   run each in a terminal. After Implement plan has launched, do the same with the implement
   row's **Go to session**, and confirm the investigate row still joins its own session. Confirm
   `claude attach <id>` works for a blocked session and that
   `cd ~/pathwise && claude --resume <sessionId>` continues a finished one.
3. While the first session works, open the dialog again. Confirm **Investigate and plan** is
   disabled with `A Claude session is already running for this ticket.` The server refuses a second
   launch too: a hand-made `POST /api/claude/launch` answers `409` with `session_running`.
4. In a launched session, confirm the toolkit MCP tools (Jira and GitHub) work. Sessions no longer
   receive the dashboard's token variables, so this is what proves they have their own.
5. On a ticket whose planning session asked at least two questions, answer some but not all and
   press **Save answers**. Confirm the dialog says `Saved. N questions still need an answer;
nothing was sent.` and that the session received nothing (attach to it).
6. Answer the rest and press **Save answers**. If the session was live and idle the request takes
   about 15 seconds (the settle gap after the stop). Confirm the same session (the same id under
   the investigate row's **Go to session**) receives a message naming the question ids, the icon shows the turning
   ring while it works, `status.json` shows `"done": true` when it finishes, and `claude agents`
   lists no second session (a copy). Until then **Implement plan** stays disabled.
7. Change one answer and press **Save answers**. Confirm the session receives a message naming
   only that question id as changed, `done` goes `false` and then `true` again, and the icon
   returns to green.
8. Clear one answer and save (nothing is sent: the set is incomplete), then type the same text
   back and save. Confirm the dialog says the answers had not changed and the session receives
   nothing. A hand-made `POST /api/claude/answers` with `answers: []` answers `send` with
   `skipped` and `unchanged` in the same way.
9. Run `npm run claude:prompts`, add a line you will recognise at the top of
   `prompts/investigate.md` (keep the rest), and launch **Investigate and plan** on a throwaway
   ticket. Confirm the session's first message contains your line. Delete the file, launch again
   once the first session has finished, and confirm the built-in text is back.
10. Open a ticket's Claude dialog and press **Prompts**. Confirm the eleven prompts load with the
    badge `default` (or `custom` if you kept a file), and that deleting `{STATUS_FILE}` from a box
    shows the warning while **Save** stays enabled. Add a line you will recognise at the top of
    **Investigate and plan prompt**, press **Save**, and confirm `Saved.`, the badge `custom` and
    `prompts/investigate.md` holding your text. Launch **Investigate and plan** on a throwaway
    ticket and confirm the session's first message contains your line. Then reopen **Prompts**,
    press **Reset to default**, and confirm `Reset to default.`, the badge `default`, the file
    gone, and that the next launch (once the first session has finished) is the built-in text.
11. On a throwaway ticket, press **Groom ticket**, with and without a workflow already started.
    Confirm a session `<KEY>-groom` starts (`claude agents` lists it) and that Investigate and
    plan can launch while it works. Confirm no `claude/<KEY>/status.json` appears or changes for
    a groom-only ticket, that `~/pathwise/.orchestrator/<key in lower case>/groom.md` is written,
    that the session ends with a chat summary and that nothing was written to Jira or Slack. The
    row's **Go to session** must join or resume it. Launch Investigate and plan afterwards and
    confirm the groom row's **Go to session** still works, and that a question the session writes
    has lettered options inline.

12. **Not yet done:** one real E2E check, against a running DevTools browser, on a throwaway ticket.
    Confirm the session starts and attaches (`agent-browser --session <name> connect <port>`) without stalling on a
    permission prompt, `e2e.md` is written under `~/pathwise/.orchestrator/<key in lower case>/`, the
    next ticket poll after it ends stops the browser with its profile left on disk, and the skill's
    `scratch` location works in a background session.

Also taken as assumptions until then: `--bg` prints a standalone 8-character id, a session name of
39 characters or fewer is listed unabbreviated, a tool call denied in a background session ends it
without the flag (shown as `ended without finishing`) or blocks it (shown as `blocked, needs you`),
and a resume 15 seconds after a stop (the settle gap) continues the same session instead of
starting a copy. If one is wrong, the fix is a single constant or rule: the id pattern
(`STARTED_ID` in `backend/claude-sessions.mjs`), the command for a blocked session (`goToFor` in
`backend/claude-ticket-state.mjs`), or, for the last one, `SETTLE_MS` in
`backend/slack-watcher.mjs`, which the Slack wake shares. To roll the feature back, revert the change;
`claude/` holds only local files you can delete, and running sessions are unaffected.

## Chat

The **Chat** tab (after Pull Requests) holds a conversation with a real Claude Code session inside the
dashboard, so you do not need a terminal for `claude attach` or `claude --resume`. It works for a
**standalone chat**, a session with no Jira ticket that the dashboard creates for you, and for any
session the Claude CLI lists, which includes every ticket session the [launcher](#claude-launcher)
started. Like the launcher it is host only: it needs the `claude` command on `PATH`, and the Docker image
has none, so there a chat cannot start.

- **Start a chat.** Open the Chat tab (or press **New chat**, `#/chat`), type a message and press
  **Enter** (**Shift+Enter** is a new line). The dashboard starts a new session in `~/pathwise`, the
  launcher's own directory, and the address becomes `#/chat?session=<uuid>`, which you can bookmark or
  reload. The chat is titled with the first line of your first message (60 characters at most). The list
  on the left holds your standalone chats, newest first, each with its state and age.
- **Continue a ticket's session.** In the [Sessions drawer](#bot-bar) a ticket session whose id is known
  has a live **Chat** icon link (tooltip "Chat") beside its copy button (without an id the slot is a dimmed placeholder); it opens that same session here (and closes the drawer). The
  session is continued, never copied: if it is idle, the dashboard stops it, waits for it to be gone and
  resumes it under the same id, so the conversation lands in the same transcript. The Open button still
  opens the Claude dialog. A session the CLI no longer lists can be continued too, when a launch record
  of this dashboard names it and its transcript is still on disk (see [Icon and dialog](#icon-and-dialog)): it has no process,
  so it is idle, nothing is stopped, and it runs from `~/pathwise`. Any other id the CLI does not list
  is still refused (`session_not_found`).
- **Start a chat from the drawer.** The Sessions drawer's header has a **New chat** link (also when no
  sessions are listed): it opens the Chat tab on a fresh conversation, the same as the tab's own **New
  chat**, and closes the drawer.
- **What you see.** The history comes from the CLI's own transcript on disk (the dashboard only reads
  it), the newest branch of the conversation. Your messages are plain text, Claude's replies are
  rendered Markdown with a **Copy code** button on each code block, and a **Copy** button on each message.
  A tool call is one collapsed chip (name, running, done or failed) that opens to its input and result;
  long inputs and results are cut at 8192 characters. The reply being written streams in as it arrives.
  Thinking and subagent traffic are not shown. The head also shows the open session's token tally from
  `GET /api/claude/usage` (`~1.2M tokens`, `at least 1.2M tokens` while incomplete), asked for when a
  chat opens and again each time a turn ends, never on a timer, and "Session cost so far" (see
  [Chat limits](#chat-limits)).
- **Working, idle and working elsewhere.** The state pill reads **Working** while a turn that this
  dashboard runs is in flight: the message box is read-only (the reason shows beneath it) and **Stop** is
  shown. It reads **Idle**, **Stopped** or **Failed**
  once the turn ended; after a stopped or failed turn **Retry** sends your last message again, a note says
  how it ended (a stopped reply you had already seen stays on screen) and any tool the session was not
  allowed to use is named. **Working elsewhere** means the session is running outside the chat (a ticket
  session working in the background): its history shows, the message box is read-only with the reason, there
  is no Stop, and **Refresh** reads it again. The chat never sends into a running session and never starts
  a second copy.
- **Stop.** **Stop** interrupts the turn (Ctrl-C to the CLI). If it has not ended 5 seconds later it is
  terminated, and 5 seconds after that killed. The session stays usable: your next message continues it.
- **One turn at a time.** Each message is one `claude -p` process, started for that turn and ended with
  it, with your message on its standard input (never in the command line, so `ps` does not show it). A chat
  holds one turn at a time (`chat_busy`), and 4 turns can run at once (`too_many_turns`). The process runs
  without the dashboard's `GH_TOKEN`, `GITHUB_TOKEN`, `JIRA_API_TOKEN` and `JIRA_TOKEN`, as launched
  sessions do. Nothing you or Claude said is logged; a failed turn is one `[claude]` line with the step,
  the reason, the exit code and the first 8 characters of the session id.
- **Bots and drawer.** A standalone chat that is working, or was written to in the last 24 hours, has a
  bot on the [bot bar](#bot-bar) and a row in the Sessions drawer, with or without an active sprint; it
  opens the chat instead of a dialog. A chat id is never sent to Jira.
- **Where things live.** A standalone chat's record is `claude/chat/<uuid>.json` in the dashboard
  directory (the launcher's gitignored, nodemon-ignored `claude/` state; the chat's title, directory,
  times and last outcome, no message text). The conversation itself is the CLI's transcript, so
  `claude --resume <uuid>` in `~/pathwise` (the Sessions drawer's copy icon, **Copy resume**, gives the command) shows the same
  chat in a terminal. Delete the record to forget a chat in the dashboard; the transcript is not touched. Rolling
  the feature back is a revert; the record files are yours to delete.

### Chat routes and events

| Route                                      | Purpose                                                                                                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/claude/tickets`                  | also answers `chats` (the standalone chats, at most 100, newest turn first) and `sessionIds` (`{ KEY: { phase: uuid } }`, sparse, `{}` when the listing is unavailable; includes sessions recovered from a transcript) |
| `POST /api/claude/chat/send`               | body `{ message, session? }`; without `session` a new standalone chat is created. Answers `{ ok: true, session, chat }` once the process has started (`chat` is null for a listed session)                             |
| `POST /api/claude/chat/stop`               | body `{ session }`; answers `{ ok: true }` once the signal is sent                                                                                                                                                     |
| `GET /api/claude/chat/stream?session=<id>` | `text/event-stream` for one chat: `hello` first, then `item`, `delta` and `state`                                                                                                                                      |

`session` is always a full session UUID; the dashboard works out the directory itself and never accepts a
path, directory, model or flag. A `message` is a string of 1 to 32000 characters after trimming. The routes
keep the launcher's rules (loopback Host, same-origin writes, JSON content type, bodies of at most 64 KiB,
`Cache-Control: no-store`), work while setup is incomplete, and fail with the usual
`{ code, error, errors[] }`:

| Status | Code               | When                                                                                                                                                                                                                                                                                |
| ------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `INVALID_SESSION`  | `session` is present and not a UUID (send, stop, stream); checked before any file is read or process started                                                                                                                                                                        |
| `400`  | `INVALID_MESSAGE`  | `message` is not a string, is empty once trimmed or is over 32000 characters                                                                                                                                                                                                        |
| `409`  | `CLAUDE_REFUSED`   | `chat_busy` (a turn is already running in this chat), `session_running` (a listed session works outside the chat), `session_not_found` (not a chat, not listed, and not a launched session recovered from its transcript), `too_many_turns` (4 running), `no_turn` (stop with none) |
| `502`  | `CLAUDE_FAILED`    | `listing_unavailable` (a listed session needs the CLI listing), `live_at_resume` (a stopped session still had a process after the wait), `spawn_failed` (the CLI could not be started, or a listed session has no directory)                                                        |
| `429`  | `TOO_MANY_STREAMS` | 8 chat streams are already open                                                                                                                                                                                                                                                     |
| `403`  | `INVALID_ORIGIN`   | the stream was requested cross-site (`Sec-Fetch-Site` `cross-site` or `same-site`); the other routes answer `OPERATION_FAILED` for that, this one says why                                                                                                                          |

A refused stream is a JSON error, because the stream's headers go out with its first event. Every event's
data is JSON:

- `hello` (always first): `{ session, kind, title, state, live, items, truncated, turn }`. `kind` is `chat`
  or `session`; `state` is `working` or `idle`; `live` is true only when the working turn is one this
  dashboard runs (it streams and can be stopped), so `state: "working", live: false` is a session working
  elsewhere; `items` is the history followed by the turn in flight; `turn` is the last turn of this
  dashboard process on the session, or null. A new `hello` **replaces** what the browser had, which is how a
  reconnect or Refresh recovers.
- `item`: `{ item }`, an upsert by `item.id`. Items are `{ id, kind: "user", text }`,
  `{ id, kind: "assistant", text }` (Markdown) and `{ id, kind: "tool", name, input, result, truncated }`; a
  tool item is sent when the call starts (`result` null) and again with `{ text, isError }` when it ends.
- `delta`: `{ text }`, more of the reply being written; the finished assistant `item` replaces it. It is
  dropped for a client that is not keeping up; `item` and `state` never are.
- `state`: `{ state: "working" }` when a turn starts, and `{ state: "idle", turn }` when it ends, where
  `turn` is `{ outcome, reason, error, denials, costUsd }`: `outcome` is `completed`, `stopped` or `failed`;
  `reason` is `spawn_failed`, `api_error` or `exited` for a failure; `error` is the CLI's own error text (2000
  characters at most); `denials` names the tools the session was not allowed to use.

History is bounded: only the last 4 MiB of the transcript is read and at most 300 items are sent (the
screen then says only the latest messages are shown), and a running turn keeps at most 500 items. While a
turn runs, history is read only up to where the transcript stood when the turn started, so no message
appears twice.

### Claude usage

`GET /api/claude/usage?sessions=<uuid>,<uuid>` (at most 8 ids, each a session UUID, otherwise 400
`INVALID_SESSION`; a cross-site or same-site `Sec-Fetch-Site` is 403) answers
`{ sessions: { <uuid>: { tokens: { input, output, cacheRead, cacheCreation }, models: { <model id>: <message count> }, messages, complete } } }`,
summed over the session's newest transcript and its subagents' transcripts. A session with no
transcript answers an empty, complete tally. The body holds numbers and model ids only, never a path, a
working directory or any text. Tokens only: there is no price table and no dollar figure.

The reader (`backend/claude-usage.mjs`) keeps a byte offset per transcript file and parses only newly
appended complete lines. Lines of one API message id repeat the same usage and are contiguous, so one
pending `{ id, usage }` per file is committed when a different id arrives. A file that shrinks or
changes inode is read again from byte 0. One request reads at most 8 MiB in all: a bigger backlog
answers `complete: false` and the next request continues, and a single line longer than the whole
budget is skipped. An unreadable file also makes the answer `complete: false`. One request looks at
256 files at most (the rest are left out and the answer is `complete: false`), and at most 256 files
are cached (least recently used out), holding numbers and model ids only. Requests are served one at a
time. The route is read on demand only: it is never part of `GET /api/claude/tickets`, which stays
stat-only (names, directory listings and modification times), and it takes no one-writer mark. The
Chat head, the Claude dialog header and the Sessions drawer's rows ask for it (see
[Bot bar](#bot-bar)); the bot bar itself never does.

### Chat limits

- **A dev restart can leave a turn running.** `npm run dev` restarts the server through nodemon's `SIGUSR2`
  signal, which does not run the server's `SIGTERM` clean-up, so a `claude` process in the middle of a
  turn can outlive a dev restart (development only: `npm start` handles `SIGTERM`, which ends every turn's
  process and every chat stream). It is deliberately not switched to `SIGTERM`, because that would also stop
  every service the dashboard manages on each dev restart.
- **Tool permissions are the plain CLI's.** A chat turn passes no permission flag, so the session runs
  under your own Claude settings, like the launcher. There is no approve or deny prompt in the app: a tool
  that needs approval is denied and shown in the turn's note (`denials`).
- **Cost is cumulative.** The turn's `costUsd` is the CLI's total for the session, so on a resumed
  session it is cumulative, not per turn. The Chat head shows it as "Session cost so far $0.42"
  ("under $0.01" below a cent), only while the chat is idle and only for a chat this process has run a
  turn on (a `hello` with `turn: null` shows nothing). It is a number only: nothing said is logged. The
  claim that the CLI's total is cumulative has not been re-checked against the real CLI.
- **One writer is a dashboard rule.** The one-turn-at-a-time rule covers the chat, the launcher's
  resumes and the Slack watcher, all in this dashboard. A terminal that resumes the same session at the
  same moment is not seen and would interleave with it.
- **Cross-site stream requests** get `INVALID_ORIGIN`, on purpose, while the other routes answer
  `OPERATION_FAILED` for the same thing.
- **Orphan recovery needs the transcript.** A session the CLI dropped from its listing keeps its Copy and
  Chat only while its transcript is still on disk and its 8-character short id is unique among all
  transcripts (two different ids behind one prefix recover nothing). The scan's answer, found or not, is
  kept for 5 minutes, so a transcript that appears or goes is noticed within that time. An orphan has no
  process, so it is never attached and the CLI never reports it Working; it reads working only while a Chat
  turn of this dashboard is writing to it, and its Copy command is the resume string,
  `cd ~/pathwise && claude --resume <id>`, which also works for a session started elsewhere (checked on the
  real CLI). Its card state comes from the flag files and the listing, not from the transcript, so a row such
  as `Code review · failed · session no longer listed` can sit beside a live Chat and Copy: the state words
  say the CLI no longer lists the session, and the conversation can still be continued.
- **Not covered by a check on the real CLI.** Resuming a finished `--bg` ticket session and the
  `session_running` refusal of a working one were run with scratch sessions on the real CLI. Sessions
  started with the launcher's extra flags (`--add-dir`, `--tools`, `--strict-mcp-config`) were not run end
  to end. The Chat icon on the Sessions drawer's rows (live and placeholder, an orphan row included) was run
  in a real browser; any other way into Chat from a ticket was not. Chatting with a recovered orphan through the
  dashboard was also run end to end on the real CLI and in a real browser (a removed scratch session: its
  drawer row's Chat icon opens the history from the transcript, and a reply keeps the context), besides the
  tests.
- **Out of scope:** approving tool calls in the app, choosing a directory, model or MCP servers, renaming,
  deleting or archiving a chat, live output of a session running in the background (Refresh reads its
  transcript), syntax highlighting and attachments.

## Bot bar

A strip of small animated mascots runs along the bottom of every screen once setup is complete (the
Settings-only setup mode has none): one **bot per Claude session** (investigate, implement,
review, groom or e2e check, or a standalone [Chat](#chat)), so you can see at a glance which ones are working and which need you. It is an overlay
(`position: fixed`, transparent, and it ignores the pointer except on the bots), so it takes no room,
never scrolls the page and leaves every screen's height and viewport fill unchanged. It is hidden
while there is no session to show.

- **Which sessions.** Every Claude session of each ticket (investigate, implement, review, groom and the
  [E2E check](#e2e-check)), **of tickets in an active Jira sprint only**. The sessions live in one
  table, `SESSIONS` in [`ui/bot-bar.js`](ui/bot-bar.js) (`BOT_PHASES` is derived from it), which is also the
  order a ticket's bots are drawn in; a new kind of session is one new row. A bot is keyed `<KEY>:<phase>` (an e2e bot `<KEY>:e2e`). A session whose
  state is `none` (never started) or `unknown` (the CLI listing could not be read) has no bot, and neither
  does a session of a ticket outside the active sprint, which also keeps old finished sessions off the bar.
  **Standalone chats are the exception** (see the [Chat](#chat) tab): they have no ticket, so there is no
  sprint to check and no Jira call. A chat has a bot while it works or when it was written to in the last
  24 hours, keyed `<uuid>:chat` and labelled `chat-` and the first 8 characters of its id; it follows the
  states, zones, 10-minute fade and dismiss rules below, has no callout (callouts come from tickets), and
  clicking it opens `#/chat?session=<uuid>` instead of a dialog.
- **The active sprint.** "Active" is the rule My Tickets and Home use (a sprint Jira reports as
  `active`, read from the ticket's most relevant sprint; several boards can each have one, and a
  ticket in any of them counts). The bar asks which of its tickets are in one with
  `GET /api/active-sprint-tickets?keys=A-1,B-2` (setup-gated, at most 200 keys), answered by
  `fetchActiveSprintKeys` in `backend/jira.mjs`: one Jira search per 50 keys with no answer yet, each
  ticket's answer kept for 5 minutes (so a repeat call costs Jira nothing), and the response is
  `{ available, keys, statuses }`, where `keys` is the subset in an active sprint and `statuses` maps
  each ticket to its current Jira status name. The pure filter is
  `inActiveSprint` in `ui/bot-bar.js`. The browser asks when the bar sees a ticket it has not placed,
  every 5 minutes (`SPRINT_POLL_MS`) while the page is visible, and when the page becomes visible after
  that long. **A ticket whose sprint is not known has no bot**: nothing shows until the first answer is
  in, and when Jira is not configured or unreachable (`available: false`, or a failed request) the bar
  keeps the last good set of keys and adds none, so it never shows a bot it cannot place.
- **States.** `working` patrols back and forth along the bar, turning at each end. `waiting` is
  shown as **idle** (it needs you) and wanders slowly, resting at each end. `done` **strolls**: the
  slowest walk, a relaxed amble that rests at each end and once halfway out (three times a working
  patrol's length of cycle, `STROLL_CYCLE_FACTOR` in `ui/bot-bar.js`, beside the idle wander's
  `IDLE_CYCLE_FACTOR`), and `failed` stands slumped where it was put.
- **Zones per state.** Every state keeps to its own zone of the bar (the `ZONES` table in
  `ui/bot-bar.js`, mirrored by `ui-react/styles/bot-bar.css`): `done` on the **left** 20%, `working` and
  idle (`waiting`) in the **centre** 60%, `failed` on the **right** 20%. The left and right zones are
  their share of the bar's width but at least 200px (`ZONES.<zone>.minPx`), and the centre is what they
  leave; `DONE_ZONE_SHARE` and `DONE_ZONE_MIN_PX` name the done zone's. The bar's own ends keep their
  edge margin (88px, 40px when narrow), so a bot never touches the screen's edge. Nothing marks a
  zone and no bot may enter another's. A bot whose state changes **jumps** to its new zone on the next
  poll (no slide: transitions stay under 200ms) and walks or stands from a lane and phase taken from
  the new zone's range, so it never ends up outside it; a bot that turns done still hops and gets its
  callout there. Working and idle bots share the centre without piling onto one spot: each has its own
  lane from its session key, and their motions stay distinct (a patrol with steady feet, a slow wander
  with pauses). A crowded zone is never widened and bots are never shrunk: they overlap, spaced by
  their hash, and the bot you point at or focus comes to the front so its dismiss button stays
  reachable in every zone. **Under 600px wide the zones collapse** (a CSS media query at
  `ZONES_MIN_WIDTH_PX`, with `useNarrow` mirroring it for the resting spots): every state has the whole
  width between a 40px margin on each side. With reduced motion every bot stands still at a spread-out
  place inside its own zone.
- **Mascot.** Each session is one of the mascots for life: the pick is a hash of the session key
  (`<TICKET>:<phase>`), with nothing stored, so it never changes between renders or reloads, and
  where it walks or stands comes from the same hash. The mascot list lives only in
  [`ui-react/components/mascots/index.js`](ui-react/components/mascots/index.js); a session is
  matched to a mascot by highest-random-weight hashing, so adding a mascot moves only about one
  session in N to it and leaves the rest as they were. See
  [Adding a mascot](ui-react/components/mascots/README.md).
- **Poster.** Every bot carries a small sign on a pole above its head with its ticket key
  (`TAP-1451`; the key is fitted to the board, so `AB-1` to `TRIPS-12345` all fit). Like the mascot, the
  poster is one of a registry for life, picked by its own hash of the session key (`pickPoster` in
  `ui/bot-bar.js`, independent of the mascot), with nothing stored, so a session keeps its poster and
  adding one moves only about one session in N. The poster list lives only in
  [`ui-react/components/posters/index.js`](ui-react/components/posters/index.js); see
  [Adding a poster](ui-react/components/posters/README.md). The sign rides with its bot beside the
  mirrored face, so its key is never reversed when the bot turns; it sways gently while the bot walks
  (working, idle and done bots) and is still for a failed one, and never sways with reduced motion. It is
  decorative: hidden from assistive technology, no native tooltip, and it takes no pointer, so the bot
  stays the only target. It stands under the callout and the hover popup (both clear it), over a bot's
  head, and a pointed-at or focused bot comes to the front with its poster.
- **Click a bot** to open the Claude dialog of that session: the code review dialog for a review bot,
  the workflow dialog for an implement or e2e bot (the E2E check row is in it). Its accessible name reads `<KEY> <phase>: <state>`
  (`TAP-1234 review: idle`). Hovering or focusing it shows the dashboard's own popup (the same
  `DashboardTooltip` the boards use, so it works from the keyboard as well) with the same words and the
  reason, for example `TAP-1451 review: done · finished`; no bot carries a native `title` tooltip. The
  dialogs show the key without the ticket summary, which the bar does not load. A walking bot stops
  while you hover or focus it.
- **Callouts.** When a bot's state changes between two polls while the page is open (working to done,
  working to idle, any state to failed, or a session starting to work), a small speech bubble in the
  tooltip's look appears above it, for example `TAP-1451 · Done ✓` (a finished e2e check or groom adds its
  verdict, `TAP-1451 · Done ✓ · Fail`, see [E2E check](#e2e-check)). The words are the small map
  `CALLOUT_TEXT` in `ui/bot-bar.js`. There is none on first load, for a bot that appears already in a
  state, or when a dismissed or timed-out bot merely comes back. Working and done bubbles go after about
  6 seconds (`CALLOUT_AUTO_HIDE_MS`); idle and failed ones stay until you hover, focus or click the bot
  or its state changes again. There is one bubble per bot and at most three at once (a newer one pushes
  the oldest out). The bubble rides with its bot without being mirrored when it turns, takes no room or
  pointer, and only fades under reduced motion. It is hidden from assistive technology; instead one
  polite status region in the bar says `TAP-1451 review: done` once per change.
- **Done bots leave.** A `done` bot fades out 10 minutes after the bar first saw it done
  (`DONE_TTL_MS`), except a **done implement bot whose ticket is still open in Jira**: that one stays
  until the ticket reaches a done-kind status (Deployed, Complete, Closed, ... — the `done` kind in
  `ui/jira-status.js`), so the bar shows the work that finished but has not shipped. Only the implement
  session holds; a done review, groom or e2e bot still leaves after the 10 minutes. A status Jira could
  not give, an unrecognised one, or a failed `/api/active-sprint-tickets` read falls back to the 10
  minutes, so an outage never pins bots to the bar. A `done` or `failed` bot also has a small **x**
  beside it that dismisses it. A dismissed bot comes back if its session changes state. This is
  remembered in memory only, so a reload starts the 10 minutes again and brings dismissed bots back.
- **The session list.** A **Sessions** tab on the right edge of every screen (with a count, amber when
  something needs you) opens a drawer that lists the same sessions as the bot lane: every session of a
  ticket in an active sprint, plus the standalone chats of the last 24 hours (a chat row is named by its
  title, has the chat phase icon before it and shows `working` after it, and opens the chat), grouped **Needs you**, **Working**, **Failed** and **Done**, each group with
  the most recently active session first (one with no time last). Unlike the
  bar it does not forget a done bot after 10 minutes or a dismissed one, so a finished session stays
  reachable. A row opens the same Claude dialog its bot opens (the review dialog for a review session),
  and every ticket row has two icon slots, always: a copy icon button (tooltip **Copy attach** when live, **Copy resume** when finished)
  that copies the same command as the dialog's Go to session, and a **Chat** icon link that opens the session in the [Chat](#chat) tab.
  A slot with nothing to offer (no session id yet, no command to copy) stays as a dimmed placeholder whose tooltip says why; a chat row has the Chat icon too. A row's phase (chat, code review, implement plan, investigate and plan, groom, E2E check) is a small icon with the phase name as its tooltip, in a column of its own at the start of the row (after the state mark), and the state and reason follow the key or title. Rows are one compact line each, and one **Search sessions** box filters them by
  everything a row shows (ticket, phase, state, reason, the copy button's word, the group heading and
  **quiet**, never the time); every term must match, Escape clears the search before it closes the drawer.
  Each row ends with **9m ago** (read out as "active 9m ago"), when its session was last written to: the newest modification time
  of its transcripts (for a working session its subagents' transcripts too, so a long subagent does not hide
  it), from `lastActive` in the same response. A working session with no write for **5 minutes**
  (`QUIET_WORKING_MS` in `ui/bot-bar.js`) is **quiet**: amber and bold, and its popup says so. That is a
  hint, not a state, since a long tool call or a reply writes nothing either. The age is read again every
  30 seconds while the drawer is open (`ACTIVITY_CLOCK_MS`). The time is the row's description, not part of
  its name, and there is no live region. The drawer is a non-modal overlay (the app
  stays usable beside it; Escape or Close shuts it and focus returns to the tab), uses the bar's data
  (its one request of its own is the token read below) and renders no rows while shut. Each row also
  shows the tokens its session used (`~1.2M tokens`, `at least 1.2M tokens` for a lower bound; nothing
  for an empty tally or a row with no session id), read with `GET /api/claude/usage` in batches of 8
  for the rows' distinct session ids (24 at most) when the drawer opens or the rows' sessions change,
  never while it is shut and never on a timer.
- **Needs-you notifications (opt-in, off by default).** The **Notify me** button in the Sessions
  drawer header turns on a desktop notification, `<KEY> · Needs you` or `<KEY> · Failed`, for a
  ticket session that changes to waiting or failed while the tab is hidden (at most three per poll;
  never chat text, a title or a reason, and chat bots and `done` never notify), and a `(N) ` prefix on
  the tab title while hidden (N is the visible ticket bots waiting or failed). The choice is kept in
  `localStorage` (`dev-dashboard.needs-you.notify`), the browser permission is asked for only from
  that click, and a blocked permission is shown in the drawer. While it is on and permitted the bar
  also keeps polling while the tab is hidden (every 15 s; the browser may throttle background tabs, so
  a notification can arrive late).
- **The bar polls.** It reads `GET /api/claude/tickets` itself, on every screen, every 15 seconds
  while the page is visible (and while hidden only when Notify me is on and permitted), through its own `useClaudeTickets` (a failed read keeps the last
  answer; there is no countdown). Its requests carry `?surface=bot-bar`, which the server ignores,
  so a request log or a test counting a board's own reads can tell them apart. It reads no
  other route than `/api/active-sprint-tickets` above (in particular never `/api/team-velocity`). It also
  reads again at once when the Chat tab reports a send or a turn changing state, so a chat's bot follows it
  without waiting for the poll.

## Keyboard shortcuts and ticket links

- **Command palette.** Ctrl+K (Cmd+K on a Mac) opens it over every screen once setup is done. It lists
  **Go to** (every tab, with its chord), **Sessions** (the same sprint-filtered rows as the Sessions
  drawer, chats included) and **Actions** (New chat, Refresh for My Tickets, Slack, Pull Requests and
  DevTools when open, and `Open KEY in My Tickets` when a whole ticket key is typed). Type to filter
  (every word must match), arrows move, Enter chooses, Esc closes. It works from the Chat composer, and
  focus returns there on close.
- **Chords.** `g` then a letter jumps to a tab (1.5 s window, any other key cancels): `h` Home, `t` My
  Tickets, `s` Slack, `p` Pull Requests, `c` Chat, `r` Releases, `v` Services, `d` DevTools, `m` Mascots
  and `,` Settings. `?` lists the shortcuts. Plain keys are ignored while typing in a field, while any
  dialog is open, inside an open menu or listbox popup (the Services Actions menu, say) and on a
  screencast stage in Take control. Ctrl+K is always kept from the browser's own shortcut (address-bar
  search), also while the palette or help is open and on key repeat. The palette and help close on a
  backdrop click only when the press and the click both landed on the backdrop. Tab tooltips show the
  chord, for example "My Tickets (g then t)".
- **Ticket links.** `#/my-tickets?ticket=TAP-123` opens that ticket's Claude dialog once My Tickets has
  loaded, then the address becomes `#/my-tickets`. Only assigned tickets are found (Include Done is not
  switched on for you); otherwise the note `my-tickets-ticket-missing` explains. When the list on
  screen is older than one poll and does not hold the ticket, a neutral `my-tickets-ticket-checking`
  note ("Looking for KEY ...") shows until the activation load answers, so "missing" is only said from a
  current answer. A value that is not a key is ignored and dropped.
- **Screen changes.** Changing screen sets `document.title` to `<Screen> · EZAT Dev Dashboard`,
  announces the screen in a polite sr-only region, and moves focus to the screen's heading only when
  focus was lost (on the page, removed or in a hidden screen).
- No request, poll or Home velocity fetch is added by any of this; Refresh in the palette runs the
  board's own guarded load.

## Mascots page

The **Mascots** tab (after DevTools) shows every registered mascot, for looking at and picking one.
It is static: no session data, no request and no polling, and it reads the one registry
(`MASCOTS` in [`ui-react/components/mascots/index.js`](ui-react/components/mascots/index.js)), so a
mascot you register appears on it with no page change.

- **A card per mascot**: its name and id, then the four states (working, **idle**, done, failed) at
  the bar's 56 px and at 160 px, each captioned in words. The cards are a grid of one, two or three
  columns (at 760 px and 1700 px), and the pane scrolls inside the screen.
- **Toolbar**: **Facing** (Left or Right) turns every picture; **Moving** switches on the walk cycle
  of the mascots that have one; **Replay** remounts the pictures so the one-time done hop and failed
  shake can be watched again.
- **Hover or focus a mascot** to see its reaction (a squeak, a snip, a flame perking up, a blush and hop,
  a startled duck into the shell); with reduced motion it shows a still cue instead.
- **Roaming preview**: a fake bottom bar where each mascot has a working bot and one in another
  state. It uses the real bar's lane classes and keyframes, so it walks, pauses and stands as the bar
  does, and stands still with reduced motion. Each of its bots carries a poster, drawn by the bar's own
  `BotPoster`.
- **Posters**: below the mascots, a card per registered poster (`POSTERS` in
  [`ui-react/components/posters/index.js`](ui-react/components/posters/index.js)) with its name and id,
  shown still and swaying at the bar's size and at 2x with a sample key, and with the shortest (`AB-1`)
  and longest (`TRIPS-12345`) key a poster must fit. A poster you register appears with no page change.
- **Which mascot would a session get?** Type a session key (`<TICKET>:<phase>`, such as
  `TAP-1234:implement`) to see the mascot the bar would give it, and its card is marked **Picked**.

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
merge-state group the ticket cards are masonry-packed using CSS multi-columns. The
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
Jira/GitHub dependency and sits outside the setup gate. A listing failure can
show an unavailable or incomplete result without blocking the rest of the app.

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
credentials at any time, requiring **Connect Slack** again.

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

The tab is one card laid out like the [My Tickets](#my-tickets) card, on the
same board frame ([UI layout](#ui-layout)). Its toolbar carries the title, an
account line (`Checking…`, `Connected as @user · team`, `Waiting for sign-in…`
or `Not connected`), a counts line, **Disconnect** (**Connect Slack** while not
connected), **Load more eligible threads** when more can be loaded, and
**Refresh** with a **refresh in N s** countdown. The counts line says how many
loaded threads need a reply and when the list was updated, and says so while
replies are still being checked or some reply states are unknown. While Slack is
checking, not connected or waiting for sign-in, the card shows only the toolbar
and one message in place of the switch row and the board.

A switch row under the toolbar chooses what the card shows. The first two views
are a board of `#ezat_claudio` threads created within the last rolling 28 days,
each tab carrying the number of threads it shows. An older thread is excluded
even if it has recent activity; there is no older-history option:

- **Threads I started** — thread roots authored by you, with reply count, who
  replied last, and how long ago.
- **Mentions** — threads where someone wrote `<@you>`, grouped to one row per
  thread with the mentioning message as the preview.
- **Watch threads** — the thread [watcher](#watch) in place of the board. Its tab
  shows how many threads are watched and turns amber, with a note you can hover
  or hear, while the watcher is paused, disabled or a delivery is failing, so that
  shows while another view is selected.

The switch row is a set of tabs for the keyboard too: only the selected tab is a
Tab stop, and the left and right arrow keys, **Home** and **End** move along the
row and select the tab they reach.

Each thread view groups eligible threads by latest known activity into **Last 3
hours**, **Today**, **Yesterday**, **Past week** and **Past month**, newest
first. The three-hour group takes precedence across midnight; the other groups
use local calendar days: Past week covers days 2–7 ago and Past month days 8–30
ago. Threads whose activity time cannot be verified (or lies in the future) are
not shown: the tab counts and the need-a-reply count leave them out, and the
amber note in the toolbar says how many were left out. A thread is flagged
**Needs reply** when its verified newest message is by another person; reply
status can also be unknown. Each view remembers its own column scroll positions
while you switch between them.

A click opens the conversation in the same in-app dialog My Tickets uses, with
**Open in Slack**, **Copy link** and the **Claude session** section
([Watch](#watch)). The conversation is fetched on demand, cached for a minute
and may be truncated; an open dialog closes when the thread passes the cutoff.

While Slack is connected and the tab is open, the list reloads every 60 seconds
(not while the page is hidden), counted down beside **Refresh**. **Refresh**
reloads it at once and restarts the countdown (My Tickets' **Refresh** does the
same); coming back to the tab reloads the list only when it is older than 60
seconds.

The server caches the list for five minutes and revalidates it in the background;
cached rows are still checked against the moving cutoff. An incomplete refresh
replaces the old list with only rows confirmed by that refresh, and both Slack
and My Tickets warn that results may be incomplete, even when no rows are found.
Counts cover the rows shown. **Load more eligible threads**, on the two thread
views, continues the current listing. Previously verified reply information can be reused
for a confirmed row while replies are checked; a warning says it may be stale.
Some reply states may remain unknown. A failed read backs off for a minute.

Discovery uses bounded history, search and reply reads. Ambiguous search or
history matches are skipped rather than risk reading an older thread, so some
recent standalone mentions may be missing. Slack search date boundaries and the
unofficial web session can also limit coverage. Live Slack behavior and the API
rate-limit impact have not been verified; listing and the independent watcher may
compete for Slack capacity.

The Slack tab label carries a badge: the unread mention count for
`#ezat_claudio`, or a dot when the channel has unreads but no unread mentions.
It comes from `client.counts` — another web-client-only method, parsed
defensively and cached for a minute — and it is hidden when Slack is
disconnected or when there is nothing unread.

The shaping rules (mrkdwn to text, epoch to ISO, "who spoke last") are pure and
live in [`backend/slack-model.mjs`](backend/slack-model.mjs); listing discovery and
budgets are in [`backend/slack-board.mjs`](backend/slack-board.mjs). Field notes on the
underlying endpoints — including the `thread_ts === ts` root marker and the
`search.messages` paging quirks — are in
[`toolkit-mcp/docs/slack-web-session.md`](../../toolkit-mcp/docs/slack-web-session.md).

### Watch

The Slack tab can also watch Slack threads and wake the Claude Code sessions that
are working on them. You paste thread links on the **Watch threads** view, a session
attaches its own id to a link over HTTP, and a watcher inside the dashboard server
reads each watched thread on a poll paced by the interval (a poll is called a tick below).
The watcher is separate from the board's 28-day listing cutoff: its configured
links, including older threads, retain the same watch behavior.
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
characters are rejected. A template without `{link}` is accepted and the view
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

**The Watch threads view.** Once Slack is connected, the third tab of the Slack
card's switch row, **Watch threads**, replaces the board with:

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

While the state is disabled, Add, Attach and Remove are disabled. The view polls only
the server's in-memory list, every 30 seconds, only while the Slack tab is open and
the page is visible, so it makes no Slack calls itself. It stays mounted while
**Threads I started** or **Mentions** is selected, so it keeps polling, and the
pasted links, the refused lines and the last action error are still there when you
switch back.
Reason codes are shown as the server sends them. A `waiting` status, and the reason
under `delivered` or `waiting`, are muted; the reason under a failure stays red.

**The thread dialog.** The dialog that opens from a My Tickets glyph or a Slack tab
row has a **Claude session** section for the thread it shows, on the same watcher as
the Watch threads view, so both screens behave the same. It lists the sessions
attached to that thread, each with a **Detach** button, or says "No session
attached". Its picker offers the sessions the view's picker offers
(`GET /api/slack/watch/sessions`), with the same labels, minus those already
attached to this thread; **Attach** stays disabled until one is chosen, and pasting a
session id stays on the Watch threads view. **Attach** also puts a thread that is not
yet watched on the Watch threads list, because it uses the same attach route. **Detach**
leaves the thread on that list; removing a thread stays on the view. The thread is
matched to its watch entry by the `watchKey` the server hands the dialog, never by a
link string. A failed attach or detach shows the view's words for that error in the
section and leaves it as it was, and the buttons are disabled while a request is in
flight. The section reads the watch list and the picker once when the dialog opens and
the watch list once more after each successful attach or detach; it never polls, so it
can lag behind the view until the dialog is reopened. When the watcher is disabled or its list
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
| `GET /api/slack/status`                  | `{ connected, connecting, user, team, savedAt, verified, sessionVersion }`; session fields are present when connected; never fails                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/slack/threads`                 | `{ available, channel, started[], mentions[], updatedAt, enriched }`; `enriched: false` while reply checks are still running; `available: false` when disconnected or unavailable; each thread carries `url` and `watchKey`, the `<channelId>:<ts>` string the watch list uses as `key` for that thread, both empty when the thread has no link; each `started` row also carries `attachedSessions`, the number of Claude sessions attached to it (`0` for none, with a disabled watcher or an unreadable watch list)                                                            |
| `GET /api/slack/pending`                 | `{ available, channel: { id, name, mentions, unread }, mentionsTotal, updatedAt }`; `available: false` when disconnected or unknown                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/slack/thread?ts=`              | one conversation: `{ available, thread: { ts, url, watchKey, channel, replyCount, truncated, updatedAt, names, messages[] } }`; `watchKey` is as for the thread lists; each message carries plain `text` and raw `mrkdwn`; `available: false` when disconnected, for a malformed or ineligible `ts`, for an unverified root, or for a thread Slack refuses                                                                                                                                                                                                                       |
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

A successful thread list also carries `serverTime`, `scope`, `partial`,
`partialReasons`, `truncated`, `stale`, `coverageNotes` and a `continuation`
token when more work is available. Pass that opaque token as `?continuation=` to
continue the current list; it can expire or become invalid after a refresh or
session change. The thread route requires a root verified in the current listing
snapshot. Unavailable responses can contain fewer fields.

`sessionVersion` is an opaque, process-local session generation used to discard
old list and dialog data. Deploy and roll back the backend and frontend together
so both sides use it. Detection is request-driven; an identical legacy credential
record replaced entirely between observations cannot be distinguished.

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

**Stopping.** The plain **Stop** button and `POST /api/services/:id/stop` send `SIGTERM` to the
service's process group and no more. **Restart**, a checkout switch and the dashboard's shutdown wait
for the old process to exit and escalate: `SIGTERM`, then `SIGKILL` to the same group after 5 s
(`STOP_GRACE_MS`). A restart waits up to 10 s and answers `{ ok: false, error: 'service did not
stop' }` (HTTP 400) when the service survives both signals; no second process is started then. A
restart can hold the settings lock for up to 10 s. A grandchild that outlives a group leader that
exited on `SIGTERM` is left alone on purpose. Service output is written to `logs/<id>/out.log` and
broadcast at most once per 250 ms (the first chunk at once, a trailing write after a burst, flushed
on exit and stop).

### Worktree picker

Each service card has a **checkout** select (`service-checkout-<id>`) that runs
the service from any git worktree of its repo, not only the main checkout under
the Settings root. It lists the repo's `git worktree list` output: the main
checkout first (shown as `main · <branch>`), then the worktrees by branch name
(a detached one reads `<7 hex> (detached)`). Bare and prunable worktrees are
left out. A repo that runs from a worktree shows a **worktree: &lt;folder&gt;**
badge (`service-checkout-badge-<id>`, full path on hover) on each of its cards.

- **Services of one repo switch together.** `be` and `queue` share
  `Portage-backend`, `legacy` and `legacy-ui` share `TravelTracker`; picking on
  one card moves them all and locks every card of the repo until the request
  ends.
- **A running repo is never swapped silently.** Picking while no service of the
  repo runs just records the choice; the next start uses it. Picking while any
  runs opens a confirm naming the running services; **Restart** stops them,
  waits up to 10 s for each to exit, and starts them again from the new
  checkout. Services of the repo that were stopped stay stopped.
- **What runs where.** The service's working directory, its `.nvmrc` lookup
  (the worktree's own file first, then the monorepo root's) and its
  `node_modules` warning all follow the chosen checkout. The port, command and
  log location (`logs/<id>/out.log`) are unchanged, and logs are cleared on the
  restart as for any start. A new worktree has no `node_modules` of its own:
  the start shows the usual warning and fails until you install there.
- **The choice is remembered** in `~/.config/dev-dashboard/checkouts.json`,
  separate from Settings, so a Settings save never drops it. Picking the main
  checkout removes the entry. Delete the file to put everything back on the
  main checkouts. A missing or corrupt file reads as no overrides. Services
  start stopped when the dashboard starts, so a remembered choice never swaps
  anything that is running. The CLI's in-process fallback reads the same file.
- **The list is read on demand**: when the Services tab loads (once per repo), when a select
  gains focus and when you click the Claude dialog's **Use in Services** (below). Nothing polls it.
- **Use in Services.** On a done implement row the Claude dialog's **Use in Services** reads
  `GET /api/repos/checkout-matches?key=TAP-n` once and, for a single matching repo, calls the existing
  `PUT /api/repos/:dir/checkout` with `restart: false`. Several matching repos get one button each; an
  ambiguous or missing match sends nothing (`pick one in Services`, `No worktree branch contains
TAP-n`); a running repo (`CHECKOUT_IN_USE`) asks before a second `PUT` with `restart: true`. It
  starts no service (a new worktree has no `node_modules`) and says that stopped services stay
  stopped. A match is a linked worktree whose branch contains `tap-n` or `trips-n` as a whole word
  (TAP and TRIPS are aliases, and `tap-145` never matches TAP-14); the main checkout and a detached
  head never match.

**Failure behaviour.**

- A service that is running while the pick is made and `restart` is not
  confirmed, or does not exit within 10 s, leaves everything as it was
  (409 `CHECKOUT_IN_USE`). After a stop timeout or a failed save of
  `checkouts.json` (503 `PERSISTENCE_FAILED`), the members the switch had
  already stopped are started again on the old checkout; one that ignored the
  stop signal is not restarted by this.
- Before anything stops, each running service is checked against the new
  checkout (its `.nvmrc` pin and Node installation); a pin that cannot be
  used is 422 `CHECKOUT_UNUSABLE` and nothing stops.
- If the switch succeeds but the new start fails (no `node_modules`, a removed
  directory), the service shows as exited with the reason in its log; switch
  back from the select.
- A worktree that is removed later is not cleaned up: its entry stays, the select
  shows `<folder> (not listed)`, and the next start fails with a
  `(no directory <path>)` line in the log until you pick another checkout.

**Limits.**

- A service's `dir` must be the root of a git worktree. If it is a subdirectory
  of a repo (or a bare repository), the listing and a pick answer
  `WORKTREES_UNAVAILABLE` (502): the select shows only the current checkout and
  reports "Checkouts unavailable" when focused, rather than starting from the
  worktree root.
- The repo's main checkout is matched by real path and is shown and used under
  the spelling configured in Settings, even when git prints another one. When
  `dir` is itself a linked worktree, that directory is "main" and the true main
  checkout is listed as an ordinary entry.
- The listing reads `git worktree list --porcelain -z` (git 2.36 or newer), so a
  worktree whose path contains a newline is listed with its true path.
- Services are grouped by the exact `dir` string; two services pointing at the
  same repo under different spellings are separate groups.

**API.** Both routes need setup to be ready (otherwise 409 `SETUP_REQUIRED`).
`:dir` is the URL-encoded `dir` of a configured service and must match it
exactly, so a value that is not a configured `dir` is 404 `UNKNOWN_REPO` before
git runs. Errors use the usual `{ code, error, errors }` body.

- `GET /api/repos/:dir/worktrees` answers `200`
  `{ "dir": "Portage-backend", "worktrees": [{ "path", "label", "isMain" }] }`.
  A git failure (not a repo, git missing, 5 s timeout) is 502
  `WORKTREES_UNAVAILABLE`.
- `PUT /api/repos/:dir/checkout` takes JSON `{ "path": "<a listed path>",
"restart": true }` (`restart` optional, boolean, default `false`). The server
  lists the worktrees again inside the settings lock and `path` must equal one
  listed `path` exactly (no normalising, no prefix match); anything else, a
  non-string or empty `path`, or a non-boolean `restart` is 400
  `INVALID_CHECKOUT`. Choosing the main checkout's path removes the override. It
  answers `200` `{ "ok": true, "dir", "checkout", "checkoutLabel", "restarted": ["be"] }`
  and broadcasts the status feed (it does after an error too).
- `GET /api/repos/checkout-matches?key=TAP-n` is read-only and lists each service repo's worktrees in
  parallel. It answers `{ key, repos: [{ dir, ids, status, ... }] }` with `status` `match` (plus `path`
  and `label`), `ambiguous` (plus `candidates`), `none` or `unavailable`; a bad key is 400
  `INVALID_TICKET`, a cross-site request 403, and one failing repo does not fail the answer.
- `409 CHECKOUT_IN_USE` (a service of the repo is running and `restart` is not
  `true`, or one did not exit in time), `422 CHECKOUT_UNUSABLE`,
  `503 PERSISTENCE_FAILED`.
- Every service in `GET /api/services` and `GET /api/events` now carries
  `checkout` (the absolute directory it uses, and was spawned in when running)
  and `checkoutLabel` (`null` for the main checkout, otherwise the worktree's
  folder name).

The picker's `data-testid` names (`service-checkout-<id>`,
`service-checkout-badge-<id>`, `service-checkout-dialog-<id>`,
`service-checkout-confirm-<id>`, `service-checkout-cancel-<id>`) are pinned by
`e2e/services-checkout.spec.js`; treat them as a contract. Results appear in the
card's `control-feedback-<id>` line.

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

Run `npm run lint` to check JavaScript and JSX with ESLint (`eslint . --max-warnings 0`, so a warning
fails it). `react-hooks/rules-of-hooks` (error) and `react-hooks/exhaustive-deps` (warn) apply to
`ui-react/`; an intentional exception carries
`eslint-disable-next-line react-hooks/exhaustive-deps -- <reason>`. `npm run format`
formats JavaScript, JSX, CSS, HTML and JSON files; use `npm run format:check`
to verify formatting without changing files (`team-velocity.html`, `.video-deck/` and `.playwright/`
are ignored by Prettier). `npm run check` runs lint, `format:check` and the unit suite (`npm test`) in
that order: it is the one-line local gate.

`.github/workflows/ci.yml` runs on a push to `master` and on pull requests. Job `check` (Node from
`.nvmrc`) runs `npm ci`, lint, `format:check`, `npm test`, `npm run build` and
`npm audit --omit=dev --audit-level=high`. Job `e2e` (Playwright, `npm run test:ui`) is separate and
non-blocking (`continue-on-error`, no `needs`) and uploads its report on failure. Which checks are
required is a repository setting.

`npm run test:ui` uses the main Playwright config, defaulting to four workers
with full parallelism. It runs against a fresh unminified production build of the
UI: `e2e/static-server.mjs` builds into `test-results/e2e-dist` (never `dist/`) and
serves it on port 6517, so only one run can go at a time and no test depends on
the Vite dev server (`npm run test:ui:serve` starts the same server by hand).
Actions time out after 5 s and navigations after 10 s. Tracing is off locally and
kept on failure on CI. Three switches, none needed for a normal run:
`PW_WORKERS` sets the worker count, a number or a share of the CPU threads
(`PW_WORKERS=2`, `PW_WORKERS=25%`; `--workers` on the command line wins);
`PW_TRACE` sets the trace mode (`PW_TRACE=retain-on-failure` turns tracing on to
debug a red test); `PW_HTML=1` also writes the HTML report to
`test/.settings-verification/playwright-report` (always written when `CI` is
set). `npm run test:ui:proxy` uses the separate, unchanged
vite-proxy config. Some existing full-suite tests write fixed screenshots under
`../docs/dev-dashboard-redesign/verification/screenshots/` and can overwrite
existing files there.

```
ui-react/
  main.jsx              React entry; mounts the themed App shell
  App.jsx               readiness gate, hash routes and one shared service feed
  lib/lazy-screen.js    React.lazy for a named export; lib/lazy-overlays.js for on-demand dialogs
  components/ScreenSlot.jsx  mounts a lazy screen on first visit, with its loading and error panels
  theme.js              compact dark MUI theme
  lib/api.js            one browser API boundary
  hooks/                shared service event, polling and API hooks
  components/           shell, reusable MUI primitives, filters and card wrappers
  panels/               Home, Services, PRs, My Tickets, Releases, Slack, Chat and Settings
  styles.css            theme variables plus the established bespoke panel CSS
ui/
  dom.js                esc / slug / clamp / copyText / timeAgo
  home-data.js          retained legacy Home counting / sprint / urgency helpers
  home-velocity.js      Home Team preference and validated aggregate snapshot storage
  work-filters.js       shared PR, ticket and action filtering (DOM-free)
  releases-data.js      release grouping and remembered version (DOM-free)
  keep-if-equal.js      keeps a state value when a new snapshot is byte-identical (DOM-free)
  ticket-board.js       My Tickets column order and CI / review wording (DOM-free)
  review-board.js       PR ticket progress and whole-ticket filters (DOM-free)
  components/           domain-free helpers and tested card/diff data rendering

ui-react/styles/        app-owned bespoke styles, imported by the Vite entry
```

React owns the shell, route state, theme, panel state, loading/polling and
interaction behavior. The panels compose shared React primitives for buttons,
cards, filters, listboxes, terminal output and status; domain-free selectors
and established card/diff helpers preserve existing calculations, escaping
and data-testid contracts. Masonry uses CSS multi-column packing with intact
cards and sibling spacing at 760px and 1700px; Services retains an explicit
CSS grid, Home uses one velocity pane in the shared board shell, and My Tickets, Slack and Pull Requests are
horizontally scrolling boards of columns that scroll on their own (see
[My Tickets](#my-tickets)). All three use one shared board frame,
[`ui-react/components/BoardShell.jsx`](ui-react/components/BoardShell.jsx) with
[`ui-react/styles/board.css`](ui-react/styles/board.css); how a new screen adopts
it is in [`CLAUDE.md`](CLAUDE.md). Legacy DOM panel controllers,
entry points, stylesheet tree and the API compatibility re-export have been
retired.

**Lazy screens and the bundle.** Chat, Releases, DevTools and Mascots load their code on first visit,
and so do the command palette, the shortcuts help, the ticket Claude dialog (with the prompts editor
and Use in Services it holds), the artifact viewer and the E2E check dialog. `npm run build` emits one
entry chunk plus per-screen chunks, about 621 KiB raw / 197 KiB gzip before first paint (it was 831
KiB / 252 KiB). A screen mounts on the render it is first active, or at once when the boot route names
it (`#/chat?session=<uuid>`, `#/releases?view=list`), and stays mounted, hidden, afterwards. While a
chunk loads a panel with the screen's own shape stands in; a chunk that fails (usually a tab that
outlived a deploy) shows a **Reload** state in place and the other tabs keep working. An opener of a
lazy overlay loads it first and opens when it settles, so the first press or click is never lost.
`test/bundle-budget.test.mjs` builds in memory and holds the initial JS to 640 KiB raw and 200 KiB
gzip, so a new eager import of a lazy module fails it. Identical service snapshots no longer re-render
the app (`ui/keep-if-equal.js`), and the refresh countdown re-renders only its own label and pauses
while the page is hidden or its screen is not shown.

`GET /api/config` supplies the tail line count, derived Jira browse URL and setup
status used to choose Settings-only or ready-mode boot.

The DOM is labelled with `data-testid` throughout for Playwright and agent use —
treat those names as a contract and don't rename them.

## Notes

- The dashboard server uses Node built-ins at runtime; `nodemon` is a
  development dependency used by `npm run dev`.
- On shutdown the dashboard SIGTERMs each service's process group and every running [Chat](#chat) turn,
  waits for every service to exit (up to 8 s, `SIGKILL` after 3 s) and then exits. A `npm run dev` restart (nodemon's `SIGUSR2`) does not run that clean-up; see
  [Chat limits](#chat-limits).
- **Logs are cleared on every start/restart** — a service always begins with a
  fresh in-memory buffer and empty `logs/<id>/out.log`, so previous-run output
  never lingers in the tail or the agent-readable file.
- `logs/<id>/out.log` holds a rolling buffer (last 64 KB per service) and is
  gitignored — never committed.
- The manager is an in-process class (`backend/manager.mjs`); the CLI and the HTTP
  server both use the same `Manager`, so `logs` is consistent whether the
  dashboard is running or not.
- **The dashboard cannot be framed.** Every reply the dashboard server sends (the API, the built
  UI, the `ui/` files, the `403`s and the `404`s; the handler in `backend/http-app.mjs` sets the
  headers before it looks at the request) carries `X-Frame-Options: DENY` and
  `Content-Security-Policy: frame-ancestors 'none'`. A browser that honours them refuses to
  render the dashboard inside an iframe, for example an IDE panel that embeds it; open it in a
  browser tab instead. The policy holds that one directive and restricts nothing else. This
  covers only the dashboard server (port 6500 by default). `npm run dev:ui` is Vite, a separate
  server, and `vite.config.js` sets no frame headers: the pages and modules Vite serves itself
  are not covered, and the only thing the config does to the `/api/*` requests it proxies is
  rewrite their `Origin` and `Host`, with nothing on the replies. Production serves the built UI
  from the dashboard server, so it is covered.
