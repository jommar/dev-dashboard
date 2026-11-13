import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Board,
  BoardColumn,
  BoardNote,
  BoardPanel,
  BoardSection,
  BoardState,
  RefreshControl,
} from '../components/BoardShell.jsx';
import { DashboardTooltip } from '../components/Primitives.jsx';
import { WorkFilters } from '../components/WorkFilters.jsx';
import { ReviewTicketCard } from '../components/ReviewTicketCard.jsx';
import { SpecReviewCard } from '../components/SpecReviewCard.jsx';
import { ClaudePlaceholderDialog } from '../components/ClaudePlaceholderDialog.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { useActivePolling } from '../hooks/useActivePolling.js';
import { useClaudeTickets } from '../hooks/useClaudeTickets.js';
import { useTicketSlackThreads } from '../hooks/useTicketSlackThreads.jsx';
import { hasCompletePrCoverage, reviewColumns, SPEC_REVIEW_LANE } from '../../ui/review-board.js';
import { ticketPrefix } from '../../ui/work-filters.js';
import { PR_POLL_MS } from '../../ui/polling.js';

const NO_TICKETS = Object.freeze([]);
const NO_SPECS = Object.freeze([]);
const SPEC_LIMIT = 1000;
const LANE_HINTS = {
  'to-review':
    'No current approval or changes-request activity, no linked open PRs, or incomplete PR/review data. Evaluated across all linked open PRs in watched repositories; unknown data stays here.',
  reviewing:
    'PR/review data is complete and at least one linked open PR has an approval or standing changes request, but the ticket is not fully reviewed: another PR may await approval, a changes request may stand, or a draft may remain. Covers all linked open PRs in watched repositories; not live reviewer activity.',
  reviewed:
    'At least one linked open PR, and every linked open PR across watched repositories is currently approved by anyone, with complete PR/review data, no drafts and no standing changes requests.',
  'spec-review':
    'Open ezat-specs PRs labelled spec whose title names a TAP or TRIPS ticket that has no open or merged code PR in Portage-backend, Portage-frontend or TravelTracker. Process specs with no ticket key are not listed.',
};

