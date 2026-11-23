import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Board,
  BoardColumn,
  BoardDivider,
  BoardNote,
  BoardPanel,
  BoardSection,
  BoardState,
  RefreshControl,
} from '../components/BoardShell.jsx';
import { Button } from '../components/Primitives.jsx';
import { ReleaseSummaryDialog, ReleaseTicketCard } from '../components/ReleaseCards.jsx';
import { UpstreamNote } from '../components/UpstreamNote.jsx';
import { ClaudeDialog, loadClaudeDialog } from '../lib/lazy-overlays.js';
import { useHarness } from '../lib/harness-context.js';
import { useClaudeTickets } from '../hooks/useClaudeTickets.js';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { useTicketSlackThreads } from '../hooks/useTicketSlackThreads.jsx';
import { slug } from '../../ui/dom.js';
import { say } from '../../ui/harness.js';
import { ticketKeysOfRows } from '../../ui/slack-ticket-links.js';
import { boardColumns } from '../../ui/ticket-board.js';
import {
  assigneeLabel,
  clearStoredSelection,
  finishedColumnsLast,
  plural,
  prMergedText,
  readStoredSelection,
  sortByAssignee,
  storeSelection,
  summarizeRelease,
} from '../../ui/releases-data.js';

const NO_TICKETS = [];
const MAX_SCRIPT_PRS = 200;
const NO_SCRIPTS = { state: 'idle', byTicket: {}, truncated: false };
const INSTANCE_MISMATCH_ADVICE =
  'PR lookup returned nothing for tickets Jira says have PRs — check the Jira GitHub integration. Refresh will not fix this.';

const clock = (ms = Date.now()) => new Date(ms).toLocaleTimeString();
const store = (() => {
  try {
    return localStorage;
  } catch {
    return null;
  }
})();

