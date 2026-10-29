// SlackThreadLink.jsx — the icon-only Slack entry point on a My Tickets row.
// A row shows just a glyph per matching thread (never a label or a count), so
// the tooltip and accessible name carry the whole description. Presentational
// only: matching lives in ui/slack-ticket-links.js and fetching in the panel.
import { timeAgo } from '../../ui/dom.js';

// Slack's own snapshot can arrive cold, without a reply count, and a thread
// without activity has no timestamp at all. Each such part is dropped instead of
// printing "undefined" or "NaN"; timeAgo already returns "" for a missing date.
function threadLabel(thread) {
  const parts = ['Slack thread'];
  const replies = thread?.replyCount;
  if (Number.isFinite(replies)) parts.push(`${replies} ${replies === 1 ? 'reply' : 'replies'}`);
  const when = timeAgo(thread?.activityAt);
  if (when) parts.push(when);
  if (thread?.needsReply) parts.push('needs reply');
  return parts.join(' · ');
}

export function SlackThreadLinks({ links = [] }) {
  // Nothing matched: render nothing at all, so a disconnected Slack leaves the
  // row byte-identical to the pre-link version.
  if (!links.length) return null;
  return (
    <span className="my-ticket-slack">
      {links.map((thread) => {
        const label = threadLabel(thread);
        return (
          <a
            key={thread.ts}
            className="slack-thread-link"
            href={thread.url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`slack-thread-link-${thread.ts}`}
            data-tooltip={label}
            aria-label={label}
          >
            {/* A speech bubble: at 13px a thread's outline reads faster than any
                Slack mark that would need its own brand colours. */}
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M21 11.6a8.4 8.4 0 0 1-8.5 8.2 9.2 9.2 0 0 1-3.3-.6L4.2 20.6l1.3-4.3a8 8 0 0 1-1.6-4.7A8.4 8.4 0 0 1 12.5 3.3 8.4 8.4 0 0 1 21 11.6Z" />
            </svg>
          </a>
        );
      })}
    </span>
  );
}
