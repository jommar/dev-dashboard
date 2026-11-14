// checkouts.mjs — which git checkout each repo's services run from: the worktree listing a repo
// offers, and the small file that remembers the chosen one between dashboard runs.
import fsDefault from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit } from './diff.mjs';
import { writeFileAtomic } from './credentials.mjs';

const LIST_TIMEOUT_MS = 5_000;
const LIST_MAX_BYTES = 1024 * 1024;
const VERSION = 1;

function unavailable(cause) {
  return Object.assign(new Error('Could not list git worktrees.', { cause }), {
    code: 'WORKTREES_UNAVAILABLE',
    status: 502,
  });
}

// The records of `git worktree list --porcelain -z`: NUL-terminated attributes, an empty token
// between records. NUL cannot occur in a path, so a path with a newline (or text that looks like
// an attribute) stays whole.
function parseRecords(output) {
  const records = [];
  let record = null;
  for (const token of output.split('\0')) {
    if (token === '') {
      record = null;
      continue;
    }
    const space = token.indexOf(' ');
    const key = space === -1 ? token : token.slice(0, space);
    if (key === 'worktree') {
      record = {};
      records.push(record);
    }
    if (record) record[key] = space === -1 ? '' : token.slice(space + 1);
  }
  return records;
}

function realOrResolved(dir) {
  try {
    return fsDefault.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

// The checkouts of the repo that `main` is the root of: `main` itself first (under the spelling
// the caller gave), the rest by label. A `main` that is not a listed worktree (a subdirectory of
// a repo, a bare repository) cannot be switched, so it is unavailable.
export async function listWorktrees(main, { run = runGit } = {}) {
  let output;
  try {
    output = await run(main, ['worktree', 'list', '--porcelain', '-z'], {
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: LIST_MAX_BYTES,
    });
  } catch (error) {
    throw unavailable(error);
  }
  const mainReal = realOrResolved(main);
  const listed = parseRecords(output)
    .filter((record) => !('bare' in record) && !('prunable' in record))
    .map((record) => ({
      path: record.worktree,
      label: record.branch
        ? record.branch.replace(/^refs\/heads\//, '')
        : `${String(record.HEAD).slice(0, 7)} (detached)`,
    }));
  const mainEntry = listed.find((entry) => realOrResolved(entry.path) === mainReal);
  if (!mainEntry) throw unavailable(new Error(`${main} is not a git worktree root`));
  return [
    { ...mainEntry, path: main, isMain: true },
    ...listed
      .filter((entry) => entry !== mainEntry)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((entry) => ({ ...entry, isMain: false })),
  ];
}

// The ticket key's project may be written under its pre-rename spelling in an older branch name.
const KEY_ALIASES = { TAP: ['tap', 'trips'], TRIPS: ['tap', 'trips'] };

// Which linked worktree of a repo belongs to the ticket `key`: the one whose branch names it, as a
// whole word (`tap-14-x` and `feature/tap-14` for TAP-14, never `tap-145` or `xtap-14`), under the
// key's pre-rename spelling too. The main checkout and a detached head never match. `ambiguous`
// names every candidate and picks none. `worktrees` is `listWorktrees`' answer.
export function matchWorktrees(key, worktrees) {
  const parsed = typeof key === 'string' ? /^([A-Z]{1,10})-(\d{1,7})$/.exec(key) : null;
  if (!parsed) return { status: 'none' };
  const [, project, number] = parsed;
  const prefixes = KEY_ALIASES[project] ?? [project.toLowerCase()];
  const named = new RegExp(`(?<![A-Za-z0-9])(?:${prefixes.join('|')})-${number}(?![0-9])`, 'i');
  const hits = worktrees.filter(
    ({ isMain, label }) => !isMain && !label.endsWith(' (detached)') && named.test(label),
  );
  if (hits.length === 0) return { status: 'none' };
  if (hits.length > 1)
    return { status: 'ambiguous', candidates: hits.map(({ label }) => label).sort() };
  return { status: 'match', path: hits[0].path, label: hits[0].label };
}

// `<home>/.config/dev-dashboard/checkouts.json`, keyed by a repo's absolute main checkout.
export function createCheckoutStore({ home = os.homedir(), fs = fsDefault } = {}) {
  const file = path.join(home, '.config', 'dev-dashboard', 'checkouts.json');

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed?.checkouts && typeof parsed.checkouts === 'object' ? parsed.checkouts : {};
    } catch {
      return {};
    }
  }

  return {
    get(main) {
      const value = read()[main];
      return typeof value === 'string' && path.isAbsolute(value) ? value : undefined;
    },
    set(main, checkout) {
      const checkouts = { ...read() };
      if (checkout === null) delete checkouts[main];
      else checkouts[main] = checkout;
      writeFileAtomic(file, JSON.stringify({ version: VERSION, checkouts }, null, 2) + '\n', fs);
    },
  };
}
