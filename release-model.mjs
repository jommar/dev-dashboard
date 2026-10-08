// release-model.mjs — pure rules behind the Releases tab and `cli.mjs releases`:
// version ordering, request validation, JQL, PR ownership and merge roll-up,
// CLI argument parsing and text output. No I/O and no imports, so the browser
// data module and plain `node --test` runs can load it without touching
// settings or credentials.

const VERSION_FAMILY = /^\s*(?:\[(EZAT|AS)\]|(EZAT|AS)\s*\|)/i;
const MAX_RELEASED_VERSIONS = 20;

const familyOf = (name) => {
  const match = VERSION_FAMILY.exec(name);
  return match ? (match[1] || match[2]).toUpperCase() : 'Other';
};

// Undated versions sort after dated ones in either direction.
const byDate = (direction) => (a, b) => {
  if (a.releaseDate === b.releaseDate) return 0;
  if (a.releaseDate === null) return 1;
  if (b.releaseDate === null) return -1;
  return direction * (a.releaseDate < b.releaseDate ? -1 : 1);
};

// Jira returns versions in no useful order: unreleased first by release date,
// then the newest released ones, never archived.
export function orderVersions(raw) {
  const versions = (Array.isArray(raw) ? raw : [])
    .filter(
      (version) =>
        version &&
        version.archived !== true &&
        typeof version.name === 'string' &&
        version.id != null,
    )
    .map((version) => ({
      id: String(version.id),
      name: version.name,
      released: version.released === true,
      releaseDate: typeof version.releaseDate === 'string' ? version.releaseDate : null,
      family: familyOf(version.name),
    }));
  const upcoming = versions.filter((version) => !version.released).sort(byDate(1));
  const released = versions
    .filter((version) => version.released)
    .sort(byDate(-1))
    .slice(0, MAX_RELEASED_VERSIONS);
  return [...upcoming, ...released];
}

export function defaultVersionId(ordered) {
  const pick =
    ordered.find((version) => !version.released && version.family === 'EZAT') ||
    ordered.find((version) => !version.released) ||
    ordered.find((version) => version.released);
  return pick ? pick.id : null;
}

const VERSION_ID = /^\d{1,12}$/;
const SCOPES = ['mine', 'all'];

const badRequest = (message) => Object.assign(new Error(message), { statusHint: 400 });

export function parseReleaseQuery(searchParams) {
  const version = searchParams.get('version');
  if (version !== null && !VERSION_ID.test(version)) throw badRequest('invalid release version');
  const scope = searchParams.get('scope') ?? 'mine';
  if (!SCOPES.includes(scope)) throw badRequest('invalid release scope');
  return {
    versionId: version,
    mine: scope === 'mine',
    refresh: searchParams.get('refresh') === '1',
  };
}

// The id must come from the version list fetched in the same request, so a
// request parameter can never name a version Jira did not just report.
export function resolveVersion(input, versions) {
  const found =
    typeof input === 'string' && VERSION_ID.test(input)
      ? versions.find((version) => version.id === input)
      : undefined;
  if (!found) throw badRequest('unknown release version');
  return found;
}

export function buildReleaseTicketsJql({ versionId, mine }) {
  if (typeof versionId !== 'string' || !VERSION_ID.test(versionId))
    throw badRequest('invalid release version');
  return `fixVersion = ${versionId}${mine ? ' AND assignee = currentUser()' : ''} ORDER BY key ASC`;
}

const TICKET_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;
const PR_STATES = { OPEN: 'open', MERGED: 'merged', DECLINED: 'declined' };

// Dev-status lists every PR of a ticket's repos, promotion PRs and other
// tickets' PRs included. A PR belongs to the ticket only when the key is a whole
// token in its title or source branch: a longer number or a longer prefix is a
// different key.
export function ownsPr(ticketKey, rawPr) {
  const key = String(ticketKey).toUpperCase();
  if (!TICKET_KEY.test(key)) return false;
  const wholeToken = new RegExp(`(?<![A-Za-z0-9])${key}(?!\\d)`, 'i');
  return [rawPr?.name, rawPr?.source?.branch].some(
    (text) => typeof text === 'string' && wholeToken.test(text),
  );
}

