// SprintPanel.jsx — the Sprint tab: one team's sprint for whoever owns it. Every ticket of the chosen
// sprint whoever has it, a summary whose attention counts are filter toggles, a Board and a Needs
// attention view, a Groom button per card (the ticket's Claude dialog), the Slack threads that name
// each ticket (the shared thread hook and dialog) and a capped, confirmed batch groom of the
// ungroomed tickets. It only reads Jira and Slack; grooming goes through the Claude launch.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Board,
  BoardColumn,
  BoardNote,
  BoardPanel,
  BoardSection,
  BoardState,
  BoardTabs,
  RefreshControl,
} from '../components/BoardShell.jsx';
import { Button } from '../components/Primitives.jsx';
import { SprintCard } from '../components/SprintCard.jsx';
import { SprintGroomDialog } from '../components/SprintGroomDialog.jsx';
import { ClaudeDialog, loadClaudeDialog } from '../lib/lazy-overlays.js';
import { useHarness } from '../lib/harness-context.js';
import { useActivePolling } from '../hooks/useActivePolling.js';
import { useClaudeTickets } from '../hooks/useClaudeTickets.js';
import { useDashboardApi } from '../hooks/useDashboardApi.js';
import { useTicketSlackThreads } from '../hooks/useTicketSlackThreads.jsx';
import { say } from '../../ui/harness.js';
import { slug } from '../../ui/dom.js';
import { boardColumns } from '../../ui/ticket-board.js';
import { normalizeTicketKey, ticketKeysOfRows } from '../../ui/slack-ticket-links.js';
import {
  ATTENTION_REASONS,
  CLAUDE_REASONS,
  GROOM_BATCH_MAX,
  attentionOrder,
  attentionReasons,
  groomCandidates,
  matchesReasons,
  sprintSummary,
} from '../../ui/sprint-attention.js';
import {
  SPRINT_BOARD_POLL_MS,
  finishedColumnsLast,
  pickSprint,
  pickTeam,
  readSprintChoice,
  settledChoice,
  sprintChoice,
  writeSprintChoice,
} from '../../ui/sprint-board.js';

const NO_TICKETS = Object.freeze([]);
const NO_REASONS = Object.freeze([]);
const NO_LINKS = Object.freeze([]);
const NO_GROOM_REASON = `Nothing to groom: every unstarted ticket is groomed, or ${GROOM_BATCH_MAX} grooms are running.`;
const CLAUDE_UNREAD_REASON = 'Waiting for the {name} session state.';

function SummaryStrip({ summary, selected, claudeLoaded, onToggle }) {
  return (
    <div className="sprint-board-summary" data-testid="sprint-summary">
      <span className="sprint-board-stat">{summary.count} tickets</span>
      <span className="sprint-board-stat">{summary.points} pt committed</span>
      <span className="sprint-board-stat">{summary.donePoints} pt done</span>
      <span className="sprint-board-toggles" role="group" aria-label="Filter by attention reason">
        {ATTENTION_REASONS.map(({ id, label }) => {
          // Unknown, so not pressable, until Claude's session state is read.
          const unknown = CLAUDE_REASONS.includes(id) && !claudeLoaded;
          return (
            <button
              key={id}
              type="button"
              className="sprint-board-toggle"
              aria-pressed={selected.includes(id)}
              aria-disabled={unknown || undefined}
              data-testid={`sprint-reason-${id}`}
              onClick={() => !unknown && onToggle(id)}
            >
              {label}
              <span className="sprint-board-toggle-count">
                {unknown ? '–' : (summary.reasons[id] ?? 0)}
              </span>
            </button>
          );
        })}
      </span>
    </div>
  );
}

