// SlackThreadLink.jsx — the Slack entry point on a My Tickets card. A chip is the
// speech bubble, its reply count beside it, and a filled dot when the thread
// needs a reply. A thread with a Claude session attached fills its bubble and takes
// the support colour, and its label says so. The count, the dot and the fill are
// shown but hidden from assistive tech: the tooltip and accessible name carry the
// words. Presentational only: matching lives in ui/slack-ticket-links.js, and the
// click hands the thread to the in-app dialog instead of navigating away.
import { timeAgo } from '../../ui/dom.js';
import { DashboardTooltip } from './Primitives.jsx';

// The Claude sessions the watcher has attached to this thread. A missing or unreadable
// count is 0, so the chip stays plain.
function attachedCount(thread) {
  const sessions = thread?.attachedSessions;
  return Number.isFinite(sessions) && sessions > 0 ? sessions : 0;
}

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
  const sessions = attachedCount(thread);
  if (sessions === 1) parts.push('Claude session attached');
  else if (sessions > 1) parts.push(`${sessions} Claude sessions attached`);
  return parts.join(' · ');
}

export function SlackThreadLinks({ links = [], onOpen }) {
  // Nothing matched: render nothing at all, so a disconnected Slack leaves the
  // row byte-identical to the pre-link version.
  if (!links.length) return null;
  return (
    <span className="my-ticket-slack">
      {links.map((thread) => {
        const label = threadLabel(thread);
        const replies = Number.isFinite(thread.replyCount) ? thread.replyCount : 0;
        const attached = attachedCount(thread) > 0;
        return (
          <DashboardTooltip key={thread.ts} title={label}>
            <button
              type="button"
              className="slack-thread-link"
              data-testid={`slack-thread-link-${thread.ts}`}
              data-attached={attached ? 'true' : undefined}
              aria-label={label}
              onClick={() => onOpen?.(thread)}
            >
              {/* A speech bubble: at 13px a thread's outline reads faster than any
                  Slack mark that would need its own brand colours. An attached thread
                  fills the outline; the fill takes the chip's colour. */}
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
                <path
                  d="M21 11.6a8.4 8.4 0 0 1-8.5 8.2 9.2 9.2 0 0 1-3.3-.6L4.2 20.6l1.3-4.3a8 8 0 0 1-1.6-4.7A8.4 8.4 0 0 1 12.5 3.3 8.4 8.4 0 0 1 21 11.6Z"
                  fill={attached ? 'currentColor' : undefined}
                />
              </svg>
              {replies > 0 && (
                <span className="slack-thread-count" aria-hidden="true">
                  {replies}
                </span>
              )}
              {thread.needsReply && (
                <span
                  className="slack-thread-needs"
                  aria-hidden="true"
                  data-testid={`slack-thread-needs-reply-${thread.ts}`}
                />
              )}
            </button>
          </DashboardTooltip>
        );
      })}
    </span>
  );
}
