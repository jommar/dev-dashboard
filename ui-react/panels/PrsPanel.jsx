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
import { WorkFilters } from '../components/WorkFilters.jsx';
import { ReviewTicketCard } from '../components/ReviewTicketCard.jsx';
import { ClaudePlaceholderDialog } from '../components/ClaudePlaceholderDialog.jsx';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { useActivePolling } from '../hooks/useActivePolling.js';
import { useClaudeTickets } from '../hooks/useClaudeTickets.js';
import { hasCompletePrCoverage, reviewColumns } from '../../ui/review-board.js';
import { ticketPrefix } from '../../ui/work-filters.js';
import { PR_POLL_MS } from '../../ui/polling.js';

const NO_TICKETS = Object.freeze([]);
const LANE_HINTS = {
  'to-review':
    'No current approval or changes-request activity, no linked open PRs, or incomplete PR/review data. Evaluated across all linked open PRs in watched repositories; unknown data stays here.',
  reviewing:
    'PR/review data is complete and at least one linked open PR has an approval or standing changes request, but the ticket is not fully reviewed: another PR may await approval, a changes request may stand, or a draft may remain. Covers all linked open PRs in watched repositories; not live reviewer activity.',
  reviewed:
    'At least one linked open PR, and every linked open PR across watched repositories is currently approved by anyone, with complete PR/review data, no drafts and no standing changes requests.',
};

export function PrsPanel({ config, active }) {
  const api = useDashboardApi();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState('loading…');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [filters, setFilters] = useState({ search: '', prefix: '', repo: '', review: '' });
  const [openClaudeKey, setOpenClaudeKey] = useState(null);
  const boardRef = useRef(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const load = useCallback(
    async ({ silent = false } = {}) => {
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
    [api],
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
  const claude = useClaudeTickets({ active: active && Boolean(openClaudeTicket) });
  useEffect(() => {
    if (openClaudeKey && (!active || !openClaudeTicket)) setOpenClaudeKey(null);
  }, [active, openClaudeKey, openClaudeTicket]);
  const resolveOpener = useCallback((key) => {
    const panel = document.getElementById('panel-prs');
    if (!panel || panel.hidden) return null;
    return (
      boardRef.current?.querySelector(`[data-testid="prs-claude-icon-${CSS.escape(key)}"]`) ||
      panel.querySelector('[data-testid="prs-board"]') ||
      panel.querySelector('[data-testid="prs-refresh"]')
    );
  }, []);
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
                  onOpenClaude={setOpenClaudeKey}
                />
              </li>
            ))}
          </BoardColumn>
        ))}
      </Board>
    ),
    [columns, config.jiraBase, data?.prCoverage],
  );
  const coverageIncomplete = data && !hasCompletePrCoverage(data.prCoverage);
  return (
    <BoardPanel id="prs" active={active} busy={loading}>
      <BoardSection
        name="prs"
        title="Pull Requests"
        sub={
          <span title="Other-assigned Ready For Code Review tickets · open PRs from watched repositories only. Reviewing means approvals or changes requested, not live reviewer activity.">
            Ready For Code Review · watched repositories only
          </span>
        }
        meta={meta}
        controls={
          <RefreshControl name="prs" loading={loading} countdown={countdown} onRefresh={refresh} />
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
        ) : !rows.length ? (
          <BoardState testId="prs-empty">
            No tickets assigned to others in Ready For Code Review.
          </BoardState>
        ) : (
          <>
            {!shown && (
              <BoardState testId="prs-no-matches">
                No matches. Try changing or clearing filters.
              </BoardState>
            )}
            {board}
          </>
        )}
      </BoardSection>
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
    </BoardPanel>
  );
}