export function ReleasesPanel({ config, active, view = 'board', onViewChange }) {
  const api = useDashboardApi();
  const harness = useHarness();
  const claude = useClaudeTickets({ active });
  const [data, setData] = useState(null);
  const [scripts, setScripts] = useState(NO_SCRIPTS);
  const [version, setVersion] = useState(null);
  const [meta, setMeta] = useState('loading…');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [successAt, setSuccessAt] = useState(0);
  const [openClaudeKey, setOpenClaudeKey] = useState(null);
  const [claudeLoadFailed, setClaudeLoadFailed] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const ref = useRef({ id: 0, busy: false, restored: false, shownVersion: null });
  Object.assign(ref.current, { data, successAt, version });

  const resolveThreadOpener = useCallback((ts) => {
    const p = document.getElementById('panel-releases');
    return p && !p.hidden
      ? p.querySelector(`[data-testid="slack-thread-link-${CSS.escape(ts)}"]`) ||
          p.querySelector('[data-testid="releases-refresh"]')
      : null;
  }, []);

  const slackKeys = useMemo(() => ticketKeysOfRows(data?.tickets), [data]);
  const slack = useTicketSlackThreads({
    source: 'releases',
    active,
    resolveOpener: resolveThreadOpener,
    includeMentions: true,
    ticketKeys: slackKeys,
  });
  const { loadSlack } = slack;

  const load = useCallback(
    async ({ refresh = false, selectedVersion = ref.current.version } = {}) => {
      const current = ++ref.current.id;
      const stale = () => current !== ref.current.id;
      loadSlack();
      ref.current.busy = true;
      setBusy(true);
      setFailure(false);
      setMeta(ref.current.data ? (refresh ? 'Refreshing…' : 'Loading…') : 'loading…');
      try {
        const result = await api.getReleases({ version: selectedVersion, scope: 'all', refresh });
        if (stale()) return;
        const summary = summarizeRelease(result.tickets);
        const nextVersion = result.version?.id ?? null;
        ref.current.shownVersion = nextVersion;
        setData(result);
        setVersion(nextVersion);
        setMeta(
          `${plural(summary.tickets.total, 'ticket')} · ${prMergedText(summary.prs)} · updated ${clock()}`,
        );
        setSuccessAt(Date.now());
        const prs = result.tickets.flatMap((t) =>
          (t.prs ?? [])
            .filter(
              (p) => p.state !== 'declined' && p.repo && Number.isInteger(p.number) && p.number > 0,
            )
            .map(({ repo, number, state, updatedAt = null }) => ({
              ticket: t.key,
              repo,
              number,
              state,
              updatedAt,
            })),
        );
        const capped = prs.length > MAX_SCRIPT_PRS;
        const batch = capped ? prs.slice(0, MAX_SCRIPT_PRS) : prs;
        const setScr = (state, byTicket = NO_SCRIPTS.byTicket, truncated = false) =>
          setScripts({ state, byTicket, truncated });
        if (batch.length && api.getReleaseScripts) {
          setScr('loading');
          api.getReleaseScripts(batch).then(
            (res) =>
              !stale() &&
              (res?.available && res.byTicket
                ? setScr('loaded', res.byTicket, capped || Boolean(res.truncated))
                : setScr('unavailable')),
            () => !stale() && setScr('unavailable'),
          );
        } else {
          setScr('loaded');
        }
      } catch (error) {
        if (stale()) return;
        if (error.status === 400 && selectedVersion) {
          clearStoredSelection(store);
          setVersion(null);
          return load({ refresh, selectedVersion: null });
        }
        setFailure(true);
        if (ref.current.data) {
          setVersion(ref.current.shownVersion);
          setScripts((prev) =>
            prev.state === 'loading' ? { ...prev, state: 'unavailable' } : prev,
          );
          setMeta(`Refresh failed — showing last update ${clock(ref.current.successAt)}`);
        } else {
          setMeta('error');
        }
      } finally {
        if (!stale()) {
          ref.current.busy = false;
          setBusy(false);
        }
      }
    },
    [api, loadSlack],
  );

  const refresh = useCallback(() => {
    if (!ref.current.busy) load({ refresh: true });
  }, [load]);

  useEffect(() => {
    if (active && !ref.current.restored) {
      ref.current.restored = true;
      const saved = readStoredSelection(store);
      ref.current.version = saved;
      setVersion(saved);
      load({ selectedVersion: saved });
    }
  }, [active, load]);

  const versionChange = (event) => {
    const next = event.target.value;
    storeSelection(store, next);
    ref.current.version = next;
    setVersion(next);
    load({ selectedVersion: next });
  };

  const openClaude = (key) => {
    setClaudeLoadFailed(false);
    loadClaudeDialog().then(
      () => setOpenClaudeKey(key),
      () => setClaudeLoadFailed(true),
    );
  };

  const closeSummary = () => {
    setSummaryOpen(false);
    if (view === 'text') onViewChange?.('board');
  };

  const tickets = data?.tickets ?? NO_TICKETS;
  const openClaudeTicket = openClaudeKey && tickets.find(({ key }) => key === openClaudeKey);
  useEffect(() => {
    if (!active) setSummaryOpen(false);
    if (openClaudeKey && (!active || !openClaudeTicket)) setOpenClaudeKey(null);
  }, [active, openClaudeKey, openClaudeTicket]);

  const columns = data ? finishedColumnsLast(boardColumns(tickets)) : [];
  const unavail = tickets.filter((t) => t.prsStatus === 'unavailable');
  const unavailable = !unavail.length
    ? ''
    : unavail.some((t) => t.prsError === 'instance-mismatch')
      ? INSTANCE_MISMATCH_ADVICE
      : `${plural(unavail.length, 'ticket')} with PRs unavailable — Jira could not return their linked PRs. Use Refresh to retry.`;

  const jiraBase = config?.jiraBase;
  const body = !data ? (
    <BoardState
      kind={failure ? 'error' : 'loading'}
      label={failure ? undefined : 'Loading release…'}
      testId={failure ? 'releases-error' : 'releases-loading'}
    >
      {failure ? 'Could not load this release. Use Refresh to try again.' : null}
    </BoardState>
  ) : !tickets.length ? (
    <BoardState testId="releases-empty">No tickets in this release.</BoardState>
  ) : (
    <Board label="Releases board" testId="releases-board">
      {columns.map((column) => {
        const colId = slug(column.status.toLowerCase());
        const ordered = sortByAssignee(column.tickets);
        return (
          <BoardColumn
            key={column.status}
            id={colId}
            label={column.status}
            count={ordered.length}
            testIdPrefix="releases-column-"
            kind={column.kind}
            copyKeys={ordered.map((ticket) => ticket.key)}
          >
            {ordered.flatMap((ticket, index) => {
              const who = assigneeLabel(ticket);
              const prev = index > 0 ? assigneeLabel(ordered[index - 1]) : null;
              const row = (
                <li key={ticket.key}>
                  <ReleaseTicketCard
                    ticket={ticket}
                    jiraBase={jiraBase}
                    scripts={scripts.byTicket[ticket.key]}
                    slack={slack}
                    claude={claude}
                    onOpenClaude={openClaude}
                  />
                </li>
              );
              if (who === prev) return [row];
              return [
                <BoardDivider
                  key={`who:${who}`}
                  label={who}
                  testId={`releases-assignee-${colId}-${slug(who.toLowerCase())}`}
                />,
                row,
              ];
            })}
          </BoardColumn>
        );
      })}
    </Board>
  );

  return (
    <BoardPanel id="releases" active={active} busy={busy}>
      <BoardSection
        name="releases"
        title="Releases"
        meta={meta}
        controls={
          <>
            <select
              className="releases-ver"
              data-testid="releases-version"
              aria-label="Fix version"
              disabled={!data?.versions.length}
              value={version || ''}
              onChange={versionChange}
            >
              {!data && <option value="">Loading versions…</option>}
              {['Unreleased', 'Released'].map((label, i) => {
                const items = data?.versions.filter((item) => !item.released === !i);
                return items?.length ? (
                  <optgroup key={label} label={label}>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
            <Button
              data-testid="releases-summary-open"
              disabled={!data}
              onClick={() => setSummaryOpen(true)}
            >
              Summary
            </Button>
            <RefreshControl name="releases" loading={busy} onRefresh={refresh} />
          </>
        }
        notes={
          <>
            <UpstreamNote
              integrations={['jira', 'github', 'slack']}
              active={active}
              refreshKey={successAt}
            />
            {claudeLoadFailed && (
              <BoardNote testId="releases-claude-failed">
                {say('The {name} dialog could not load. Reload the page to try again.', harness)}
              </BoardNote>
            )}
            {(slack.incomplete || slack.snapshot?.continuation) && (
              <BoardNote testId="releases-slack-coverage" defaultOpen>
                Slack thread results may be incomplete.{' '}
                <a href="#/slack">View Slack and load more</a>.
              </BoardNote>
            )}
            {unavailable && <BoardNote testId="releases-unavailable">{unavailable}</BoardNote>}
            {data?.truncated && (
              <BoardNote testId="releases-truncated">
                Only the first {data.total} tickets are shown — totals may be incomplete.
              </BoardNote>
            )}
          </>
        }
      >
        {body}
      </BoardSection>
      {slack.dialog}
      {active && data && (summaryOpen || view === 'text') && (
        <ReleaseSummaryDialog
          data={data}
          columns={columns}
          jiraBase={jiraBase}
          scripts={scripts}
          onClose={closeSummary}
        />
      )}
      {openClaudeTicket && (
        <ClaudeDialog
          ticketKey={openClaudeTicket.key}
          summary={openClaudeTicket.summary}
          entry={claude.byTicket[openClaudeTicket.key]}
          onClose={() => setOpenClaudeKey(null)}
          launch={claude.launch}
          answer={claude.answer}
          approve={claude.approve}
          continueSession={claude.continueSession}
          sessionIds={claude.sessionIds[openClaudeTicket.key]}
        />
      )}
    </BoardPanel>
  );
}
