// The pure helpers of the Slack activity drawer's panel (SlackFeedPanel.jsx): its tabs, the count on
// each, and how a row names its conversation. Only the lazy panel imports this file.

// Mentions first and the default; Threads (replies that do not mention you) and Reactions follow.
export const FEED_TABS = ['Mentions', 'Threads', 'Reactions'].map((label) => {
  const id = label.toLowerCase();
  return { id, label, testId: `slack-feed-view-${id}` };
});

// Unread rows per tab (never the number of rows), from an available feed reply.
export const tabCounts = (feed) =>
  Object.fromEntries(
    FEED_TABS.map(({ id }) => [id, (feed[id] ?? []).filter((row) => row.unread).length]),
  );

// `#name` for a channel, the plain name for a DM or group; a row the server could not name is calm.
export function channelLabel(channel) {
  if (!channel?.name) return 'Unknown conversation';
  return channel.type === 'channel' || channel.type === 'private'
    ? `#${channel.name}`
    : channel.name;
}
