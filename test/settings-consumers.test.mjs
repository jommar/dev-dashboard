import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { settingsFixture, accept, githubToken, probeResponse } from './settings-fixture.mjs';

test('successive saved snapshots reach PR, review, Jira, nested UAT, velocity and diff without frozen env configuration', async (t) => {
  const f = settingsFixture(t);
  const store = await f.store();
  await accept(f, store);
  const github = await import('../github.mjs');
  const review = await import('../review.mjs');
  const jira = await import('../jira.mjs');
  const velocity = await import('../team-velocity.mjs');
  const uat = await import('../uat-promote.mjs');
  const diff = await import('../diff.mjs');
  const first = store.getSnapshot();
  const nextRoot = path.join(f.home, 'next-repos');
  fs.mkdirSync(nextRoot);
  fs.mkdirSync(path.join(nextRoot, 'next'));
  const next = {
    github: { ...f.configuration.github, org: 'NextOrg', repos: ['next'], maxResults: 9 },
    jira: {
      baseUrl: 'https://next-jira.example.invalid',
      email: 'next@example.invalid',
      sprintField: 'customfield_201',
      pointsField: 'customfield_202',
    },
    local: { root: nextRoot, services: [{ ...f.configuration.local.services[0], dir: 'next' }] },
    minPrApprover: 3,
  };
  f.network.route = (url, init) =>
    url.pathname === '/rest/api/3/field'
      ? Response.json([
          { id: 'customfield_201', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
          { id: 'customfield_202', schema: { type: 'number' } },
        ])
      : probeResponse(url, init);
  await store.save({
    ...next,
    expectedRevision: store.getSetupStatus().revision,
    credentials: { githubToken: 'synthetic-next-gh', jiraToken: 'synthetic-next-jira' },
  });
  const second = store.getSnapshot();
  process.env.GH_TOKEN = 'synthetic-env-must-not-win';
  process.env.JIRA_BASE_URL = 'https://env-must-not-win.example.invalid';
  t.after(() => {
    delete process.env.GH_TOKEN;
    delete process.env.JIRA_BASE_URL;
  });
  for (const scenario of [
    {
      snapshot: first,
      org: 'ExampleOrg',
      repo: 'app',
      root: f.root,
      base: 'https://jira.example.invalid',
      sprint: 'customfield_101',
      points: 'customfield_102',
      token: githubToken,
      basic: 'Basic cWFAZXhhbXBsZS5pbnZhbGlkOnN5bnRoZXRpYy1qaXJhLW9ubHktZm9yLXRlc3Rz',
      max: '17',
      threshold: 2,
    },
    {
      snapshot: second,
      org: 'NextOrg',
      repo: 'next',
      root: nextRoot,
      base: 'https://next-jira.example.invalid',
      sprint: 'customfield_201',
      points: 'customfield_202',
      token: 'synthetic-next-gh',
      basic: 'Basic bmV4dEBleGFtcGxlLmludmFsaWQ6c3ludGhldGljLW5leHQtamlyYQ==',
      max: '9',
      threshold: 3,
    },
  ]) {
    const calls = [];
    const ticket = {
      key: 'DEMO-1',
      fields: {
        summary: 'Example ticket',
        status: { name: 'Done', statusCategory: { name: 'Done' } },
        assignee: { displayName: 'QA' },
        [scenario.sprint]: [{ id: 12, name: 'Example Sprint 12', state: 'closed' }],
        [scenario.points]: 5,
      },
    };
    t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
      const url = new URL(input);
      calls.push({ url, init });
      if (url.hostname === 'api.github.com') {
        if (url.pathname === '/user') return Response.json({ login: 'qa' });
        if (url.pathname === '/search/issues')
          return Response.json({
            total_count: 1,
            items: [
              {
                number: 7,
                title: 'DEMO-1 Example',
                html_url: `https://github.com/${scenario.org}/${scenario.repo}/pull/7`,
                user: { login: 'qa' },
              },
            ],
          });
        if (/\/pulls\/7$/.test(url.pathname))
          return Response.json({ base: { ref: 'ops/development' } });
        if (url.pathname === '/graphql')
          return Response.json({
            data: {
              a0: {
                pullRequest: {
                  reviews: {
                    nodes: [
                      {
                        state: 'APPROVED',
                        author: { login: 'reviewer' },
                        submittedAt: '2026-09-01T00:00:00Z',
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            },
          });
      }
      if (url.origin === scenario.base && url.pathname === '/rest/api/3/search/jql') {
        return Response.json({ issues: [ticket], isLast: true });
      }
      assert.fail(`Unexpected consumer request: ${url.origin}${url.pathname}`);
    });
    const options = { snapshot: scenario.snapshot };
    const prs = await github.fetchOpenPRs(options);
    assert.equal(prs.prs[0].repo, `${scenario.org}/${scenario.repo}`);
    assert.equal(
      await github.fetchPrBase(`${scenario.org}/${scenario.repo}`, 7, options),
      'ops/development',
    );
    const enriched = await review.enrichOpenPRs(prs.prs, options);
    assert.equal(enriched.available, true);
    assert.equal(
      review.filterPrsNeedingApprovals(prs.prs, scenario.snapshot.minPrApprover).length,
      1,
    );
    assert.equal(scenario.snapshot.minPrApprover, scenario.threshold);
    const tickets = await jira.fetchMyTickets(options);
    assert.equal(tickets.tickets[0].storyPoints, 5);
    assert.equal(tickets.tickets[0].sprints[0].name, 'Example Sprint 12');
    const issues = await velocity.fetchTeamIssues(options);
    const boards = velocity.buildTeamBoards(issues, options);
    assert.equal(boards.get('Example').get('12').points, 10);
    const candidates = await uat.fetchUatPromoteCandidates(options);
    assert.equal(candidates.available, true);
    assert.equal(candidates.groups['DEMO-1'].prs[0].base, 'ops/development');
    const gitCalls = [];
    const result = await diff.getOriginDiff(
      { repo: `${scenario.org}/${scenario.repo}`, number: 7 },
      async (dir, args) => {
        gitCalls.push({ dir, args });
        if (args[0] === 'rev-parse') return 'synthetic-sha\n';
        if (args[0] === 'diff') return 'independent literal diff\n';
        return '';
      },
      options,
    );
    assert.equal(result.diff, 'independent literal diff\n');
    assert.ok(gitCalls.length > 0);
    assert.ok(gitCalls.every(({ dir }) => dir === path.join(scenario.root, scenario.repo)));
    assert.throws(() => diff.parseRepoRef('WrongOrg/unknown', options), /unknown repo/);
    for (const { url, init } of calls) {
      const headers = new Headers(init.headers);
      assert.equal(
        headers.get('authorization'),
        url.hostname === 'api.github.com' ? `Bearer ${scenario.token}` : scenario.basic,
      );
      if (url.pathname === '/search/issues') {
        assert.equal(
          url.searchParams.get('q'),
          `is:pr is:open author:qa repo:${scenario.org}/${scenario.repo}`,
        );
        assert.equal(url.searchParams.get('per_page'), scenario.max);
      }
      if (
        url.pathname === '/rest/api/3/search/jql' &&
        url.searchParams.get('fields')?.includes('assignee')
      ) {
        assert.ok(url.searchParams.get('fields').includes(scenario.sprint));
        assert.ok(url.searchParams.get('fields').includes(scenario.points));
      }
    }
    assert.ok(
      calls.filter(({ url }) => url.pathname === '/rest/api/3/search/jql').length >= 4,
      'nested UAT and velocity actually exercised',
    );
    const fieldRequests = calls.filter(
      ({ url }) =>
        url.pathname === '/rest/api/3/search/jql' &&
        !url.searchParams.get('jql')?.includes('Promote to UAT'),
    );
    for (const { url } of fieldRequests) {
      assert.ok(url.searchParams.get('fields').includes(scenario.sprint));
      assert.ok(url.searchParams.get('fields').includes(scenario.points));
    }
  }
  assert.equal(
    store.getSetupStatus().ready,
    true,
    'optional diff checkout availability does not affect readiness',
  );
});
