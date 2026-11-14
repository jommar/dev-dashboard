// SessionsBody.jsx — the list inside the Sessions drawer: the groups and their rows (SessionsDrawer holds
// the tab, the search and every piece of state, and loads this before it opens, so it is not in the
// first-paint bundle). A row opens the same Claude dialog the bot opens, says when its session was last
// active ("9m ago", read as "active 9m ago"), flags a working one that went quiet (isQuiet), shows the
// tokens it used, and has a Chat link and a copy button, each a dimmed placeholder when it has nothing to do.
import { useId } from 'react';
import { Button, DashboardTooltip } from './Primitives.jsx';
import { NavIcon } from './NavIcon.jsx';
import { RelativeTime } from './slack-watch/RelativeTime.jsx';
import { QUIET_WORKING_MS, isQuiet } from '../../ui/bot-bar.js';
import { chatHref } from '../../ui/chat-stream.js';
import { rowUsageLabel } from '../../ui/session-usage.js';

// The popup on a row's time: when the session was last written to and, for a quiet one, for how long.
const activityTitle = (iso, quiet) =>
  `Last active ${new Date(iso).toLocaleString()}${
    quiet ? ` · working but quiet for ${QUIET_WORKING_MS / 60_000}+ min` : ''
  }`;

// Why a row has no Copy command, in words: a working chat has no command yet.
const copyReason = ({ phase, state }) =>
  phase === 'chat' && state === 'working'
    ? 'Working: no resume command yet'
    : 'No resume command available';

// A slot with nothing to offer: dimmed and aria-disabled, but still focusable so its tooltip, and its
// name, say why. It is not a link or a button element and does nothing when activated.
function SlotOff({ slot, icon, testId, label, reason }) {
  return (
    <DashboardTooltip title={reason} placement="left">
      <span
        role="button"
        tabIndex={0}
        aria-disabled="true"
        className="sessions-row-slot-off"
        data-slot={slot}
        data-testid={testId}
        aria-label={`${label}, unavailable: ${reason}`}
      >
        <NavIcon name={icon} />
      </span>
    </DashboardTooltip>
  );
}

function Row({ row, now, outcome, usage, onOpen, onCopy, onClose }) {
  const { key, ticket, phase, state, goTo, lastActiveAt, session, mark, detail, copyWord, meta } =
    row;
  const phaseWords = row.words;
  // A standalone chat has no ticket; its title is what names it.
  const name = row.title ?? ticket;
  const what = `${name} ${phaseWords} session`;
  const chatLabel = `Chat with ${what}`;
  const copyLabel = `Copy command to continue ${what}`;
  const whenId = useId();
  const usageId = useId();
  const ok = outcome === 'Copied';
  const quiet = isQuiet(row, now);
  const tokens = rowUsageLabel(usage);
  const described = [tokens && usageId, lastActiveAt && whenId].filter(Boolean).join(' ');
  return (
    <li className="sessions-row" data-testid={`sessions-row-${key}`} data-state={state}>
      <button
        type="button"
        className="sessions-row-open"
        data-testid={`sessions-open-${key}`}
        aria-label={`Open ${what}`}
        aria-describedby={described || undefined}
        aria-haspopup={phase === 'chat' ? undefined : 'dialog'}
        onClick={() => onOpen(ticket, phase)}
      >
        <span className="sessions-row-mark" data-state={state}>
          {mark}
        </span>
        {meta && (
          <DashboardTooltip title={phaseWords} placement="top">
            <span
              className="sessions-row-phase"
              data-testid={`sessions-phase-${key}`}
              data-phase={phase}
              style={{ color: `var(${meta.color})` }}
            >
              <NavIcon name={meta.icon} />
            </span>
          </DashboardTooltip>
        )}
        <span className="sessions-row-ticket">{name}</span>
        <span className="sessions-row-detail">{detail}</span>
      </button>
      {tokens && (
        <span id={usageId} className="sessions-row-usage" data-testid={`sessions-usage-${key}`}>
          {tokens}
        </span>
      )}
      {lastActiveAt && (
        <span
          id={whenId}
          className="sessions-row-when"
          data-testid={`sessions-when-${key}`}
          data-quiet={quiet || undefined}
        >
          <span className="sr-only">{quiet ? 'quiet, active ' : 'active '}</span>
          <RelativeTime iso={lastActiveAt} now={now} title={activityTitle(lastActiveAt, quiet)} />
        </span>
      )}
      {session ? (
        <DashboardTooltip title="Chat" placement="left">
          <a
            className="sessions-row-chat"
            href={chatHref(session)}
            onClick={onClose}
            data-testid={`sessions-chat-${key}`}
            aria-label={chatLabel}
          >
            <NavIcon name="chat" />
          </a>
        </DashboardTooltip>
      ) : (
        <SlotOff
          slot="chat"
          icon="chat"
          testId={`sessions-chat-off-${key}`}
          label={chatLabel}
          reason="No session to chat with"
        />
      )}
      {goTo ? (
        <DashboardTooltip title={outcome ?? copyWord} placement="left">
          <Button
            className="subtle sessions-row-copy"
            data-testid={`sessions-copy-${key}`}
            data-outcome={outcome && (ok ? 'copied' : 'failed')}
            aria-label={outcome ?? copyLabel}
            onClick={() => onCopy(key, goTo.command)}
          >
            <NavIcon name={ok ? 'check' : 'copy'} />
          </Button>
        </DashboardTooltip>
      ) : (
        <SlotOff
          slot="copy"
          icon="copy"
          testId={`sessions-copy-off-${key}`}
          label={copyLabel}
          reason={copyReason(row)}
        />
      )}
    </li>
  );
}

// `shown` is the filtered groups and `count` every session; `dress` (SessionsDrawer's) adds to a row the `mark`,
// `words`, `detail`, `copyWord` and `meta` (the phase's icon and colour) it shows and `empty` is the line for no
// sessions. `copied` is { key, outcome } of the row whose copy button shows its outcome.
// The rest (`onOpen`, `onCopy`, `onClose`) goes to each row.
export function SessionsBody({ empty, count, shown, dress, now, copied, usage, ...handlers }) {
  return (
    <div className="sessions-body" data-testid="sessions-body">
      {shown.length === 0 ? (
        <p className="sessions-empty" data-testid={count ? 'sessions-no-match' : 'sessions-empty'}>
          {count ? 'No sessions match your search.' : empty}
        </p>
      ) : (
        shown.map(({ state, title, rows }) => (
          <section key={state} className="sessions-group" data-testid={`sessions-${state}`}>
            <h3>
              {title}
              <span className="sessions-group-count">{rows.length}</span>
            </h3>
            <ul>
              {rows.map((row) => (
                <Row
                  key={row.key}
                  row={dress(row)}
                  now={now}
                  outcome={copied?.key === row.key ? copied.outcome : null}
                  usage={row.session ? usage[row.session] : undefined}
                  {...handlers}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
