import { groupByTicket, filterPrsByTicketStatus } from './github.mjs';
import { CODE_REVIEW_STATUS, READY_FOR_CODE_REVIEW_STATUS } from './jira.mjs';
import { filterPrsNeedingApprovals } from './review.mjs';

export async function fetchPrDashboard(options, api) {
  const { snapshot } = options;
  const uatPromise = api.fetchUatPromoteCandidates(options);
  const approvalPromise = api.fetchOpenPRs({ ...options, mine: false }).catch(() => null);
  let data,
    prsAvailable = true;
  try {
    data = await api.fetchOpenPRs(options);
  } catch {
    prsAvailable = false;
    data = { prs: [], groups: {} };
  }
  const approvalData = await approvalPromise;
  const draftPrs = data.prs
    .filter((pr) => pr.draft)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const draftGroups = groupByTicket(draftPrs);
  const keys = Object.keys(data.groups).filter((key) => key !== 'Unticketed');
  const { statuses: ticketStatuses, sprints: ticketSprints } = await api.fetchTicketMetadata(
    keys,
    options,
  );
  data.prs = filterPrsByTicketStatus(data.prs, ticketStatuses, CODE_REVIEW_STATUS);
  data.groups = groupByTicket(data.prs);
  const approvalKeys = approvalData
    ? Object.keys(approvalData.groups).filter((key) => key !== 'Unticketed')
    : [];
  const { statuses: approvalStatuses, sprints: approvalTicketSprints } =
    await api.fetchTicketMetadata(approvalKeys, options);
  const [approvalReviewData, reviewData, uatData] = await Promise.all([
    approvalData ? api.enrichOpenPRs(approvalData.prs, options) : { available: false, reviews: {} },
    prsAvailable ? api.enrichOpenPRs(data.prs, options) : { available: false, reviews: {} },
    uatPromise,
  ]);
  for (const pr of data.prs) pr.reviews = reviewData.reviews[`${pr.repo}#${pr.number}`] || null;
  const approvalThreshold = snapshot.minPrApprover;
  const prsNeedingApprovals = approvalReviewData.available
    ? filterPrsByTicketStatus(
        filterPrsNeedingApprovals(approvalData.prs, approvalThreshold),
        approvalStatuses,
        READY_FOR_CODE_REVIEW_STATUS,
      )
    : [];
  return {
    ...data,
    total: data.prs.length,
    prsAvailable,
    draftPrs,
    draftGroups,
    ticketStatuses,
    ticketSprints,
    approvalThreshold,
    reviewDataAvailable: approvalReviewData.available,
    prsNeedingApprovals,
    approvalGroups: approvalReviewData.available ? groupByTicket(prsNeedingApprovals) : {},
    approvalTicketStatuses: approvalStatuses,
    approvalTicketSprints,
    uatPromoteAvailable: uatData.available,
    uatPromoteGroups: uatData.groups,
    uatPromoteTotal: uatData.total,
  };
}
