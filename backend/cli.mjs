#!/usr/bin/env node
// cli.mjs — agent/human-facing tail + control commands.
//
//   node backend/cli.mjs logs    <id> [--lines N]    tail a service's recent logs
//   node backend/cli.mjs restart <id|--all>          restart one or all services
//   node backend/cli.mjs stop    <id|--all>          stop one or all services
//   node backend/cli.mjs start   <id|--all>          start one or all services
//   node backend/cli.mjs status                      list services with status
//   node backend/cli.mjs prs                         list the user's open PRs
//   node backend/cli.mjs my-tickets [--include-done] [--json]
//                                            list Jira tickets assigned to you
//   node backend/cli.mjs releases [--version <id|name>] [--all] [--json]
//                                            list a Jira fix version's tickets with
//                                            the merge state of their GitHub PRs
//   node backend/cli.mjs team-velocity [--sprints N] [--out PATH]
//                                            rebuild team-velocity.html (whole-team
//                                            sprint velocity, last N sprints)
//
// Talks to the running dashboard over HTTP if it is up; otherwise it drives its
// own Manager in-process (so `logs` works even with no server running).
import { resolve } from 'node:path';
import { Manager } from './manager.mjs';
import { settingsStore } from './settings.mjs';
import { DASHBOARD_DIR, DEFAULT_TAIL_LINES, DASHBOARD_HOST, DASHBOARD_PORT } from './config.mjs';
import { fetchOpenPRs, groupByTicket } from './github.mjs';
import { fetchMyTickets } from './jira.mjs';
import { fetchRelease, formatReleaseText, parseReleasesArgs } from './releases.mjs';
import { DEFAULT_KEEP_SPRINTS, rebuildTeamVelocity } from './team-velocity.mjs';
import { approvalCount, enrichOpenPRs, filterPrsNeedingApprovals } from './review.mjs';

const [, , command, ...rest] = process.argv;
let snapshot;
let serviceDefinitions;
const savedHasService = (id) => serviceDefinitions.some((definition) => definition.id === id);
const savedServiceIds = () => serviceDefinitions.map((definition) => definition.id);

function parseFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}
function hasFlag(args, name) {
  return args.includes(name);
}

function usage() {
  console.log(`dev-dashboard

  logs    <id> [--lines N]    tail last N lines (default ${DEFAULT_TAIL_LINES})
  restart <id|--all>          restart one or all services
  stop    <id|--all>          stop one or all services
  start   <id|--all>          start one or all services
  status                      list services
  prs                         list the user's open PRs
  my-tickets [--include-done] [--json]
                               list Jira tickets assigned to you, grouped by status
  releases [--version <id|name>] [--all] [--json]
                               list a fix version's tickets and whether their PRs merged
                               (default: earliest unreleased EZAT version, your tickets;
                               --all lists every assignee)
  team-velocity [--sprints N] [--out PATH]
                               rebuild team-velocity.html (whole-team velocity)

  reads live logs from the dashboard at http://${DASHBOARD_HOST}:${DASHBOARD_PORT}
  when it is running; otherwise it drives services directly.
`);
}

async function tryDashboard() {
  let t;
  try {
    const ctrl = new AbortController();
    t = setTimeout(() => ctrl.abort(), 800);
    const res = await fetch(`http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/api/services`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      if (body?.code === 'SETUP_REQUIRED')
        throw Object.assign(new Error('Complete Settings setup before using dashboard commands.'), {
          code: 'SETUP_REQUIRED',
        });
      return null;
    }
    return { base: `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}` };
  } catch (error) {
    if (error.code === 'SETUP_REQUIRED') throw error;
    return null;
  } finally {
    clearTimeout(t);
  }
}

