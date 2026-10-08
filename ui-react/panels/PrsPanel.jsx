import { useCallback, useMemo, useRef, useState } from 'react';
import { Button, Card, LoadingState } from '../components/Primitives.jsx';
import { WorkFilters } from '../components/WorkFilters.jsx';
import { PrActions } from '../components/PrActions.jsx';
import { TicketPrCard } from '../components/PrCard.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { useActivePolling } from '../hooks/useActivePolling.js';
import { filterPrPayload, uniquePrs } from '../../ui/work-filters.js';
import { PR_POLL_MS } from '../../ui/polling.js';

export function PrsPanel({ config, active }) {
  const api = useDashboardApi();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState('loading…');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [filters, setFilters] = useState({ search: '', section: '', repo: '', review: '' });
  const dataRef = useRef(data);
  dataRef.current = data;
  const load = useCallback(
    async ({ silent = false } = {}) => {
      setLoading(true);
      if (!silent) setMeta(dataRef.current ? 'Refreshing…' : 'loading…');
      try {
        const result = await api.getPrs();
        if (result === null) {
          setMeta(
            dataRef.current
              ? 'GitHub not configured — showing last update'
              : 'GitHub not configured',
          );
          return;
        }
        setData(result);
        setMeta(
          result.prsAvailable === false
            ? 'GitHub is unavailable'
            : `${(result.prs || []).filter((pr) => !pr.draft).length} open for ${result.login} (of ${result.total}) · updated ${new Date().toLocaleTimeString()}`,
        );
        setFailure('');
      } catch (error) {
        if (!dataRef.current) {
          setMeta('error');
          setFailure(`Failed to load PRs: ${error.message}`);
        } else setMeta(`Refresh failed — showing last update ${new Date().toLocaleTimeString()}`);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );
  const { countdown } = useActivePolling({ active, interval: PR_POLL_MS, load, loaded: !!data });
  const filtered = useMemo(() => filterPrPayload(data || {}, filters), [data, filters]);
  const all = uniquePrs(data || {});
  const shown = uniquePrs(filtered).length;
  const options = {
    section: [
      ['open', 'Open PRs'],
      ['draft', 'Draft PRs'],
      ['approval', 'Needs approval'],
      ['uat', 'Merge candidates'],
    ],
    repo: [...new Set(all.map((pr) => pr.repo))].sort(),
    review: [
      ['approved', 'Approved'],
      ['changes_requested', 'Changes requested'],
      ['awaiting', 'Awaiting review'],
      ['unknown', 'Unknown'],
    ],
  };
  const uatData = {
    ...filtered,
    uatPromoteTotal: Object.values(filtered.uatPromoteGroups || {}).reduce(
      (sum, group) => sum + group.prs.length,
      0,
    ),
  };
  const ticketCards = (groups, statuses, sprints, variant, options = {}) =>
    Object.entries(groups || {}).map(([ticket, prs]) => (
      <TicketPrCard
        key={ticket}
        ticket={ticket}
        prs={prs}
        jiraBase={config.jiraBase}
        ticketStatus={statuses?.[ticket]}
        sprint={sprints?.[ticket]}
        variant={variant}
        {...options}
      />
    ));
  const openGroups = Object.entries(filtered.groups || {})
    .map(([ticket, prs]) => [ticket, prs.filter((pr) => !pr.draft)])
    .filter(([, prs]) => prs.length);
  const draftCount = (filtered.draftPrs || []).length;
  const approvalThreshold = Number.isFinite(Number(filtered.approvalThreshold))
    ? Number(filtered.approvalThreshold)
    : 1;
  const approvalCount = (filtered.prsNeedingApprovals || filtered.prsNeedingApproval || []).length;
  const uatCount = Number.isFinite(Number(uatData.uatPromoteTotal))
    ? Number(uatData.uatPromoteTotal)
    : 0;
  return (
    <section
      id="panel-prs"
      className="panel"
      data-testid="panel-prs"
      hidden={!active}
      aria-busy={loading}
    >
      <header className="page-intro">
        <p className="eyebrow">Review & delivery</p>
        <h2>Pull Requests</h2>
        <p>Your open changes and teammate PRs awaiting approval.</p>
      </header>
      <WorkFilters
        id="prs-filter"
        view="prs"
        options={options}
        total={all.length}
        shown={shown}
        onChange={setFilters}
      />
      <p
        className="pr-empty"
        data-testid="prs-no-matches"
        hidden={!data || shown > 0 || all.length === 0}
      >
        No matches. Try changing or clearing filters.
      </p>
      <PrActions>
        <section className="pr-open-section" data-testid="pr-open-section">
          <h3 className="pr-section-heading" data-testid="open-prs-title">
            <span className="section-label">Your open PRs</span>
            <span className="pr-open-count" data-testid="prs-meta" role="status">
              {meta}
            </span>
            <Button data-testid="prs-refresh" disabled={loading} onClick={() => load()}>
              Refresh
            </Button>
            <span className="pr-next" data-testid="prs-next">
              {countdown}
            </span>
          </h3>
          <div id="prs-list" className="pr-open-groups" data-testid="prs-list">
            {!data ? (
              <LoadingState label="Loading pull requests…" testId="prs-loading" />
            ) : failure ? (
              <div className="pr-error" data-testid="prs-error">
                {failure}
              </div>
            ) : filtered.prsAvailable === false ? (
              <div className="pr-error" data-testid="prs-unavailable">
                GitHub is unavailable. Refresh to try again.
              </div>
            ) : openGroups.length ? (
              openGroups.map(([ticket, prs]) => (
                <TicketPrCard
                  key={ticket}
                  ticket={ticket}
                  prs={prs}
                  ticketStatus={filtered.ticketStatuses?.[ticket]}
                  sprint={filtered.ticketSprints?.[ticket]}
                  jiraBase={config.jiraBase}
                />
              ))
            ) : (
              <div className="pr-empty">No open PRs.</div>
            )}
          </div>
        </section>
        {data ? (
          <>
            <Card className="pr-section-card">
              <div data-testid="pr-draft-container">
                <section className="pr-draft-section" data-testid="pr-draft-section">
                  <h3 className="pr-section-heading">
                    Your draft PRs
                    <span className="pr-approval-count-total" data-testid="pr-draft-count">
                      {draftCount}
                    </span>
                  </h3>
                  {filtered.prsAvailable === false ? (
                    <div className="pr-error">GitHub is unavailable. Refresh to try again.</div>
                  ) : !draftCount ? (
                    <div className="pr-empty">No draft PRs.</div>
                  ) : (
                    <div className="pr-draft-groups">
                      {ticketCards(
                        filtered.draftGroups,
                        filtered.ticketStatuses,
                        filtered.ticketSprints,
                        'pr-draft',
                      )}
                    </div>
                  )}
                </section>
              </div>
            </Card>
            <Card className="pr-section-card">
              <div data-testid="pr-approval-container">
                <section className="pr-approval-section" data-testid="pr-approval-section">
                  <h3 className="pr-section-heading" data-testid="pr-approval-heading">
                    Open PRs needing approval ({approvalThreshold} required)
                    <span className="pr-approval-count-total" data-testid="pr-approval-count">
                      {approvalCount}
                    </span>
                  </h3>
                  {(filtered.approvalDataAvailable ?? filtered.reviewDataAvailable) === false ||
                  (filtered.approvalDataAvailable ?? filtered.reviewDataAvailable) === undefined ? (
                    <div className="pr-approval-unavailable" data-testid="pr-approval-unavailable">
                      Review data unavailable.
                    </div>
                  ) : !approvalCount ? (
                    <div className="pr-approval-empty" data-testid="pr-approval-empty">
                      No open PRs below the approval threshold.
                    </div>
                  ) : (
                    <div className="pr-approval-groups">
                      {ticketCards(
                        filtered.approvalGroups,
                        filtered.approvalTicketStatuses,
                        filtered.approvalTicketSprints,
                        'pr-approval',
                        { required: approvalThreshold },
                      )}
                    </div>
                  )}
                </section>
              </div>
            </Card>
            <Card className="pr-section-card">
              <div data-testid="pr-uat-promote-container">
                <section className="pr-approval-section" data-testid="pr-uat-promote-section">
                  <h3 className="pr-section-heading" data-testid="pr-uat-promote-heading">
                    PR merge candidates to ops/development
                    <span className="pr-approval-count-total" data-testid="pr-uat-promote-count">
                      {uatCount}
                    </span>
                  </h3>
                  {uatData.uatPromoteAvailable === false ||
                  uatData.uatPromoteAvailable === undefined ? (
                    <div
                      className="pr-approval-unavailable"
                      data-testid="pr-uat-promote-unavailable"
                    >
                      Promote-to-UAT data unavailable.
                    </div>
                  ) : !uatCount ? (
                    <div className="pr-approval-empty" data-testid="pr-uat-promote-empty">
                      No PRs ready to merge to ops/development.
                    </div>
                  ) : (
                    <div className="pr-approval-groups">
                      {Object.entries(uatData.uatPromoteGroups || {}).map(([ticket, group]) => (
                        <TicketPrCard
                          key={ticket}
                          ticket={ticket}
                          prs={group.prs}
                          ticketStatus={group.ticket?.status}
                          sprint={group.ticket?.sprint}
                          jiraBase={config.jiraBase}
                          variant="pr-uat-promote"
                        />
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </Card>
          </>
        ) : (
          <>
            <div data-testid="pr-draft-container">
              <LoadingState label="Loading drafts…" testId="pr-draft-loading" />
            </div>
            <div data-testid="pr-approval-container">
              <LoadingState label="Loading approvals…" testId="pr-approval-loading" />
            </div>
            <div data-testid="pr-uat-promote-container">
              <LoadingState label="Loading merge candidates…" testId="pr-uat-promote-loading" />
            </div>
          </>
        )}
      </PrActions>
    </section>
  );
}
