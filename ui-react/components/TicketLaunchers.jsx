// TicketLaunchers.jsx — the row of launchers on a ticket card, one for every board that has them
// (My Tickets, Pull Requests): the Slack threads that name the ticket, then the Claude button.
// The row's test id, and the Claude button's own id, label and tooltip, are the board's;
// the buttons and the hand-off of the ticket key to the thread dialog are not.
import { SlackThreadLinks } from './SlackThreadLink.jsx';
import { ClaudeIcon } from './ClaudeIcon.jsx';

export function TicketLaunchers({
  ticketKey,
  testId,
  slackLinks = [],
  onOpenThread,
  claudeEntry,
  claudeProps,
  onOpenClaude,
}) {
  return (
    <div className="board-card-links" data-testid={testId}>
      <SlackThreadLinks
        links={slackLinks}
        onOpen={(thread) => onOpenThread?.({ ...thread, selectedTicketKey: ticketKey })}
      />
      <ClaudeIcon
        ticketKey={ticketKey}
        entry={claudeEntry}
        onOpen={onOpenClaude}
        {...claudeProps}
      />
    </div>
  );
}
