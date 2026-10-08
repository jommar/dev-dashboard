// diff.mjs — copy-diff backend: unified diff of origin/ops/development vs a
// PR head, via raw git only (no GitHub API call).
//
// GitHub exposes every PR head as `pull/<N>/head` on the origin remote, so the
// PR's branch name is never needed — not even for fork PRs. Both sides are
// fetched from origin (never touching local branches), then diffed with the
// three-dot (merge-base) form, which matches GitHub's PR diff semantics.
//
// Zero external deps: node:child_process, node:fs, node:path.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { captureConfiguration } from './settings.mjs';

// Base is fixed: the diff is always against origin/ops/development.
export const DIFF_BASE = 'ops/development';
// Scratch namespace for fetched PR heads — never a local branch.
export const DIFF_TMP_NS = 'refs/dash-diff/';
export const DIFF_TIMEOUT_MS = 20_000;
// Reject unusually large diffs instead of copying an invalid, truncated patch.
export const DIFF_MAX_BYTES = 16 * 1024 * 1024;

export function allowedRepos({ snapshot } = {}) {
  const GITHUB = captureConfiguration(snapshot).github;
  return (GITHUB.repos || []).map((r) => `${GITHUB.org}/${r}`);
}

// `TransActComm/TravelTracker` -> `TravelTracker`. Throws with statusHint 400
// on anything outside the allowlist (never passed to git unvalidated).
export function parseRepoRef(repo, options) {
  const text = String(repo ?? '');
  const allowed = allowedRepos(options);
  if (!allowed.includes(text)) {
    const err = new Error(`unknown repo: ${text}`);
    err.statusHint = 400;
    throw err;
  }
  return text.split('/')[1];
}

// Positive safe integer only — the number is interpolated into the
// `pull/<N>/head` refspec, so anything non-numeric is rejected here.
export function parsePrNumber(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    const err = new Error(`invalid PR number: ${text}`);
    err.statusHint = 400;
    throw err;
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) {
    const err = new Error(`invalid PR number: ${text}`);
    err.statusHint = 400;
    throw err;
  }
  return n;
}

export function repoDir(shortName, { snapshot } = {}) {
  const dir = path.resolve(captureConfiguration(snapshot).local.root, shortName);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    const err = new Error(`not a local git repo: ${shortName}`);
    err.statusHint = 404;
    throw err;
  }
  return dir;
}

function runGit(dir, args, { timeout = DIFF_TIMEOUT_MS, maxBuffer = DIFF_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: dir, timeout, maxBuffer, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          // Truncation-worthy overflow surfaces as a maxBuffer error — report it
          // as too-large rather than a generic git failure.
          if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            const tooLarge = new Error('diff too large to copy');
            tooLarge.statusHint = 413;
            reject(tooLarge);
            return;
          }
          const detail = String(stderr || err.message || '')
            .trim()
            .split('\n')
            .pop();
          const failed = new Error(`git ${args[0]} failed: ${detail || err.message}`);
          failed.statusHint = 502;
          reject(failed);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function tmpRefFor(number) {
  return `${DIFF_TMP_NS}${number}-${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

async function cleanupRef(dir, ref, runner) {
  try {
    await runner(dir, ['update-ref', '-d', ref], { timeout: 5000 });
  } catch {
    // best effort — a leftover scratch ref is harmless and namespaced.
  }
}

// Unified diff `origin/ops/development...pull/<number>/head` for one PR in one
// repo. Raw git only: no token, no GitHub API. Resolves to
// { repo, number, base, baseSha, headSha, headRef, diff }.
// `overrides.dir` skips the local-repo existence check (tests only).
export async function getOriginDiff({ repo, number }, runner = runGit, overrides = {}) {
  const snapshot = captureConfiguration(overrides.snapshot);
  const shortName = parseRepoRef(repo, { snapshot });
  const n = parsePrNumber(number);
  const dir =
    overrides.dir ||
    (runner !== runGit
      ? path.resolve(snapshot.local.root, shortName)
      : repoDir(shortName, { snapshot }));
  const baseRef = `origin/${DIFF_BASE}`;
  const baseFetchRef = `+refs/heads/${DIFF_BASE}:refs/remotes/${baseRef}`;
  const headRef = `pull/${n}/head`;
  const tmpRef = tmpRefFor(n);
  try {
    // Keep fetches sequential: concurrent fetches in one working tree can
    // contend over FETCH_HEAD and shared ref locks.
    await runner(dir, ['fetch', '--no-tags', 'origin', baseFetchRef]);
    await runner(dir, ['fetch', '--no-tags', 'origin', `${headRef}:${tmpRef}`]);
    const [baseSha, headSha] = await Promise.all([
      runner(dir, ['rev-parse', '--verify', baseRef]).then((s) => s.trim()),
      runner(dir, ['rev-parse', '--verify', tmpRef]).then((s) => s.trim()),
    ]);
    const diff = await runner(dir, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      `${baseRef}...${tmpRef}`,
      '--',
    ]);
    return {
      repo,
      number: n,
      base: DIFF_BASE,
      baseSha,
      headSha,
      headRef,
      diff,
    };
  } finally {
    await cleanupRef(dir, tmpRef, runner);
  }
}
