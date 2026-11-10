// TicketLaunchers.jsx — the row of launchers on a ticket card, one for every board that has them
// (My Tickets, Pull Requests): the Slack threads that name the ticket, then the Claude button.
// Everything that makes the row is here: finding the ticket's threads and its Claude entry in the
// maps the panel owns (a card passes only its key), the key hand-off to the thread dialog, and
// the two buttons. What stays the board's is its row test id and the Claude button's own id,
// label and tooltip (`claudeProps`); the panels keep the data, the dialogs and the open handlers.
import { normalizeTicketKey } from '../../ui/slack-ticket-links.js';
import { SlackThreadLinks } from './SlackThreadLink.jsx';
import { ClaudeIcon } from './ClaudeIcon.jsx';

const NO_LINKS = Object.freeze([]);

export function TicketLaunchers({
  ticketKey,
  testId,
  linksByTicket,
  onOpenThread,
  claudeByTicket,
  claudeProps,
  onOpenClaude,
}) {
  // The matcher keys threads by the normalised key (TRIPS folds onto TAP); the Claude workflow is
  // kept under the key the card displays.
  const links = linksByTicket?.get(normalizeTicketKey(ticketKey)) || NO_LINKS;
  return (
    <div className="board-card-links" data-testid={testId}>
      <SlackThreadLinks
        links={links}
        onOpen={(thread) => onOpenThread?.({ ...thread, selectedTicketKey: ticketKey })}
      />
      <ClaudeIcon
        ticketKey={ticketKey}
        entry={claudeByTicket?.[ticketKey]}
        onOpen={onOpenClaude}
        {...claudeProps}
      />
    </div>
  );
}
