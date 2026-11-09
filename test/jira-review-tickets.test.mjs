import test from 'node:test';
import assert from 'node:assert/strict';
import * as jira from '../backend/jira.mjs';
import { issue, snapshot, stubQueue } from './review-queue-fixture.mjs';

const JQL =
  'assignee IS NOT EMPTY AND assignee != currentUser() AND status = "Ready For Code Review" ORDER BY updated DESC';
const loader = () => {
  assert.equal(
    typeof jira.fetchReviewReadyTickets,
    'function',
    'export the review-only Jira reader',
  );
  return jira.fetchReviewReadyTickets;
};
const ticketsOf = (result) => (Array.isArray(result) ? result : result.tickets);

test('review eligibility is exact trusted JQL, not PR authors, projects, sprints or approval thresholds', () => {
  assert.equal(
    typeof jira.buildReviewTicketsJql,
    'function',
    'export the review eligibility query',
  );
  assert.equal(jira.buildReviewTicketsJql(), JQL);
});

test('review Jira reader pages past the own-ticket cap, maps configured fields and returns each issue once', async (t) => {
  const fetchReviewReadyTickets = loader();
  const issues = Array.from({ length: 251 }, (_, index) => issue(`DEMO-${index + 1}`));
  const seen = [];
  const stub = stubQueue(t, {
    jira: ({ url, init }) => {
      assert.equal(url.searchParams.get('jql'), JQL);
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      const fields = url.searchParams.get('fields').split(',');
      for (const name of [
        'summary',
        'status',
        'priority',
        'updated',
        'created',
        'customfield_101',
      ]) {
        assert.ok(fields.includes(name), `configured field ${name}`);
      }
      const token = url.searchParams.get('nextPageToken');
      seen.push(token);
      const offset = token ? Number(token.slice(5)) : 0;
      const end = Math.min(offset + 50, issues.length);
      return Response.json({
        issues: [...issues.slice(offset, end), ...(offset === 50 ? [issues[0]] : [])],
        isLast: end === issues.length,
        ...(end < issues.length ? { nextPageToken: `page-${end}` } : {}),
      });
    },
  });
  const tickets = ticketsOf(await fetchReviewReadyTickets({ snapshot: snapshot() }));
  assert.equal(tickets.length, 251);
  assert.equal(new Set(tickets.map((ticket) => ticket.key)).size, 251);
  assert.equal(seen.length, 6);
  assert.equal(tickets[0].summary, issues[0].fields.summary);
  assert.equal(tickets[0].status, 'Ready For Code Review');
  assert.equal(tickets[0].priority, 'High');
  assert.equal(tickets[0].sprint.name, 'Synthetic sprint');
  assert.equal(tickets[0].sprints.length, 1);
  assert.ok(stub.timeouts.length >= 6);
  assert.ok(stub.timeouts.every((ms) => ms === 15_000));
  assert.deepEqual(stub.unexpected, []);
});

test('review Jira reader fails missing configuration without any network request', async (t) => {
  const fetchReviewReadyTickets = loader();
  const stub = stubQueue(t);
  await assert.rejects(
    () => fetchReviewReadyTickets({ snapshot: snapshot({ jira: {} }) }),
    /jira|configured/i,
  );
  assert.deepEqual(stub.calls, []);
});

for (const [name, secondPage] of [
  ['HTTP failure', () => Response.json({ message: 'synthetic failure' }, { status: 503 })],
  [
    'timeout',
    () => {
      throw new DOMException('Synthetic timeout', 'TimeoutError');
    },
  ],
  [
    'repeated cursor',
    () => Response.json({ issues: [issue('DEMO-2')], isLast: false, nextPageToken: 'again' }),
  ],
  ['missing cursor', () => Response.json({ issues: [issue('DEMO-2')], isLast: false })],
  ['non-string cursor', () => Response.json({ issues: [], isLast: false, nextPageToken: 2 })],
  ['malformed issues', () => Response.json({ issues: null, isLast: true })],
  ['missing pagination verdict', () => Response.json({ issues: [] })],
]) {
  test(`review Jira ${name} after a successful page is an error, never a successful prefix`, async (t) => {
    const fetchReviewReadyTickets = loader();
    let calls = 0;
    stubQueue(t, {
      jira: () => {
        calls += 1;
        assert.ok(calls <= 3, 'pagination must terminate rather than loop');
        return calls === 1
          ? Response.json({ issues: [issue()], isLast: false, nextPageToken: 'again' })
          : secondPage();
      },
    });
    await assert.rejects(() => fetchReviewReadyTickets({ snapshot: snapshot() }));
    assert.ok(calls >= 2);
  });
}
