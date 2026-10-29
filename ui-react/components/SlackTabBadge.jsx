import { useSlackPending } from '../hooks/useSlackPending.js';

const MAX_COUNT = 99;

// Sits inside the Slack tab label so waiting work is visible from any panel.
// Renders nothing at all while Slack is disconnected or the channel is quiet:
// a badge that a stale session could not clear would be worse than no badge.
export function SlackTabBadge() {
  const { pending } = useSlackPending();
  const channel = pending?.available ? pending.channel : null;
  if (!channel) return null;
  const mentions = Number(channel.mentions) || 0;
  if (mentions > 0)
    return (
      <span
        className="tab-badge"
        data-testid="tab-slack-badge"
        aria-label={`${mentions} unread Slack ${mentions === 1 ? 'mention' : 'mentions'}`}
      >
        {mentions > MAX_COUNT ? `${MAX_COUNT}+` : mentions}
      </span>
    );
  if (channel.unread)
    return (
      <span
        className="tab-badge tab-badge-dot"
        data-testid="tab-slack-badge"
        role="img"
        aria-label="New Slack activity"
      />
    );
  return null;
}
