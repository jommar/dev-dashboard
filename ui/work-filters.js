const contains = (values, search) =>
  !search ||
  values
    .filter((value) => value != null)
    .some((value) => String(value).toLowerCase().includes(search.toLowerCase()));

function rowMatches(row, search, context = []) {
  const sprints = row.sprints?.length ? row.sprints : [row.sprint];
  return contains(
    [
      row.title,
      row.summary,
      row.key,
      row.number,
      row.repo,
      row.owner,
      row.status,
      row.priority,
      row.issueType,
      ...sprints.map((sprint) => sprint?.name),
      ...context,
    ],
    search,
  );
}

export function filterTickets(rows = [], filters = {}) {
  return rows.filter(
    (row) =>
      rowMatches(row, filters.search) &&
      (!filters.status || row.status === filters.status) &&
      (!filters.priority || row.priority === filters.priority) &&
      (!filters.type || row.issueType === filters.type) &&
      (!filters.sprint ||
        (row.sprints?.length ? row.sprints : [row.sprint]).some(
          (sprint) => sprint && String(sprint.id ?? sprint.name) === filters.sprint,
        )),
  );
}

function reviewState(pr) {
  if (!pr.reviews || pr.reviews.available === false) return 'unknown';
  return ['approved', 'changes_requested'].includes(pr.reviews.state)
    ? pr.reviews.state
    : 'awaiting';
}

export function filterPrPayload(payload, filters = {}) {
  const data = payload || {};
  const result = { ...data };
  for (const [section, groupField, rowField, statuses, sprints] of [
    ['open', 'groups', 'prs', data.ticketStatuses, data.ticketSprints],
    ['draft', 'draftGroups', 'draftPrs', data.ticketStatuses, data.ticketSprints],
    [
      'approval',
      'approvalGroups',
      'prsNeedingApprovals',
      data.approvalTicketStatuses,
      data.approvalTicketSprints,
    ],
    ['uat', 'uatPromoteGroups', null],
  ]) {
    const selected = !filters.section || filters.section === section;
    const matches = (pr, context = []) =>
      selected &&
      (section !== 'open' || !pr.draft) &&
      (!filters.repo || pr.repo === filters.repo) &&
      (!filters.review || reviewState(pr) === filters.review) &&
      rowMatches(pr, filters.search, context);
    const groups = Object.entries(data[groupField] || {}).flatMap(([key, group]) => {
      const rows = section === 'uat' ? group.prs : group;
      const context = [
        key,
        statuses?.[key],
        sprints?.[key]?.name,
        group.ticket?.status,
        group.ticket?.sprint?.name,
      ];
      const kept = rows.filter((pr) => matches(pr, context));
      return kept.length ? [[key, section === 'uat' ? { ...group, prs: kept } : kept]] : [];
    });
    result[groupField] = Object.fromEntries(groups);
    if (rowField) {
      const grouped = new Set(
        groups.flatMap(([, rows]) => rows.map((pr) => `${pr.repo}#${pr.number}`)),
      );
      result[rowField] = (data[rowField] || []).filter(
        (pr) => matches(pr) || grouped.has(`${pr.repo}#${pr.number}`),
      );
    }
  }
  if (data.prsNeedingApproval) result.prsNeedingApproval = result.prsNeedingApprovals;
  return result;
}

export function filterActionTiers(tiers = [], filters = {}) {
  return tiers.map((tier) => ({
    ...tier,
    items: tier.items.filter(
      (row) =>
        (!filters.action || tier.id === filters.action) &&
        rowMatches(row, filters.search, tier.kind === 'pr' ? row.tickets || [] : []),
    ),
  }));
}

export function uniquePrs(payload) {
  const rows = [
    ...(payload?.prs || []),
    ...(payload?.draftPrs || []),
    ...(payload?.prsNeedingApprovals || []),
    ...Object.values(payload?.uatPromoteGroups || {}).flatMap((group) => group.prs),
  ];
  return [...new Map(rows.map((pr) => [`${pr.repo}#${pr.number}`, pr])).values()];
}

export function ticketFilterOptions(rows = [], sprints = []) {
  const values = (field) => [...new Set(rows.map((row) => row[field]).filter(Boolean))].sort();
  const sprintOptions = [
    ...sprints,
    ...rows.flatMap((row) => (row.sprints?.length ? row.sprints : [row.sprint])),
  ]
    .filter(Boolean)
    .map((sprint) => [
      String(sprint.id ?? sprint.name),
      `${sprint.name}${sprint.state ? ` · ${sprint.state}` : ''}`,
    ]);
  return {
    status: values('status'),
    priority: values('priority'),
    type: values('issueType'),
    sprint: sprintOptions,
  };
}
