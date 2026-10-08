// Service table for the dev dashboard.
//
// Each entry mirrors the start commands in scripts/run.sh, but runs each service
// as its own independently-controllable child process. Port values are used only
// for the label / link and for a lightweight "is it up?" health hint — they are
// not the source of truth for where the app binds (that comes from each repo).
//
// cwd is relative to the monorepo root (parent of the dashboard folder).

// Monorepo root: config.mjs lives in <repo>/dev-dashboard/backend/, so two levels up.
export const REPOS_ROOT = new URL('../../', import.meta.url).pathname;
export const LOGS_DIR = new URL('../logs/', import.meta.url).pathname;

// `path` gives a cross-platform resolve for the local .env file path (github.mjs
// reads it via the same path — no hardcoded cwd assumptions).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const DASHBOARD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Tail default: every surface (UI, CLI, file, HTTP) respects this so nothing
// dumps more than N lines unless explicitly asked.
export const DEFAULT_TAIL_LINES = 40;

export const DEFAULT_MIN_PR_APPROVER = 1;

export function parseMinPrApprover(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return DEFAULT_MIN_PR_APPROVER;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_PR_APPROVER;
}

export function getMinPrApprover() {
  return parseMinPrApprover(process.env.MIN_PR_APPROVER);
}

// Rolling buffer size per service (bytes). Keeps memory + token cost bounded.
export const BUFFER_BYTES = 64 * 1024;

export const DASHBOARD_HOST = '127.0.0.1';
export const DASHBOARD_PORT = 6500;

// GitHub PR dashboard — org + repos to scan for the authenticated user's open
// PRs. Token is read at request time from GH_TOKEN / GITHUB_TOKEN (see
// github.mjs); it is never written here or logged.
export const GITHUB = {
  api: 'https://api.github.com',
  org: 'TransActComm',
  repos: ['Portage-backend', 'Portage-frontend', 'TravelTracker'],
  maxResults: 50,
};

// Jira browse base — a ticket key is appended to form a link (e.g.
// TRIPS-1691 → https://pathwise.atlassian.net/browse/TRIPS-1691). Used to make
// PR group titles clickable. Group keys that don't look like a ticket key
// (e.g. 'Unticketed') are NOT linked.
export const JIRA_BASE = 'https://pathwise.atlassian.net/browse/';

// Map of service id -> definition.
export const SERVICES = {
  be: {
    id: 'be',
    label: 'Portage Backend',
    dir: 'Portage-backend',
    command: ['npm', 'run', 'start:dev'],
    port: 8000,
  },
  fe: {
    id: 'fe',
    label: 'Portage Frontend',
    dir: 'Portage-frontend',
    command: ['npm', 'run', 'dev'],
    port: 3000,
  },
  legacy: {
    id: 'legacy',
    label: 'TravelTracker API',
    dir: 'TravelTracker',
    command: ['npm', 'run', 'start:be'],
    port: 8081,
  },
  'legacy-ui': {
    id: 'legacy-ui',
    label: 'TravelTracker UI',
    dir: 'TravelTracker',
    command: ['npm', 'run', 'serve'],
    port: null,
  },
  queue: {
    id: 'queue',
    label: 'Portage Queue',
    dir: 'Portage-backend',
    command: ['npm', 'run', 'queue:dev'],
    port: null,
  },
};

export function serviceIds() {
  return Object.keys(SERVICES);
}

export function hasService(id) {
  return Object.prototype.hasOwnProperty.call(SERVICES, id);
}
