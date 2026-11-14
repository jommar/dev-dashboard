// ticket-specs.test.mjs — which tickets already have an ezat-specs PR, for the My Tickets icon.
// `fetch` is a local GraphQL double, so nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTicketSpecs } from '../backend/spec-reviews.mjs';
import { API, snapshot } from './review-queue-fixture.mjs';

const pr = (number, title, state = 'OPEN') => ({
  number,
  title,
  state,
  url: `https://github.com/TransActComm/ezat-specs/pull/${number}`,
});

// Serves `pages` in order, one per request, and records each query.
function double(t, pages) {
  const queries = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    assert.equal(String(input), `${API}/graphql`, 'only the GraphQL endpoint is called');
    const { query } = JSON.parse(init.body);
    queries.push(query);
    const page = pages[queries.length - 1];
    if (page instanceof Response) return page;
    const last = queries.length === pages.length;
    return Response.json({
      data: {
        repository: {
          pullRequests: {
            nodes: page,
            pageInfo: { hasNextPage: !last, endCursor: last ? null : `c${queries.length}` },
          },
        },
      },
    });
  });
  return queries;
}

test('a ticket named in an open or merged spec PR title maps to that PR', async (t) => {
  const queries = double(t, [
    [pr(30, '[TAP-100] Trip export spec'), pr(20, 'Spec for TAP-200', 'MERGED')],
  ]);
  const result = await fetchTicketSpecs({ snapshot: snapshot() });
  assert.deepEqual(result, {
    available: true,
    byTicket: {
      'TAP-100': {
        number: 30,
        url: 'https://github.com/TransActComm/ezat-specs/pull/30',
        state: 'OPEN',
      },
      'TAP-200': {
        number: 20,
        url: 'https://github.com/TransActComm/ezat-specs/pull/20',
        state: 'MERGED',
      },
    },
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0], /name: "ezat-specs"/);
  assert.match(queries[0], /states: \[OPEN, MERGED\]/, 'a closed, unmerged PR is never asked for');
});

test('TRIPS keys fold onto TAP, every key in a title counts and the newest PR wins', async (t) => {
  double(t, [[pr(9, 'TRIPS-5 and TAP-6 together'), pr(3, 'TAP-5 first draft', 'MERGED')]]);
  const { byTicket } = await fetchTicketSpecs({ snapshot: snapshot() });
  assert.deepEqual(Object.keys(byTicket).sort(), ['TAP-5', 'TAP-6']);
  assert.equal(byTicket['TAP-5'].number, 9);
  assert.equal(byTicket['TAP-6'].number, 9);
});

test('a title with no ticket key names no ticket', async (t) => {
  double(t, [[pr(1, 'Process spec: release checklist')]]);
  assert.deepEqual(await fetchTicketSpecs({ snapshot: snapshot() }), {
    available: true,
    byTicket: {},
  });
});

test('later pages are read until GitHub says there are no more', async (t) => {
  const queries = double(t, [[pr(3, 'TAP-3 spec')], [pr(2, 'TAP-2 spec')], [pr(1, 'TAP-1 spec')]]);
  const { available, byTicket } = await fetchTicketSpecs({ snapshot: snapshot() });
  assert.equal(available, true);
  assert.deepEqual(Object.keys(byTicket).sort(), ['TAP-1', 'TAP-2', 'TAP-3']);
  assert.match(queries[1], /after: "c1"/);
  assert.match(queries[2], /after: "c2"/);
});

test('a scan stops at the page cap', async (t) => {
  const queries = [];
  // Every page claims another follows: the cap, not the double, ends the scan.
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    queries.push(JSON.parse(init.body).query);
    return Response.json({
      data: {
        repository: {
          pullRequests: {
            nodes: [pr(queries.length, `TAP-${queries.length} spec`)],
            pageInfo: { hasNextPage: true, endCursor: `c${queries.length}` },
          },
        },
      },
    });
  });
  const { byTicket } = await fetchTicketSpecs({ snapshot: snapshot() });
  assert.equal(queries.length, 10);
  assert.equal(Object.keys(byTicket).length, 10);
});

test('no token, a failed request, an error answer or a thrown fetch all read as unavailable', async (t) => {
  const none = { available: false, byTicket: {} };
  const noToken = snapshot();
  noToken.credentials = { ...noToken.credentials, githubToken: '' };
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no token, no call'));
  assert.deepEqual(await fetchTicketSpecs({ snapshot: noToken }), none);
  t.mock.restoreAll();
  for (const respond of [
    () => new Response('bad gateway', { status: 502 }),
    () => Response.json({ errors: [{ message: 'boom' }], data: null }),
    () => Response.json({ data: { repository: null } }),
    () => {
      throw new TypeError('network down');
    },
  ]) {
    t.mock.method(globalThis, 'fetch', async () => respond());
    assert.deepEqual(await fetchTicketSpecs({ snapshot: snapshot() }), none);
    t.mock.restoreAll();
  }
});