function resolveTargets(target, all) {
  const ids = all ? savedServiceIds() : [target];
  for (const id of ids) {
    if (!savedHasService(id)) {
      throw new Error(`unknown service: ${id}\navailable: ${savedServiceIds().join(', ')}`);
    }
  }
  return ids;
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }

  const dash = await tryDashboard();
  await settingsStore.initialize();
  await settingsStore.refreshReadiness?.();
  if (!settingsStore.getSetupStatus().ready)
    throw new Error('Complete Settings setup before using dashboard commands.');
  snapshot = settingsStore.getSnapshot();
  serviceDefinitions = snapshot.local.services;
  const makeManager = () => new Manager({ local: snapshot.local });

  if (command === 'status') {
    if (dash) {
      const { services } = await fetch(`${dash.base}/api/services`).then((r) => r.json());
      for (const s of services) console.log(`${s.id.padEnd(10)} ${s.status.padEnd(9)} ${s.label}`);
    } else {
      const m = makeManager();
      for (const s of m.list()) console.log(`${s.id.padEnd(10)} ${s.status.padEnd(9)} ${s.label}`);
    }
    return;
  }

  if (command === 'logs') {
    const id = rest[0];
    if (!id || !savedHasService(id)) {
      console.error(`usage: logs <id> [--lines N]\navailable: ${savedServiceIds().join(', ')}`);
      process.exit(1);
    }
    const raw = parseFlag(rest, '--lines');
    const lines = parseInt(raw, 10) || DEFAULT_TAIL_LINES;
    if (dash) {
      const text = await fetch(
        `${dash.base}/api/logs/${encodeURIComponent(id)}?lines=${lines}`,
      ).then((r) => r.text());
      process.stdout.write(text);
    } else {
      // In-process: start nothing, just read the (empty) tail if the server
      // is down — likely means nothing is running, so report that clearly.
      const m = makeManager();
      const tail = m.logs(id, lines);
      process.stdout.write(tail || '', { encoding: 'utf8' });
      if (!tail) console.error(`(dashboard not running — no captured logs for ${id})`);
    }
    return;
  }

  if (command === 'prs') {
    try {
      const [data, approvalData] = await Promise.all([
        fetchOpenPRs({ snapshot }),
        fetchOpenPRs({ mine: false, snapshot }).catch(() => null),
      ]);
      console.log(`${data.total} open PR${data.total === 1 ? '' : 's'} for ${data.login}:`);
      for (const [ticket, prs] of Object.entries(data.groups)) {
        const label = ticket === 'Unticketed' ? 'Unticketed' : ticket;
        console.log(`\n  ${label} (${prs.length})`);
        for (const p of prs) {
          console.log(
            `    #${String(p.number).padEnd(5)} ${p.title.replace(/^(\[[A-Z0-9-]+\]\s*)+/i, '')} (${p.repo}, @${p.owner || 'unknown'})`,
          );
        }
      }
      console.log(`\n  ${data.total} total`);
      const approvalThreshold = snapshot.minPrApprover;
      const reviewData = approvalData
        ? await enrichOpenPRs(approvalData.prs, { snapshot })
        : { available: false, reviews: {} };
      if (!reviewData.available) {
        console.log(
          '\n  Approval section unavailable (open PR or review data could not be fetched).',
        );
      } else {
        const needingApprovals = filterPrsNeedingApprovals(approvalData.prs, approvalThreshold);
        console.log(`\n  PRs needing approvals (threshold: ${approvalThreshold})`);
        const groups = groupByTicket(needingApprovals);
        if (!needingApprovals.length) {
          console.log('    None');
        } else {
          for (const [ticket, prs] of Object.entries(groups)) {
            console.log(`\n    ${ticket} (${prs.length})`);
            for (const p of prs) {
              console.log(
                `      #${String(p.number).padEnd(5)} ${p.title.replace(/^(\[[A-Z0-9-]+\]\s*)+/i, '')} (${p.repo}, @${p.owner || 'unknown'}) - ${approvalCount(p)}/${approvalThreshold} approvals`,
              );
            }
          }
        }
      }
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  if (command === 'my-tickets') {
    try {
      const includeDone = hasFlag(rest, '--include-done') || hasFlag(rest, '--all');
      const asJson = hasFlag(rest, '--json');
      const data = await fetchMyTickets({ includeDone, snapshot });
      if (asJson) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(
        `${data.total} Jira ticket${data.total === 1 ? '' : 's'} assigned to you${includeDone ? ' (including Done)' : ''}:`,
      );
      const actives = data.activeSprints || [];
      console.log(
        actives.length
          ? `  Active sprint: ${actives.map((s) => s.name).join(' · ')}`
          : '  Active sprint: none among your tickets',
      );
      if (!data.total) {
        console.log('  None');
        return;
      }
      for (const [category, tickets] of Object.entries(data.groupsByCategory)) {
        console.log(`\n  == ${category} (${tickets.length})`);
        // Sub-group by status name (already sorted upstream).
        let currentStatus = null;
        for (const t of tickets) {
          if (t.status !== currentStatus) {
            currentStatus = t.status;
            const inStatus = tickets.filter((x) => x.status === currentStatus).length;
            console.log(`\n    -- ${currentStatus} (${inStatus})`);
          }
          const pts = Number.isFinite(t.storyPoints) ? `${t.storyPoints} pts` : null;
          const bits = [t.priority, t.issueType, pts].filter(Boolean).join(', ');
          const sprint = t.sprint ? `${bits ? ' — ' : ''}${t.sprint.name}` : '';
          const tail = bits || sprint ? ` (${bits}${sprint})` : '';
          console.log(`      ${t.key}  ${(t.summary || '').slice(0, 100)}${tail}`);
        }
      }
      console.log(`\n  ${data.total} total`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  if (command === 'releases') {
    try {
      const { version, all, json } = parseReleasesArgs(rest);
      const selector =
        version === null || /^\d+$/.test(version)
          ? { versionId: version }
          : { versionName: version };
      const data = await fetchRelease({ ...selector, mine: !all, refresh: false, snapshot });
      console.log(json ? JSON.stringify(data, null, 2) : formatReleaseText(data));
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  if (command === 'team-velocity') {
    try {
      const rawKeep = parseFlag(rest, '--sprints');
      const keep =
        rawKeep == null
          ? DEFAULT_KEEP_SPRINTS
          : Math.max(1, parseInt(rawKeep, 10) || DEFAULT_KEEP_SPRINTS);
      const out = parseFlag(rest, '--out');
      const outPath = out ? resolve(out) : resolve(DASHBOARD_DIR, 'team-velocity.html');
      await rebuildTeamVelocity({ keep, outPath, snapshot });
      console.log(`team velocity rebuilt: ${outPath} (last ${keep} sprints per board)`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  if (['start', 'stop', 'restart'].includes(command)) {
    const all = hasFlag(rest, '--all');
    const target = all ? null : rest[0];
    let ids;
    try {
      ids = resolveTargets(target, all);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }

    const fallback = dash ? null : makeManager();
    for (const id of ids) {
      if (dash) {
        const response = await fetch(
          `${dash.base}/api/services/${encodeURIComponent(id)}/${command}`,
          { method: 'POST' },
        );
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(
            body?.error || `Dashboard ${command} ${id} failed (HTTP ${response.status})`,
          );
        }
        console.log(`${command} ${id} (via dashboard)`);
      } else {
        const m = fallback;
        if (command === 'restart') await m.restart(id);
        else if (command === 'stop') await m.stop(id);
        else await m.start(id);
        console.log(`${command} ${id} (in-process)`);
      }
    }
    return;
  }

  usage();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