export function SprintPanel({ config, active }) {
  const api = useDashboardApi();
  const harness = useHarness();
  const claude = useClaudeTickets({ active });
  const [choice, setChoice] = useState(readSprintChoice);
  const choiceRef = useRef(choice);
  const [teams, setTeams] = useState(null);
  const [teamsTruncated, setTeamsTruncated] = useState(false);
  const [data, setData] = useState(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const [meta, setMeta] = useState('loading…');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [view, setView] = useState('board');
  const [selected, setSelected] = useState(NO_REASONS);
  const [openClaudeKey, setOpenClaudeKey] = useState(null);
  const [claudeLoadFailed, setClaudeLoadFailed] = useState(false);
  const [groomBatch, setGroomBatch] = useState(null);
  const latest = useRef(0);
  const groomReasonId = useId();
  // Where focus goes when the thread dialog closes: the chip, in whichever view shows it.
  const resolveThreadOpener = useCallback((ts) => {
    const panel = document.getElementById('panel-sprint');
    if (!panel || panel.hidden) return null;
    return (
      panel.querySelector(`[data-testid="slack-thread-link-${CSS.escape(ts)}"]`) ||
      panel.querySelector('[data-testid="sprint-refresh"]')
    );
  }, []);
  // Mentions too: a sprint is mostly other people's tickets, whose threads someone else started.
  const slackKeys = useMemo(() => ticketKeysOfRows(data?.tickets), [data]);
  const {
    loadSlack,
    openThread,
    linksByTicket,
    dialog: slackDialog,
    snapshot: slackSnapshot,
    incomplete: slackIncomplete,
  } = useTicketSlackThreads({
    source: 'sprint',
    active,
    resolveOpener: resolveThreadOpener,
    includeMentions: true,
    ticketKeys: slackKeys,
  });

  // Reads the team list, then the chosen sprint's tickets. Only the newest read may change the
  // screen, so a switch made while an older read is out is never overwritten by its answer.
  const load = useCallback(
    async ({ silent = false } = {}) => {
      const request = ++latest.current;
      // Fired, never awaited: Slack is optional and slow, and its outage is not a failed refresh.
      loadSlack();
      setLoading(true);
      if (!silent) setMeta(dataRef.current ? 'Refreshing…' : 'loading…');
      try {
        const list = await api.getSprints();
        if (request !== latest.current) return;
        setTeams(list.teams);
        setTeamsTruncated(list.truncated === true);
        const team = pickTeam(list.teams, choiceRef.current.team);
        const settled = team ? settledChoice(team, choiceRef.current) : choiceRef.current;
        if (settled !== choiceRef.current) {
          choiceRef.current = settled;
          setChoice(settled);
          writeSprintChoice(settled);
        }
        const sprint = team ? pickSprint(team.sprints, choiceRef.current.sprint) : null;
        if (!sprint) {
          setData({ sprint: null, total: 0, truncated: false, tickets: NO_TICKETS });
          setFailure('');
          setRefreshFailed(false);
          setMeta('No sprints found');
          return;
        }
        const result = await api.getSprintTickets(sprint.id);
        if (request !== latest.current) return;
        setData(result);
        setFailure('');
        setRefreshFailed(false);
        setMeta(
          `${result.total} in ${sprint.name} · updated ${new Date(result.updatedAt).toLocaleTimeString()}`,
        );
      } catch (error) {
        if (request !== latest.current) return;
        if (!dataRef.current) {
          setMeta('error');
          setFailure(`Failed to load the sprint: ${error.message}`);
        } else {
          setRefreshFailed(true);
          setMeta('Refresh failed — showing last update');
        }
      } finally {
        if (request === latest.current) setLoading(false);
      }
    },
    [api, loadSlack],
  );
  const { load: refresh, countdown } = useActivePolling({
    active,
    interval: SPRINT_BOARD_POLL_MS,
    load,
    loaded: !!data,
  });

  const team = teams ? pickTeam(teams, choice.team) : null;
  const sprint = team ? pickSprint(team.sprints, choice.sprint) : null;
  const choose = (next) => {
    choiceRef.current = next;
    setChoice(next);
    writeSprintChoice(next);
    dataRef.current = null;
    setData(null);
    setFailure('');
    setRefreshFailed(false);
    setSelected(NO_REASONS);
    load();
  };
  // A team change follows that team's active sprint, so it pins no sprint id.
  const chooseTeam = (name) => choose({ team: name, sprint: null });

  const tickets = data?.tickets ?? NO_TICKETS;
  // Threads are keyed by the normalised key (TRIPS folds onto TAP).
  const slackLinksOf = useCallback(
    (key) => linksByTicket.get(normalizeTicketKey(key)) || NO_LINKS,
    [linksByTicket],
  );
  const reasonsByKey = useMemo(
    () =>
      Object.fromEntries(
        tickets.map((ticket) => [
          ticket.key,
          attentionReasons(ticket, claude.byTicket[ticket.key], {
            claudeLoaded: claude.loaded,
            slackLinks: slackLinksOf(ticket.key),
          }),
        ]),
      ),
    [tickets, claude.byTicket, claude.loaded, slackLinksOf],
  );
  const summary = useMemo(() => sprintSummary(tickets, reasonsByKey), [tickets, reasonsByKey]);
  const shown = useMemo(
    () => tickets.filter((ticket) => matchesReasons(reasonsByKey[ticket.key], selected)),
    [tickets, reasonsByKey, selected],
  );
  const flagged = useMemo(() => attentionOrder(tickets, reasonsByKey), [tickets, reasonsByKey]);
  const attention = useMemo(() => attentionOrder(shown, reasonsByKey), [shown, reasonsByKey]);
  const candidates = useMemo(
    () => groomCandidates(tickets, reasonsByKey, claude.byTicket),
    [tickets, reasonsByKey, claude.byTicket],
  );
  // No reason while the sprint is not read: an empty candidate list then says nothing about it.
  const groomReason = !data
    ? null
    : !claude.loaded
      ? say(CLAUDE_UNREAD_REASON, harness)
      : candidates.length === 0
        ? NO_GROOM_REASON
        : null;
  const toggleReason = useCallback(
    (id) =>
      setSelected((previous) =>
        previous.includes(id) ? previous.filter((each) => each !== id) : [...previous, id],
      ),
    [],
  );

  const closeClaude = useCallback(() => setOpenClaudeKey(null), []);
  // Load the dialog's code first, then open it. It opens only once loaded, so it needs no LazyDialog:
  // importing ScreenSlot from this lazy screen would split it out of the first-paint bundle.
  const openClaude = useCallback((key) => {
    setClaudeLoadFailed(false);
    loadClaudeDialog().then(
      () => setOpenClaudeKey(key),
      () => setClaudeLoadFailed(true),
    );
  }, []);
  const openClaudeTicket = openClaudeKey && tickets.find(({ key }) => key === openClaudeKey);
  const closeGroomBatch = useCallback(() => setGroomBatch(null), []);
  // A ticket that left the sprint takes its dialog with it, and so does leaving the tab: the panel
  // only goes hidden, and a modal left open in it would keep the rest of the page inert.
  useEffect(() => {
    if (openClaudeKey && (!active || !openClaudeTicket)) setOpenClaudeKey(null);
  }, [active, openClaudeKey, openClaudeTicket]);
  useEffect(() => {
    if (!active) setGroomBatch(null);
  }, [active]);

  const jiraBase = config?.jiraBase;
  const body = useMemo(() => {
    if (view === 'attention')
      return (
        <div className="board-pane">
          {attention.length === 0 ? (
            <BoardState testId="sprint-attention-empty">No ticket needs attention.</BoardState>
          ) : (
            <ul className="sprint-board-attention" data-testid="sprint-attention-list">
              {attention.map((ticket) => (
                <li key={ticket.key}>
                  <SprintCard
                    ticket={ticket}
                    jiraBase={jiraBase}
                    entry={claude.byTicket[ticket.key]}
                    reasons={reasonsByKey[ticket.key]}
                    slackLinks={slackLinksOf(ticket.key)}
                    onGroom={openClaude}
                    onOpenThread={openThread}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    if (shown.length === 0)
      return (
        <BoardState testId="sprint-no-matches">
          {tickets.length === 0 ? 'This sprint has no tickets.' : 'No ticket has these reasons.'}
        </BoardState>
      );
    return (
      <Board label="Sprint board" testId="sprint-board">
        {finishedColumnsLast(boardColumns(shown)).map((column) => (
          <BoardColumn
            key={column.status}
            id={slug(column.status)}
            label={column.status}
            count={column.tickets.length}
            testIdPrefix="sprint-column-"
            kind={column.kind}
          >
            {column.tickets.map((ticket) => (
              <li key={ticket.key}>
                <SprintCard
                  ticket={ticket}
                  jiraBase={jiraBase}
                  entry={claude.byTicket[ticket.key]}
                  reasons={reasonsByKey[ticket.key]}
                  slackLinks={slackLinksOf(ticket.key)}
                  onGroom={openClaude}
                  onOpenThread={openThread}
                />
              </li>
            ))}
          </BoardColumn>
        ))}
      </Board>
    );
  }, [
    view,
    attention,
    shown,
    tickets,
    jiraBase,
    claude.byTicket,
    reasonsByKey,
    openClaude,
    slackLinksOf,
    openThread,
  ]);

  return (
    <BoardPanel id="sprint" active={active} busy={loading}>
      <BoardSection
        name="sprint"
        title="Sprint"
        meta={meta}
        activeTab={view}
        controls={
          <>
            <label className="sprint-board-field">
              Team
              <select
                data-testid="sprint-team-select"
                value={team?.name ?? ''}
                disabled={!teams?.length}
                onChange={(event) => chooseTeam(event.target.value)}
              >
                {(teams ?? []).map(({ name }) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="sprint-board-field">
              Sprint
              <select
                data-testid="sprint-sprint-select"
                value={sprint ? String(sprint.id) : ''}
                disabled={!team}
                onChange={(event) => choose(sprintChoice(team, Number(event.target.value)))}
              >
                {(team?.sprints ?? []).map(({ id, name, state }) => (
                  <option key={id} value={String(id)}>
                    {state === 'active' ? name : `${name} (${state})`}
                  </option>
                ))}
              </select>
            </label>
            <Button
              className="sprint-board-groom-batch"
              data-testid="sprint-groom-batch"
              disabled={candidates.length === 0}
              aria-describedby={groomReason ? groomReasonId : undefined}
              onClick={() => setGroomBatch(tickets.filter(({ key }) => candidates.includes(key)))}
            >
              Groom ungroomed ({candidates.length})
            </Button>
            {groomReason && (
              <span id={groomReasonId} className="sprint-board-groom-reason">
                {groomReason}
              </span>
            )}
            <RefreshControl
              name="sprint"
              loading={loading}
              countdown={countdown}
              onRefresh={refresh}
            />
          </>
        }
        filters={
          <>
            <BoardTabs
              name="sprint"
              label="Sprint views"
              value={view}
              onChange={setView}
              tabs={[
                { id: 'board', label: 'Board', testId: 'sprint-view-board' },
                {
                  id: 'attention',
                  label: 'Needs attention',
                  count: flagged.length,
                  testId: 'sprint-view-attention',
                },
              ]}
            />
            {data && (
              <SummaryStrip
                summary={summary}
                selected={selected}
                claudeLoaded={claude.loaded}
                onToggle={toggleReason}
              />
            )}
          </>
        }
        notes={
          <>
            {claudeLoadFailed && (
              <BoardNote testId="sprint-claude-failed">
                {say('The {name} dialog could not load. Reload the page to try again.', harness)}
              </BoardNote>
            )}
            {refreshFailed && (
              <BoardNote testId="sprint-refresh-failed">
                The sprint could not refresh. Showing the last tickets read.
              </BoardNote>
            )}
            {(slackIncomplete || slackSnapshot?.continuation) && (
              <BoardNote testId="sprint-board-slack-coverage" defaultOpen>
                Slack thread results may be incomplete.{' '}
                <a href="#/slack">View Slack and load more</a>.
              </BoardNote>
            )}
            {data?.truncated && (
              <BoardNote testId="sprint-truncated">
                Not every ticket of this sprint was fetched, so the board and its totals may be
                incomplete.
              </BoardNote>
            )}
            {teamsTruncated && (
              <BoardNote testId="sprint-board-teams-truncated">
                Some teams or sprints may be missing from the pickers.
              </BoardNote>
            )}
          </>
        }
      >
        {!data ? (
          failure ? (
            <BoardState kind="error" testId="sprint-error">
              {failure}
            </BoardState>
          ) : (
            <BoardState kind="loading" label="Loading the sprint…" testId="sprint-loading" />
          )
        ) : (
          body
        )}
      </BoardSection>
      {slackDialog}
      {groomBatch && (
        <SprintGroomDialog tickets={groomBatch} launch={claude.launch} onClose={closeGroomBatch} />
      )}
      {openClaudeTicket && (
        <ClaudeDialog
          ticketKey={openClaudeTicket.key}
          summary={openClaudeTicket.summary}
          entry={claude.byTicket[openClaudeTicket.key]}
          onClose={closeClaude}
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
