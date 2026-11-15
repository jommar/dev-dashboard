import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { lookUpPullRequests, resetPullRequestCaches } from '../backend/dev-status.mjs';
import { fetchRelease, resetReleaseCaches } from '../backend/releases.mjs';
import { snapshot } from './review-queue-fixture.mjs';

const INSTANCE = 'oAuth-com.github.integration.production';
const cfg = {
  baseUrl: 'https://jira.example.invalid',
  email: 'qa@example.invalid',
  token: 'synthetic-dev-status-token',
};
const OWNED = { number: 7, title: 'TAP-1 fix login', head: 'TAP-1/login' };
const PROMOTION = { number: 8, title: '[MERGE] ops/development -> UAT', head: 'ops/uat' };

const rawPr = ({ number, title, head }) => ({
  id: `#${number}`,
  name: title,
  status: 'OPEN',
  url: `https://github.com/ExampleOrg/app/pull/${number}`,
  repositoryName: 'ExampleOrg/app',
  source: { branch: head },
  destination: { branch: 'ops/development' },
  lastUpdate: '2026-10-05T15:58:37.000Z',
});

// One ticket (id 10001, TAP-1) whose dev-status lists an owned PR and a promotion PR. `calls` logs
// every Jira request by kind.
function stubJira(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    const kind = /\/rest\/dev-status\/latest\/issue\/(summary|detail)$/.exec(url.pathname)?.[1];
    calls.push({ kind: kind ?? url.pathname, url });
    if (kind === 'summary') {
      return Response.json({
        summary: {
          pullrequest: {
            overall: { count: 2 },
            byInstanceType: { [INSTANCE]: { count: 2, name: 'GitHub' } },
          },
        },
      });
    }
    if (kind === 'detail') {
      return Response.json({
        detail: [{ _instance: { name: 'GitHub', type: INSTANCE }, pullRequests: linked() }],
      });
    }
    if (url.pathname === '/rest/api/3/project/TAP/versions') {
      return Response.json([
        {
          id: '18741',
          name: 'Sprint 19.0',
          archived: false,
          released: false,
          releaseDate: '2026-10-09',
        },
      ]);
    }
    if (url.pathname === '/rest/api/3/search/jql') {
      return Response.json({
        isLast: true,
        issues: [
          {
            id: '10001',
            key: 'TAP-1',
            fields: {
              summary: 'Summary',
              status: { name: 'In Progress' },
              updated: '2026-10-05T12:00:00.000+0000',
            },
          },
        ],
      });
    }
    return new Response('{}', { status: 404 });
  });
  return calls;
}
const linked = () => [rawPr(OWNED), rawPr(PROMOTION)];
const entry = { issueId: '10001', ticket: { key: 'TAP-1' } };
const read = async (options) => (await lookUpPullRequests(cfg, [entry], options)).get(entry);
const numbers = (outcome) => outcome.prs.map((pr) => pr.number).sort();
const jiraCalls = (calls) =>
  calls.filter((call) => call.kind === 'summary' || call.kind === 'detail');

beforeEach(() => {
  resetPullRequestCaches();
  resetReleaseCaches();
});

test('a lookup returns every linked PR, owned or not', async (t) => {
  stubJira(t);
  const outcome = await read({ refresh: false, ttlMs: 60_000 });
  assert.deepEqual(numbers(outcome), [7, 8]);
});

test('a second reader with a longer ttl is served from the cache with every linked PR', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const calls = stubJira(t);
  assert.deepEqual(numbers(await read({ refresh: false, ttlMs: 60_000 })), [7, 8]);
  const cold = jiraCalls(calls).length;
  assert.ok(cold > 0, 'the first read calls Jira');

  t.mock.timers.tick(90_000);
  const warm = await read({ refresh: false, ttlMs: 120_000 });
  assert.equal(jiraCalls(calls).length, cold, 'the 120 s reader makes no Jira call at 90 s');
  assert.deepEqual(numbers(warm), [7, 8], 'the cache holds both PRs');
});

test('a reader with a shorter ttl treats the same entry as expired and reads again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const calls = stubJira(t);
  await read({ refresh: false, ttlMs: 120_000 });
  const cold = jiraCalls(calls).length;

  t.mock.timers.tick(90_000);
  await read({ refresh: false, ttlMs: 60_000 });
  assert.ok(jiraCalls(calls).length > cold, 'the 60 s reader calls Jira at 90 s');
});

test('refresh skips the cache read', async (t) => {
  const calls = stubJira(t);
  await read({ refresh: false, ttlMs: 120_000 });
  const cold = jiraCalls(calls).length;
  await read({ refresh: false, ttlMs: 120_000 });
  assert.equal(jiraCalls(calls).length, cold, 'a warm read makes no call');
  await read({ refresh: true, ttlMs: 120_000 });
  assert.ok(jiraCalls(calls).length > cold, 'refresh reads Jira again');
});

test('resetPullRequestCaches empties the cache', async (t) => {
  const calls = stubJira(t);
  await read({ refresh: false, ttlMs: 120_000 });
  const cold = jiraCalls(calls).length;
  resetPullRequestCaches();
  await read({ refresh: false, ttlMs: 120_000 });
  assert.ok(jiraCalls(calls).length > cold, 'the read after a reset calls Jira');
});

test('a Releases read after a My Tickets lookup of the same ticket still lists only the ownsPr PRs', async (t) => {
  const calls = stubJira(t);
  assert.deepEqual(numbers(await read({ refresh: false, ttlMs: 120_000 })), [7, 8]);
  const afterLookup = jiraCalls(calls).length;

  const release = await fetchRelease({ versionId: '18741', mine: true, snapshot: snapshot() });
  const [ticket] = release.tickets;
  assert.equal(ticket.key, 'TAP-1');
  assert.deepEqual(
    ticket.prs.map((pr) => pr.number),
    [7],
    'the promotion PR in the shared cache is filtered out by ownsPr',
  );
  assert.equal(jiraCalls(calls).length, afterLookup, 'Releases is served from the shared cache');
});
