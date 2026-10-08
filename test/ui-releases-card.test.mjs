import test from 'node:test';
import assert from 'node:assert/strict';
import {
  releasePrRowHtml,
  releaseTicketCardHtml,
  versionOptionsHtml,
} from '../ui/components/releases-card.js';

const JIRA_BASE = 'https://jira.example.invalid/browse/';

const pr = (over = {}) => ({
  repo: 'example/api',
  number: 535,
  title: 'Mileage rate fix',
  url: 'https://github.com/example/api/pull/535',
  state: 'merged',
  base: 'ops/development',
  head: 'DEMO-1058/mileage-rate-fix',
  updatedAt: '2026-10-05T15:58:37Z',
  countsAsMerged: true,
  ...over,
});

const ticket = (over = {}) => ({
  key: 'DEMO-1058',
  summary: 'Update mileage rate lookup',
  status: 'In Progress',
  issueType: 'Story',
  priority: 'Medium',
  assignee: null,
  updated: '2026-10-06T12:00:00Z',
  mergeState: 'partial',
  prsStatus: 'ok',
  prs: [
    pr({ repo: 'example/web', number: 535 }),
    pr({ number: 2075, state: 'open', countsAsMerged: false }),
  ],
  ...over,
});

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const openingTag = (html, testId) =>
  html.match(new RegExp(`<[a-z]+\\b[^>]*data-testid="${escapeRegExp(testId)}"[^>]*>`))?.[0] ?? null;
const textOf = (html, testId) =>
  html.match(
    new RegExp(`<[a-z]+\\b[^>]*data-testid="${escapeRegExp(testId)}"[^>]*>([^<]*)<`),
  )?.[1] ?? null;
const anchors = (html) => html.match(/<a\b[^>]*>/g) ?? [];
const classesOf = (tag) => (tag.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);

const rowIds = (repo, number) => ({
  state: `release-pr-state-${repo}-${number}`,
  num: `release-pr-num-${repo}-${number}`,
  base: `release-pr-base-${repo}-${number}`,
});