const textOf = (value) => (typeof value === 'string' ? value : '');

// Dev-status URLs are third-party text rendered as links, so anything that is
// not a plain GitHub pull request address is dropped rather than escaped.
export function normalizeDevStatusPr(rawPr) {
  const number = Number.parseInt(String(rawPr.id ?? '').replace(/^#/, ''), 10);
  return {
    repo: textOf(rawPr.repositoryName),
    number: Number.isSafeInteger(number) ? number : null,
    title: textOf(rawPr.name),
    url: PULL_REQUEST_URL.test(rawPr.url) ? rawPr.url : null,
    state: PR_STATES[String(rawPr.status).toUpperCase()] || 'unknown',
    base: textOf(rawPr.destination?.branch),
    head: textOf(rawPr.source?.branch),
    updatedAt: typeof rawPr.lastUpdate === 'string' ? rawPr.lastUpdate : null,
  };
}

const DEVELOPMENT_BASE = 'ops/development';

// Merged means it reached ops/development from a feature branch; a promotion
// PR that fast-forwards another ops branch into it is not the ticket's work.
export function classifyPr({ state, base, head }) {
  return state === 'merged' && base === DEVELOPMENT_BASE && !head.startsWith('ops/');
}

// Declined PRs are superseded work and never change the answer.
export function rollUpTicket(prs, lookup) {
  if (lookup === 'unavailable') return 'unavailable';
  const live = prs.filter((pr) => pr.state !== 'declined');
  if (!live.length) return 'no-pr';
  const merged = live.filter((pr) => pr.countsAsMerged).length;
  if (merged === live.length) return 'merged';
  return merged ? 'partial' : 'open';
}

// Shared by the server text output and the browser grouping: the states a
// reader still has to act on come first, merged last.
export const MERGE_STATE_ORDER = ['open', 'partial', 'no-pr', 'unavailable', 'merged'];

const RELEASES_USAGE = 'usage: releases [--version <id|name>] [--all] [--json]';

export function parseReleasesArgs(args) {
  let version = null;
  const at = args.indexOf('--version');
  if (at !== -1) {
    version = args[at + 1];
    if (version === undefined || version.startsWith('--')) throw new Error(RELEASES_USAGE);
  }
  return { version, all: args.includes('--all'), json: args.includes('--json') };
}

// Names are matched exactly and resolved to an id here, so a name never reaches JQL.
export function resolveVersionByName(name, versions) {
  const matches = versions.filter((version) => version.name === name);
  if (matches.length !== 1)
    throw badRequest(
      matches.length
        ? 'more than one release version has that name; use its id'
        : 'no release version has that name',
    );
  return matches[0];
}

const GROUP_TITLES = {
  open: 'Open',
  partial: 'Partly merged',
  'no-pr': 'No PRs',
  unavailable: 'PRs unavailable',
  merged: 'Merged',
};

export function formatReleaseText(data) {
  if (!data.version) return 'No release versions found.';
  const { version, tickets } = data;
  const lines = [
    `${version.released ? 'Released' : 'Unreleased'} version ${version.name}${version.releaseDate ? ` (${version.releaseDate})` : ''}` +
      ` - ${data.scope === 'all' ? 'all tickets' : 'your tickets'}`,
    `${data.total} ticket${data.total === 1 ? '' : 's'}${data.truncated ? ' (truncated: the release has more)' : ''}`,
  ];
  for (const state of MERGE_STATE_ORDER) {
    const group = tickets.filter((ticket) => ticket.mergeState === state);
    if (!group.length) continue;
    lines.push('', `== ${GROUP_TITLES[state]} (${group.length})`);
    for (const ticket of group) {
      const details = [ticket.issueType, ticket.priority, ticket.assignee]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `  ${ticket.key}  ${(ticket.summary || '').slice(0, 100)}${details ? ` (${details})` : ''}`,
      );
      if (ticket.prsStatus === 'unavailable')
        lines.push(`    PRs unavailable (${ticket.prsError})`);
      for (const pr of ticket.prs)
        lines.push(`    #${pr.number} ${pr.repo} ${pr.state} -> ${pr.base}`);
    }
  }
  return lines.join('\n');
}
