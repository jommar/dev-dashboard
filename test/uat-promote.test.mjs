import test from 'node:test';
import assert from 'node:assert/strict';
import * as jira from '../backend/jira.mjs';
import * as github from '../backend/github.mjs';

// jira.mjs and github.mjs exist today but do not yet export the Promote-to-UAT
// symbols under test, so these are imported as namespaces (not destructured)
// — a missing export then surfaces as a per-test "not a function" failure
// instead of an import-time crash that would take the whole file down.

test('uat-promote JQL scopes to the current assignee and Promote to UAT status', () => {
  assert.equal(
    jira.buildUatPromoteJql(),
    'assignee = currentUser() AND status = "Promote to UAT" ORDER BY updated DESC',
  );
});

test('uat-promote ticket fetch throws when unconfigured, maps issues when it is', async () => {
  const prevEnv = {
    base: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_TOKEN,
  };
  const prevFetch = globalThis.fetch;
  delete process.env.JIRA_BASE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_TOKEN;
  try {
    await assert.rejects(() => jira.fetchUatPromoteTickets(), /JIRA_BASE_URL/);

    process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
    process.env.JIRA_EMAIL = 'me@example.com';
    process.env.JIRA_TOKEN = 'tok';
    globalThis.fetch = async (url) => {
      const u = decodeURIComponent(String(url)).replace(/\+/g, ' ');
      assert.match(u, /status = "Promote to UAT"/);
      return {
        ok: true,
        json: async () => ({
          issues: [
            {
              key: 'PRT-10',
              fields: { summary: 'Ready to ship', status: { name: 'Promote to UAT' } },
            },
            {
              key: 'PRT-11',
              fields: { summary: 'Also ready', status: { name: 'Promote to UAT' } },
            },
          ],
        }),
      };
    };
    const tickets = await jira.fetchUatPromoteTickets();
    assert.deepEqual(tickets, [
      { key: 'PRT-10', summary: 'Ready to ship', status: 'Promote to UAT', sprint: null },
      { key: 'PRT-11', summary: 'Also ready', status: 'Promote to UAT', sprint: null },
    ]);
  } finally {
    if (prevEnv.base === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = prevEnv.base;
    if (prevEnv.email === undefined) delete process.env.JIRA_EMAIL;
    else process.env.JIRA_EMAIL = prevEnv.email;
    if (prevEnv.token === undefined) delete process.env.JIRA_TOKEN;
    else process.env.JIRA_TOKEN = prevEnv.token;
    globalThis.fetch = prevFetch;
  }
});

test('uat-promote candidates drop a ticket absent from the PR groups', async () => {
  const prevEnv = {
    base: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_TOKEN,
    ghToken: process.env.GH_TOKEN,
  };
  const prevFetch = globalThis.fetch;
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
  process.env.JIRA_EMAIL = 'me@example.com';
  process.env.JIRA_TOKEN = 'tok';
  process.env.GH_TOKEN = 'gh-tok';
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('search/jql')) {
        return {
          ok: true,
          json: async () => ({
            issues: [
              {
                key: 'PRT-20',
                fields: { summary: 'No PR yet', status: { name: 'Promote to UAT' } },
              },
            ],
          }),
        };
      }
      if (u.includes('/user')) {
        return { ok: true, json: async () => ({ login: 'testuser' }) };
      }
      // fetchOpenPRs() (now called internally by fetchUatPromoteCandidates)
      // returns a PR grouped under a different ticket, so PRT-20 has none.
      if (u.includes('search/issues')) {
        return {
          ok: true,
          json: async () => ({
            total_count: 1,
            items: [
              {
                number: 1,
                title: '[OTHER-1] unrelated ticket',
                user: { login: 'testuser' },
                html_url: 'https://github.com/org/repo/pull/1',
                created_at: '2024-01-01T00:00:00Z',
                updated_at: '2024-01-01T00:00:00Z',
                draft: false,
                labels: [],
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    const { fetchUatPromoteCandidates } = await import('../backend/uat-promote.mjs');
    const result = await fetchUatPromoteCandidates();
    assert.ok(!Object.prototype.hasOwnProperty.call(result.groups, 'PRT-20'));
  } finally {
    if (prevEnv.base === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = prevEnv.base;
    if (prevEnv.email === undefined) delete process.env.JIRA_EMAIL;
    else process.env.JIRA_EMAIL = prevEnv.email;
    if (prevEnv.token === undefined) delete process.env.JIRA_TOKEN;
    else process.env.JIRA_TOKEN = prevEnv.token;
    if (prevEnv.ghToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevEnv.ghToken;
    globalThis.fetch = prevFetch;
  }
});

test('uat-promote candidates filter PRs to the ops/development base', async () => {
  const prevEnv = {
    jiraBase: process.env.JIRA_BASE_URL,
    jiraEmail: process.env.JIRA_EMAIL,
    jiraToken: process.env.JIRA_TOKEN,
    ghToken: process.env.GH_TOKEN,
  };
  const prevFetch = globalThis.fetch;
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
  process.env.JIRA_EMAIL = 'me@example.com';
  process.env.JIRA_TOKEN = 'tok';
  process.env.GH_TOKEN = 'gh-tok';
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('search/jql')) {
        return {
          ok: true,
          json: async () => ({
            issues: [
              { key: 'PRT-30', fields: { summary: 'Two PRs', status: { name: 'Promote to UAT' } } },
            ],
          }),
        };
      }
      if (u.includes('/user')) {
        return { ok: true, json: async () => ({ login: 'testuser' }) };
      }
      // fetchOpenPRs() (now called internally) returns both PRs grouped
      // under PRT-30; the base-branch filter below narrows to just #1.
      if (u.includes('search/issues')) {
        return {
          ok: true,
          json: async () => ({
            total_count: 2,
            items: [
              {
                number: 1,
                title: '[PRT-30] first',
                user: { login: 'testuser' },
                html_url: 'https://github.com/org/repo/pull/1',
                created_at: '2024-01-01T00:00:00Z',
                updated_at: '2024-01-01T00:00:00Z',
                draft: false,
                labels: [],
              },
              {
                number: 2,
                title: '[PRT-30] second',
                user: { login: 'testuser' },
                html_url: 'https://github.com/org/repo/pull/2',
                created_at: '2024-01-01T00:00:00Z',
                updated_at: '2024-01-01T00:00:00Z',
                draft: false,
                labels: [],
              },
            ],
          }),
        };
      }
      if (/\/pulls\/1$/.test(u)) {
        return { ok: true, json: async () => ({ base: { ref: 'ops/development' } }) };
      }
      if (/\/pulls\/2$/.test(u)) {
        return { ok: true, json: async () => ({ base: { ref: 'main' } }) };
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    const { fetchUatPromoteCandidates } = await import('../backend/uat-promote.mjs');
    const result = await fetchUatPromoteCandidates();
    assert.deepEqual(
      result.groups['PRT-30'].prs.map((pr) => pr.number),
      [1],
    );
    assert.equal(result.total, 1);
  } finally {
    if (prevEnv.jiraBase === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = prevEnv.jiraBase;
    if (prevEnv.jiraEmail === undefined) delete process.env.JIRA_EMAIL;
    else process.env.JIRA_EMAIL = prevEnv.jiraEmail;
    if (prevEnv.jiraToken === undefined) delete process.env.JIRA_TOKEN;
    else process.env.JIRA_TOKEN = prevEnv.jiraToken;
    if (prevEnv.ghToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevEnv.ghToken;
    globalThis.fetch = prevFetch;
  }
});

test('uat-promote candidates degrade instead of throwing when Jira fails', async () => {
  const prevEnv = {
    base: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_TOKEN,
    ghToken: process.env.GH_TOKEN,
  };
  const prevFetch = globalThis.fetch;
  delete process.env.JIRA_BASE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_TOKEN;
  process.env.GH_TOKEN = 'gh-tok';
  try {
    // The internal fetchOpenPRs() call is mocked to succeed, so this test
    // isolates Jira failing as the trigger for degrading, rather than
    // conflating it with a GitHub failure.
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/user')) return { ok: true, json: async () => ({ login: 'testuser' }) };
      if (u.includes('search/issues'))
        return { ok: true, json: async () => ({ total_count: 0, items: [] }) };
      throw new Error(`unexpected fetch: ${u}`);
    };
    const { fetchUatPromoteCandidates } = await import('../backend/uat-promote.mjs');
    const result = await fetchUatPromoteCandidates();
    assert.deepEqual(result, { available: false, groups: {}, total: 0 });
  } finally {
    if (prevEnv.base === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = prevEnv.base;
    if (prevEnv.email === undefined) delete process.env.JIRA_EMAIL;
    else process.env.JIRA_EMAIL = prevEnv.email;
    if (prevEnv.token === undefined) delete process.env.JIRA_TOKEN;
    else process.env.JIRA_TOKEN = prevEnv.token;
    if (prevEnv.ghToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevEnv.ghToken;
    globalThis.fetch = prevFetch;
  }
});

test('uat-promote candidates degrade instead of throwing when the internal fetchOpenPRs() call fails', async () => {
  const prevEnv = {
    base: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_TOKEN,
    ghToken: process.env.GH_TOKEN,
    ghTokenAlt: process.env.GITHUB_TOKEN,
  };
  const prevFetch = globalThis.fetch;
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
  process.env.JIRA_EMAIL = 'me@example.com';
  process.env.JIRA_TOKEN = 'tok';
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    // Jira is mocked to succeed (a real "Promote to UAT" ticket would exist),
    // so this test isolates the internal fetchOpenPRs() call failing (no
    // GH_TOKEN/GITHUB_TOKEN) as the trigger for degrading, rather than
    // conflating it with a Jira failure — the mirror image of the "when Jira
    // fails" test above.
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('search/jql')) {
        return {
          ok: true,
          json: async () => ({
            issues: [
              { key: 'PRT-40', fields: { summary: 'Ready', status: { name: 'Promote to UAT' } } },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    const { fetchUatPromoteCandidates } = await import('../backend/uat-promote.mjs');
    const result = await fetchUatPromoteCandidates();
    assert.deepEqual(result, { available: false, groups: {}, total: 0 });
  } finally {
    if (prevEnv.base === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = prevEnv.base;
    if (prevEnv.email === undefined) delete process.env.JIRA_EMAIL;
    else process.env.JIRA_EMAIL = prevEnv.email;
    if (prevEnv.token === undefined) delete process.env.JIRA_TOKEN;
    else process.env.JIRA_TOKEN = prevEnv.token;
    if (prevEnv.ghToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevEnv.ghToken;
    if (prevEnv.ghTokenAlt === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevEnv.ghTokenAlt;
    globalThis.fetch = prevFetch;
  }
});

test('uat-promote fetchPrBase resolves the PR base ref, rejects without a token', async () => {
  const prevToken = { gh: process.env.GH_TOKEN, ghAlt: process.env.GITHUB_TOKEN };
  const prevFetch = globalThis.fetch;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    await assert.rejects(() => github.fetchPrBase('org/repo', 9), /no GH_TOKEN/);

    process.env.GH_TOKEN = 'gh-tok';
    globalThis.fetch = async (url) => {
      assert.match(String(url), /\/repos\/org\/repo\/pulls\/9$/);
      return { ok: true, json: async () => ({ base: { ref: 'ops/development' } }) };
    };
    const base = await github.fetchPrBase('org/repo', 9);
    assert.equal(base, 'ops/development');
  } finally {
    if (prevToken.gh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevToken.gh;
    if (prevToken.ghAlt === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevToken.ghAlt;
    globalThis.fetch = prevFetch;
  }
});