export function PrsPanel({ config, active }) {
  const api = useDashboardApi();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState('loading…');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [filters, setFilters] = useState({ search: '', prefix: '', repo: '', review: '' });
  const [openClaudeKey, setOpenClaudeKey] = useState(null);
  const [specs, setSpecs] = useState(NO_SPECS);
  const [specFailed, setSpecFailed] = useState(false);
  const [specLimit, setSpecLimit] = useState(3);
  const [specHasMore, setSpecHasMore] = useState(false);
  const [specBusy, setSpecBusy] = useState(false);
  // The spec whose dialog is open, held as the object it was opened with.
  const [openSpec, setOpenSpec] = useState(null);
  const boardRef = useRef(null);
  const resolveThreadOpener = useCallback((ts) => {
    const panel = document.getElementById('panel-prs');
    if (!panel || panel.hidden) return null;
    return (
      boardRef.current?.querySelector(`[data-testid="slack-thread-link-${CSS.escape(ts)}"]`) ||
      panel.querySelector('[data-testid="prs-board"]') ||
      panel.querySelector('[data-testid="prs-refresh"]')
    );
  }, []);
  const {
    loadSlack,
    openThread,
    linksByTicket,
    dialog: slackDialog,
  } = useTicketSlackThreads({
    source: 'prs',
    active,
    resolveOpener: resolveThreadOpener,
    includeMentions: true,
  });
  const dataRef = useRef(data);
  dataRef.current = data;
  const specRequest = useRef(0);
  const specInFlight = useRef(null);
  useEffect(() => {
    setSpecBusy(false);
    return () => {
      // Inactive/unmounted panels cannot accept an old reply or clear a newer request's guard.
      specRequest.current += 1;
      specInFlight.current?.abort();
      specInFlight.current = null;
    };
  }, [active]);
  // An unavailable or failed spec answer lists no spec and sets the lane's note; it never fails tickets.
  // Skip concurrent triggers; commit the expanded count only with a successful replacement feed.
  const loadSpecs = useCallback(
    async (limit = specLimit) => {
      if (!active || specInFlight.current) return;
      const id = ++specRequest.current;
      const controller = new AbortController();
      specInFlight.current = controller;
      setSpecBusy(true);
      try {
        const result = await api.getSpecReviews(limit, controller.signal);
        if (id !== specRequest.current) return;
        setSpecs(result.available ? result.specs : NO_SPECS);
        setSpecHasMore(Boolean(result.available && result.hasMore));
        setSpecFailed(
          result.available
            ? false
            : result.reason === 'search_limit'
              ? 'search_limit'
              : 'unavailable',
        );
        if (result.available) setSpecLimit(limit);
      } catch {
        if (id !== specRequest.current) return;
        setSpecs(NO_SPECS);
        setSpecHasMore(false);
        setSpecFailed('unavailable');
      } finally {
        if (id === specRequest.current) {
          specInFlight.current = null;
          setSpecBusy(false);
        }
      }
    },
    [active, api, specLimit],
  );
  const load = useCallback(
    async ({ silent = false } = {}) => {
      // Fired, never awaited: Slack is optional and slow, and its outage is not a failed refresh.
      loadSlack();
      // The spec lane settles on its own for the same reason.
      loadSpecs();
      setLoading(true);
      if (!silent) setMeta(dataRef.current ? 'Refreshing…' : 'loading…');
      try {
        const result = await api.getReviewTickets();
        setData(result);
        setMeta(
          `${result.total} tickets · updated ${new Date(result.updatedAt).toLocaleTimeString()}`,
        );
        setFailure('');
      } catch (error) {
        setFailure(`Failed to load review tickets: ${error.message}`);
        setMeta(dataRef.current ? 'Refresh failed — showing last update' : 'error');
      } finally {
        setLoading(false);
      }
    },
    [api, loadSlack, loadSpecs],
  );
  const { load: refresh, countdown } = useActivePolling({
    active,
    interval: PR_POLL_MS,
    load,
    loaded: !!data,
  });
  const rows = data?.tickets || NO_TICKETS;
  const columns = useMemo(
    () => reviewColumns(rows, data?.prCoverage, filters),
    [rows, data?.prCoverage, filters],
  );
  const shown = columns.reduce((total, column) => total + column.tickets.length, 0);
  // The spec lane is shown with the board, beside the ticket lanes or alone when no ticket is listed.
  const showBoard = rows.length > 0 || specs.length > 0 || specFailed;
  const options = useMemo(
    () => ({
      prefix: [...new Set(rows.map((ticket) => ticketPrefix(ticket.key)).filter(Boolean))].sort(),
      repo: [...new Set(rows.flatMap((ticket) => ticket.prs.map((pr) => pr.repo)))].sort(),
      review: [
        ['approved', 'Approved'],
        ['changes_requested', 'Changes requested'],
        ['awaiting', 'Awaiting review'],
        ['unknown', 'Unknown'],
      ],
    }),
    [rows],
  );
  const openClaudeTicket = openClaudeKey && rows.find((ticket) => ticket.key === openClaudeKey);
  const claude = useClaudeTickets({ active: active && Boolean(openClaudeTicket || openSpec) });
  useEffect(() => {
    if (openClaudeKey && (!active || !openClaudeTicket)) setOpenClaudeKey(null);
  }, [active, openClaudeKey, openClaudeTicket]);
  // A failed or unavailable answer says nothing about the spec, so its dialog stays open through it
  // (and any launch result with it). Only a successful answer that no longer lists it closes it.
  useEffect(() => {
    if (!openSpec) return;
    const listed = specs.some((spec) => spec.number === openSpec.number);
    if (!active || (!specFailed && !listed)) setOpenSpec(null);
  }, [active, openSpec, specs, specFailed]);
  // Where a dialog returns focus: the card's own action, else the board, else the refresh button.
  const findOpener = useCallback((testId) => {
    const panel = document.getElementById('panel-prs');
    if (!panel || panel.hidden) return null;
    return (
      boardRef.current?.querySelector(`[data-testid="${testId}"]`) ||
      panel.querySelector('[data-testid="prs-board"]') ||
      panel.querySelector('[data-testid="prs-refresh"]')
    );
  }, []);
  const resolveOpener = useCallback(
    (key) => findOpener(`prs-claude-icon-${CSS.escape(key)}`),
    [findOpener],
  );
  const board = useMemo(
    () => (
      <Board label="PR review board" testId="prs-board" frameRef={boardRef}>
        {columns.map((column) => (
          <BoardColumn
            key={column.id}
            id={column.id}
            label={column.label}
            hint={LANE_HINTS[column.id]}
            count={column.tickets.length}
            testIdPrefix="prs-column-"
          >
            {column.tickets.map((ticket) => (
              <li key={ticket.key}>
                <ReviewTicketCard
                  ticket={ticket}
                  jiraBase={config.jiraBase}
                  prCoverage={data?.prCoverage}
                  linksByTicket={linksByTicket}
                  onOpenThread={openThread}
                  onOpenClaude={setOpenClaudeKey}
                />
              </li>
            ))}
          </BoardColumn>
        ))}
        <BoardColumn
          id={SPEC_REVIEW_LANE.id}
          label={SPEC_REVIEW_LANE.label}
          hint={LANE_HINTS[SPEC_REVIEW_LANE.id]}
          count={specs.length}
          testIdPrefix="prs-column-"
        >
          {specs.map((spec) => (
            <li key={spec.number}>
              <SpecReviewCard spec={spec} jiraBase={config.jiraBase} onOpenClaude={setOpenSpec} />
            </li>
          ))}
          {specHasMore && (
            <li>
              {specLimit < SPEC_LIMIT ? (
                <button
                  type="button"
                  className="btn"
                  data-testid="prs-spec-load-more"
                  disabled={specBusy}
                  onClick={() => loadSpecs(Math.min(SPEC_LIMIT, specLimit + 3))}
                >
                  {specBusy ? 'Loading…' : 'Load more'}
                </button>
              ) : (
                <p className="review-ticket-warning" role="status">
                  GitHub search is limited to 1,000 matches. More specs cannot be loaded here.
                </p>
              )}
            </li>
          )}
        </BoardColumn>
      </Board>
    ),
    [
      columns,
      specs,
      specHasMore,
      specLimit,
      specBusy,
      loadSpecs,
      config.jiraBase,
      data?.prCoverage,
      linksByTicket,
      openThread,
    ],
  );
  const coverageIncomplete = data && !hasCompletePrCoverage(data.prCoverage);
  return (
    <BoardPanel id="prs" active={active} busy={loading || specBusy}>
      <BoardSection
        name="prs"
        title="Pull Requests"
        sub={
          <DashboardTooltip
            title="Other-assigned Ready For Code Review tickets · open PRs from watched repositories only. Reviewing means approvals or changes requested, not live reviewer activity."
            describeChild
          >
            <span>Ready For Code Review · watched repositories only</span>
          </DashboardTooltip>
        }
        meta={meta}
        controls={
          <RefreshControl
            name="prs"
            loading={loading || specBusy}
            countdown={countdown}
            onRefresh={refresh}
          />
        }
        filters={
          <WorkFilters
            id="prs-filter"
            view="prs"
            options={options}
            total={rows.length}
            shown={shown}
            onChange={setFilters}
            collapsible
          />
        }
        notes={
          <>
            {data && failure && (
              <BoardNote testId="prs-stale">
                {failure} Showing the last successful update{' '}
                {new Date(data.updatedAt).toLocaleTimeString()}; review progress may be stale.
              </BoardNote>
            )}
            {coverageIncomplete && (
              <BoardNote testId="prs-coverage">
                PR discovery unavailable or incomplete for watched repositories. Known PRs are
                shown; every ticket remains To Review until discovery completes.
              </BoardNote>
            )}
            {specFailed && (
              <BoardNote testId="prs-spec-error">
                {specFailed === 'search_limit'
                  ? 'Spec review lookup reached the GitHub search limit of 1,000 matches. No spec PRs are shown because the requested set or next page could not be established.'
                  : 'Spec review lookup unavailable or incomplete. No spec PRs are shown until it answers.'}
              </BoardNote>
            )}
          </>
        }
      >
        {!data ? (
          failure ? (
            <BoardState kind="error" testId="prs-error">
              {failure}
            </BoardState>
          ) : (
            <BoardState kind="loading" label="Loading review tickets…" testId="prs-loading" />
          )
        ) : (
          <>
            {!rows.length && (
              <BoardState testId="prs-empty">
                No tickets assigned to others in Ready For Code Review.
              </BoardState>
            )}
            {rows.length > 0 && !shown && (
              <BoardState testId="prs-no-matches">
                No matches. Try changing or clearing filters.
              </BoardState>
            )}
            {showBoard && board}
          </>
        )}
      </BoardSection>
      {slackDialog}
      {active && openClaudeTicket && (
        <ClaudePlaceholderDialog
          key={openClaudeTicket.key}
          ticketKey={openClaudeTicket.key}
          summary={openClaudeTicket.summary}
          entry={claude.byTicket[openClaudeTicket.key]}
          launch={claude.launch}
          rereview={claude.rereview}
          onClose={() => setOpenClaudeKey(null)}
          resolveOpener={resolveOpener}
        />
      )}
      {active && openSpec && (
        <ClaudePlaceholderDialog
          key={`spec-${openSpec.number}`}
          ticketKey={openSpec.keys[0]}
          summary={openSpec.title}
          specNumber={openSpec.number}
          review={openSpec.review}
          entry={claude.byTicket[openSpec.keys[0]]}
          launch={claude.launch}
          onClose={() => setOpenSpec(null)}
          resolveOpener={() => findOpener(`prs-spec-claude-icon-${openSpec.number}`)}
        />
      )}
    </BoardPanel>
  );
}