test('a PR row shows its state pill, repo and number, and a base badge', () => {
  const html = releasePrRowHtml(pr());
  const ids = rowIds('example/api', 535);
  assert.equal(textOf(html, ids.state), 'merged');
  assert.match(openingTag(html, ids.state), /data-pr-state="merged"/);
  assert.match(textOf(html, ids.num), /example\/api/);
  assert.match(textOf(html, ids.num), /#535/);
  assert.equal(textOf(html, ids.base), 'ops/development');
  assert.doesNotMatch(openingTag(html, ids.base), /data-base-match="false"/);
});

for (const state of ['open', 'merged', 'declined', 'unknown']) {
  test(`a PR in state "${state}" shows the pill "${state}"`, () => {
    const html = releasePrRowHtml(pr({ state, countsAsMerged: false }));
    const ids = rowIds('example/api', 535);
    assert.equal(textOf(html, ids.state), state);
    assert.match(openingTag(html, ids.state), new RegExp(`data-pr-state="${state}"`));
  });
}

test('a merged PR whose base is not ops/development is flagged on its base badge and still reads merged', () => {
  const html = releasePrRowHtml(pr({ base: 'ops/qa', countsAsMerged: false }));
  const ids = rowIds('example/api', 535);
  assert.equal(textOf(html, ids.state), 'merged');
  assert.equal(textOf(html, ids.base), 'ops/qa');
  assert.match(openingTag(html, ids.base), /data-base-match="false"/);
});

test('PR title, branch and repo are escaped so markup in them stays text', () => {
  const html = releasePrRowHtml(
    pr({
      title: '<img src=x onerror=alert(1)> "quoted" & more',
      head: 'feature/<script>alert(1)</script>',
      repo: 'example/<b>repo</b>',
    }),
  );
  assert.doesNotMatch(html, /<img|<script|<b>/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &amp; more'));
  assert.ok(html.includes('feature/&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('example/&lt;b&gt;repo&lt;/b&gt;'));
});

test('a PR with no url renders its title without any link', () => {
  const html = releasePrRowHtml(pr({ url: null }));
  assert.doesNotMatch(html, /<a[\s>]/);
  assert.doesNotMatch(html, /href=/);
  assert.ok(html.includes('Mileage rate fix'));
});

test('a PR link points at the PR and carries rel noopener noreferrer', () => {
  const links = anchors(releasePrRowHtml(pr()));
  assert.ok(links.length >= 1);
  assert.ok(links.some((link) => link.includes('href="https://github.com/example/api/pull/535"')));
  for (const link of links) assert.match(link, /rel="noopener noreferrer"/);
});

test('a ticket card links the key to Jira, shows the summary and lists every PR', () => {
  const html = releaseTicketCardHtml(ticket(), JIRA_BASE);
  const root = openingTag(html, 'release-ticket-DEMO-1058');
  assert.ok(root, 'the card carries the release-ticket-<KEY> test id');
  assert.ok(classesOf(root).includes('release-ticket'));
  const keyLink = anchors(html).find((link) =>
    link.includes('href="https://jira.example.invalid/browse/DEMO-1058"'),
  );
  assert.ok(keyLink, 'the key links to the Jira issue');
  assert.ok(html.includes('Update mileage rate lookup'));
  assert.equal(textOf(html, 'release-pr-state-example/web-535'), 'merged');
  assert.equal(textOf(html, 'release-pr-state-example/api-2075'), 'open');
  for (const link of anchors(html)) assert.match(link, /rel="noopener noreferrer"/);
});

test('a ticket with PRs reads neither "No linked PRs" nor "PRs unavailable"', () => {
  const html = releaseTicketCardHtml(ticket(), JIRA_BASE);
  assert.ok(!html.includes('No linked PRs'));
  assert.ok(!html.includes('PRs unavailable'));
});

test('a ticket with no PRs reads "No linked PRs"', () => {
  const html = releaseTicketCardHtml(ticket({ mergeState: 'no-pr', prs: [] }), JIRA_BASE);
  assert.ok(html.includes('No linked PRs'));
  assert.ok(!html.includes('PRs unavailable'));
});

test('a ticket whose PR lookup failed reads "PRs unavailable", never "No linked PRs"', () => {
  const html = releaseTicketCardHtml(
    ticket({ mergeState: 'unavailable', prsStatus: 'unavailable', prsError: 'timeout', prs: [] }),
    JIRA_BASE,
  );
  assert.ok(html.includes('PRs unavailable'));
  assert.ok(!html.includes('No linked PRs'));
});

const failureNote = (html) => {
  const match = html.match(/<[a-z]+\b[^>]*\sdata-error="([^"]*)"[^>]*>([^<]*)</);
  return match ? { error: match[1], text: match[2] } : null;
};

for (const prsError of ['timeout', 'http', 'instance-mismatch']) {
  test(`a ticket whose PR lookup failed with "${prsError}" names that reason in its note`, () => {
    const html = releaseTicketCardHtml(
      ticket({ mergeState: 'unavailable', prsStatus: 'unavailable', prsError, prs: [] }),
      JIRA_BASE,
    );
    assert.deepEqual(failureNote(html), { error: prsError, text: `PRs unavailable (${prsError})` });
  });
}

test('a ticket whose PRs were read carries no failure reason', () => {
  assert.equal(failureNote(releaseTicketCardHtml(ticket(), JIRA_BASE)), null);
  assert.equal(
    failureNote(releaseTicketCardHtml(ticket({ mergeState: 'no-pr', prs: [] }), JIRA_BASE)),
    null,
  );
});

test('a ticket card escapes the summary and the PR text it embeds', () => {
  const html = releaseTicketCardHtml(
    ticket({
      summary: '<script>alert(1)</script> & more',
      prs: [pr({ title: '<img src=x onerror=alert(1)>' })],
    }),
    JIRA_BASE,
  );
  assert.doesNotMatch(html, /<script|<img/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

const optionGroups = (html) =>
  [...html.matchAll(/<optgroup\b([^>]*)>([\s\S]*?)<\/optgroup>/g)].map(([, attributes, body]) => ({
    label: attributes.match(/label="([^"]*)"/)?.[1],
    options: [...body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(
      ([, optionAttributes, text]) => ({
        value: optionAttributes.match(/value="([^"]*)"/)?.[1],
        selected: /(?:^|\s)selected(?:=|\s|$)/.test(optionAttributes),
        text,
      }),
    ),
  }));

test('version options group Unreleased before Released and mark the selected one', () => {
  const html = versionOptionsHtml(
    [
      {
        id: '18741',
        name: 'EZAT | Sprint 19.0 | 10/09/26',
        released: false,
        releaseDate: '2026-10-09',
        family: 'EZAT',
      },
      {
        id: '18838',
        name: 'EZAT | Sprint 20.0 | 10/23/26',
        released: false,
        releaseDate: '2026-10-23',
        family: 'EZAT',
      },
      {
        id: '18600',
        name: 'EZAT | Sprint 18.0 | 09/25/26',
        released: true,
        releaseDate: '2026-09-25',
        family: 'EZAT',
      },
      {
        id: '18590',
        name: 'AS | Sprint 11.0 | 09/18/26',
        released: true,
        releaseDate: '2026-09-18',
        family: 'AS',
      },
    ],
    '18838',
  );
  const groups = optionGroups(html);
  assert.deepEqual(
    groups.map(({ label, options }) => [
      label,
      options.map(({ value, selected }) => [value, selected]),
    ]),
    [
      [
        'Unreleased',
        [
          ['18741', false],
          ['18838', true],
        ],
      ],
      [
        'Released',
        [
          ['18600', false],
          ['18590', false],
        ],
      ],
    ],
  );
  assert.ok(groups[0].options[0].text.includes('EZAT | Sprint 19.0 | 10/09/26'));
  assert.ok(groups[1].options[1].text.includes('AS | Sprint 11.0 | 09/18/26'));
});
