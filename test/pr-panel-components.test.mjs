// pr-panel-components.test.mjs — the three PR sections used to live as one
// inline template string and two local functions inside pr-panel.js, with two
// different heading markup shapes (div vs h3). Now each is its own component
// module sharing one heading class; the states (populated / empty /
// unavailable) and the shared heading markup are pinned here per module,
// independent of pr-panel.js's DOM-diffing/polling wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prOpenSectionShellHtml, prOpenListHtml } from '../ui/components/pr-open-section.js';
import { prApprovalSectionHtml } from '../ui/components/pr-approval-section.js';
import { prUatPromoteSectionHtml } from '../ui/components/pr-uat-promote-section.js';

const JIRA_BASE = 'https://jira.example.invalid/browse/';

const pr = (number, tickets) => ({
  number,
  repo: 'org/repo',
  title: `pr ${number}`,
  owner: 'dev',
  url: `https://github.com/org/repo/pull/${number}`,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-02T00:00:00Z',
  draft: false,
  labels: [],
  tickets,
});

// ── Item 3: shared heading markup ───────────────────────────────────────

test('the "Your open PRs" shell heading uses the shared heading markup', () => {
  const html = prOpenSectionShellHtml();
  assert.match(html, /<h3[^>]*class="pr-section-heading"/);
});

test('the "needing approval" section heading uses the shared heading markup', () => {
  const data = {
    approvalThreshold: 1,
    reviewDataAvailable: true,
    prsNeedingApprovals: [pr(1, ['ABC-1'])],
    approvalGroups: { 'ABC-1': [pr(1, ['ABC-1'])] },
    approvalTicketStatuses: {},
  };
  const html = prApprovalSectionHtml(data, JIRA_BASE);
  assert.match(html, /<h3[^>]*class="pr-section-heading"/);
});

test('the "merge candidates" section heading uses the shared heading markup', () => {
  const data = {
    uatPromoteAvailable: true,
    uatPromoteTotal: 1,
    uatPromoteGroups: {
      'ABC-2': { prs: [pr(2, ['ABC-2'])], ticket: { status: 'Promote to UAT' } },
    },
  };
  const html = prUatPromoteSectionHtml(data, JIRA_BASE);
  assert.match(html, /<h3[^>]*class="pr-section-heading"/);
});

// ── Item 4: prOpenListHtml ───────────────────────────────────────────────

test('prOpenListHtml renders ticket-card markup for a ticketed group and Unticketed', () => {
  const ticketed = pr(10, ['ABC-3']);
  const unticketed = pr(11, []);
  const data = {
    prs: [ticketed, unticketed],
    groups: { 'ABC-3': [ticketed], Unticketed: [unticketed] },
    ticketStatuses: {},
    prsAvailable: true,
  };
  const html = prOpenListHtml(data, JIRA_BASE);
  assert.match(html, /data-testid="pr-open-ticket-ABC-3"/);
  assert.match(html, /data-testid="pr-open-ticket-Unticketed"/);
});

test('prOpenListHtml renders the empty state when there are no PRs', () => {
  const data = { prs: [], groups: {}, ticketStatuses: {}, prsAvailable: true };
  const html = prOpenListHtml(data, JIRA_BASE);
  assert.match(html, /class="pr-empty"/);
});

test('prOpenListHtml renders the unavailable state when GitHub data is unavailable', () => {
  const data = { prs: [], groups: {}, ticketStatuses: {}, prsAvailable: false };
  const html = prOpenListHtml(data, JIRA_BASE);
  assert.match(html, /data-testid="prs-unavailable"/);
});

// ── Item 5: prApprovalSectionHtml ────────────────────────────────────────

test('prApprovalSectionHtml renders the unavailable state when review data is unavailable', () => {
  const data = {
    approvalThreshold: 1,
    reviewDataAvailable: false,
    prsNeedingApprovals: [],
    approvalGroups: {},
    approvalTicketStatuses: {},
  };
  const html = prApprovalSectionHtml(data, JIRA_BASE);
  assert.match(html, /data-testid="pr-approval-unavailable"/);
});

test('prApprovalSectionHtml renders the empty state when no PR needs approval', () => {
  const data = {
    approvalThreshold: 1,
    reviewDataAvailable: true,
    prsNeedingApprovals: [],
    approvalGroups: {},
    approvalTicketStatuses: {},
  };
  const html = prApprovalSectionHtml(data, JIRA_BASE);
  assert.match(html, /data-testid="pr-approval-empty"/);
});

test('prApprovalSectionHtml renders ticket cards when PRs need approval', () => {
  const needing = pr(20, ['ABC-4']);
  const data = {
    approvalThreshold: 1,
    reviewDataAvailable: true,
    prsNeedingApprovals: [needing],
    approvalGroups: { 'ABC-4': [needing] },
    approvalTicketStatuses: {},
  };
  const html = prApprovalSectionHtml(data, JIRA_BASE);
  assert.match(html, /data-testid="pr-approval-ticket-ABC-4"/);
});

// ── Item 6: prUatPromoteSectionHtml ──────────────────────────────────────

test('prUatPromoteSectionHtml renders the unavailable state when Promote-to-UAT data is unavailable', () => {
  const data = { uatPromoteAvailable: false, uatPromoteGroups: {}, uatPromoteTotal: 0 };
  const html = prUatPromoteSectionHtml(data, JIRA_BASE);
  assert.match(html, /data-testid="pr-uat-promote-unavailable"/);
});

test('prUatPromoteSectionHtml renders the empty state when no PR is ready to merge', () => {
  const data = { uatPromoteAvailable: true, uatPromoteGroups: {}, uatPromoteTotal: 0 };
  const html = prUatPromoteSectionHtml(data, JIRA_BASE);
  assert.match(html, /data-testid="pr-uat-promote-empty"/);
});

test('prUatPromoteSectionHtml renders ticket cards when PRs are ready to merge', () => {
  const candidate = pr(30, ['ABC-5']);
  const data = {
    uatPromoteAvailable: true,
    uatPromoteTotal: 1,
    uatPromoteGroups: { 'ABC-5': { prs: [candidate], ticket: { status: 'Promote to UAT' } } },
  };
  const html = prUatPromoteSectionHtml(data, JIRA_BASE);
  assert.match(html, /data-testid="pr-uat-promote-ticket-ABC-5"/);
});
