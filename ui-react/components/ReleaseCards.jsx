import { useEffect, useId, useState } from 'react';
import { copyText } from '../../ui/dom.js';
import { jiraStatusKind } from '../../ui/jira-status.js';
import {
  SCRIPT_KIND_LABELS,
  formatReleaseText,
  formatScriptTarget,
  plural,
  prMergedText,
  prRollupLabel,
  shortRepoName,
  summarizeRelease,
} from '../../ui/releases-data.js';
import { useBackdropClose, useModalDialog } from '../hooks/useModalDialog.js';
import { Button, DashboardTooltip } from './Primitives.jsx';
import { TicketLaunchers } from './TicketLaunchers.jsx';

const SAFE_LINK = /^https:\/\//i;
const SCRIPT_KINDS = Object.entries(SCRIPT_KIND_LABELS);
const EXT = { target: '_blank', rel: 'noopener noreferrer' };
const jiraKey = (id, base, testId) => (
  <a className="jira-link releases-key" href={`${base || ''}${id}`} {...EXT} data-testid={testId}>
    {id}
  </a>
);

export function ReleaseTicketCard({ ticket, jiraBase, scripts, slack, claude, onOpenClaude }) {
  const [prsOpen, setPrsOpen] = useState(false);
  const prsListId = useId();
  const { key } = ticket;
  const tid = (part) => `releases-ticket-${part}-${key}`;
  const groups = SCRIPT_KINDS.map(([kind, label]) => [
    kind,
    label,
    (scripts ?? []).filter((item) => item.kind === kind),
  ]).filter(([, , items]) => items.length);
  const prUnavailable = ticket.prsStatus === 'unavailable';

  return (
    <article
      className="board-card releases-card"
      data-jira-status-kind={jiraStatusKind(ticket.status)}
      data-merge-state={ticket.mergeState}
      data-testid={`releases-card-${key}`}
    >
      <div className="board-card-top">
        {jiraKey(key, jiraBase, tid('link'))}
        {ticket.assignee && <span className="board-card-stat releases-who">{ticket.assignee}</span>}
      </div>
      <TicketLaunchers
        ticketKey={key}
        testId={tid('links')}
        linksByTicket={slack.linksByTicket}
        onOpenThread={slack.openThread}
        claudeByTicket={claude.byTicket}
        onOpenClaude={onOpenClaude}
      />
      <DashboardTooltip title={ticket.summary} describeChild>
        <p className="board-card-summary">{ticket.summary || ''}</p>
      </DashboardTooltip>
      {groups.length > 0 && (
        <div className="releases-row" data-testid={tid('scripts')}>
          {groups.map(([kind, label, items]) => (
            <DashboardTooltip
              key={kind}
              title={items.map(formatScriptTarget).join('\n')}
              describeChild
            >
              <span className="board-chip releases-badge" data-script-kind={kind}>
                {items.length > 1 ? `${label} (${items.length})` : label}
              </span>
            </DashboardTooltip>
          ))}
        </div>
      )}
      {prUnavailable || !ticket.prs.length ? (
        <div
          className="releases-note"
          data-state={prUnavailable ? 'unavailable' : undefined}
          data-error={ticket.prsError || undefined}
          data-testid={tid('note')}
        >
          {prUnavailable
            ? `PRs unavailable${ticket.prsError ? ` (${ticket.prsError})` : ''}`
            : 'No PRs'}
        </div>
      ) : (
        <div className="releases-prs">
          <button
            type="button"
            className="releases-toggle"
            aria-expanded={prsOpen}
            aria-controls={prsListId}
            data-testid={tid('prs-toggle')}
            onClick={() => setPrsOpen(!prsOpen)}
          >
            <span aria-hidden="true">{prsOpen ? '▾' : '▸'}</span>
            <span>{prRollupLabel(ticket.prs)}</span>
          </button>
          {prsOpen && (
            <ul id={prsListId} data-testid={tid('prs')}>
              {ticket.prs.map((pr) => {
                const id = `${pr.repo}-${pr.number}`;
                const prTid = (p) => `release-pr-${p}${id}`;
                const label = `${shortRepoName(pr.repo)} #${pr.number}`;
                const st = pr.state || 'unknown';
                const safe = SAFE_LINK.test(pr.url || '');
                return (
                  <li key={id} className="releases-pr" data-pr-state={st} data-testid={prTid('')}>
                    {safe ? (
                      <a href={pr.url} {...EXT} data-testid={prTid('link-')}>
                        {label}
                      </a>
                    ) : (
                      <span data-testid={prTid('link-')}>{label}</span>
                    )}
                    <span className="board-chip" data-pr-state={st} data-testid={prTid('state-')}>
                      {st.toUpperCase()}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

export function ReleaseSummaryDialog({ data, columns, jiraBase, scripts, onClose }) {
  const [copied, setCopied] = useState(null);
  const dialogRef = useModalDialog(onClose);
  const backdrop = useBackdropClose(dialogRef, onClose);
  const titleId = useId();
  const tid = (part) => `releases-summary-${part}`;

  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const { tickets } = data;
  const summary = summarizeRelease(tickets);
  const text = formatReleaseText(data, scripts.byTicket);
  const scriptTickets = tickets
    .map((t) => [t, scripts.byTicket[t.key]])
    .filter(([, items]) => items?.length);
  const note =
    scripts.state === 'loading'
      ? ['scripts-note', 'Checking scripts and migrations…']
      : scripts.state === 'unavailable'
        ? ['scripts-note', 'Scripts/migrations detection unavailable.']
        : !scriptTickets.length
          ? ['scripts-empty', 'No scripts or migrations detected for this release.']
          : null;
  const stats = [
    ['total', plural(summary.tickets.total, 'ticket')],
    ['prs', prMergedText(summary.prs)],
    ['scripts-count', `${plural(scriptTickets.length, 'ticket')} with scripts/migrations`],
  ];

  return (
    <dialog
      ref={dialogRef}
      className="releases-dlg"
      data-testid={tid('dialog')}
      aria-labelledby={titleId}
      {...backdrop}
    >
      <header>
        <h2 id={titleId} data-testid={tid('title')}>
          {data.version?.name || 'Release'}
        </h2>
        <Button data-testid={tid('close')} onClick={onClose}>
          Close
        </Button>
      </header>
      <div className="releases-dlg-b">
        <section data-testid={tid('rollup')}>
          <div className="releases-row">
            {stats.map(([id, label]) => (
              <span key={id} className="releases-stat" data-testid={tid(id)}>
                {label}
              </span>
            ))}
          </div>
          {columns.length > 0 && (
            <div className="releases-row" data-testid={tid('statuses')}>
              {columns.map((col) => (
                <span key={col.status} className="board-chip" data-jira-status-kind={col.kind}>
                  {col.status}: {col.tickets.length}
                </span>
              ))}
            </div>
          )}
        </section>

        <section data-testid={tid('scripts')}>
          <h3>Scripts &amp; Migrations</h3>
          {scripts.truncated && (
            <p data-testid={tid('scripts-truncated')}>
              Some PRs or files could not be checked — results may be incomplete.
            </p>
          )}
          {note ? (
            <p data-testid={tid(note[0])}>{note[1]}</p>
          ) : (
            <ul>
              {scriptTickets.map(([ticket, items]) => (
                <li
                  key={ticket.key}
                  className="releases-item"
                  data-testid={tid(`script-${ticket.key}`)}
                >
                  <div className="releases-base">
                    {jiraKey(ticket.key, jiraBase)}
                    {ticket.summary && <span className="releases-sub">{ticket.summary}</span>}
                  </div>
                  <ul>
                    {items.map((item, i) => (
                      <li key={i} className="releases-row">
                        <span className="board-chip releases-badge" data-script-kind={item.kind}>
                          {SCRIPT_KIND_LABELS[item.kind] ?? item.kind}
                        </span>
                        <span className="releases-mono">{formatScriptTarget(item)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="releases-between">
            <h3>Release notes</h3>
            <Button
              data-testid="releases-copy-text"
              onClick={async () => setCopied((await copyText(text)) ? 'Copied' : 'Copy failed')}
            >
              {copied ?? 'Copy text'}
            </Button>
          </div>
          <pre data-testid="releases-text">{text}</pre>
        </section>
      </div>
    </dialog>
  );
}
