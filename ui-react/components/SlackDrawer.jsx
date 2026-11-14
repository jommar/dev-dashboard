// SlackDrawer.jsx — the Slack activity drawer's edge tab and frame, under the Sessions tab on every
// screen. Only this tab is in the first-paint bundle: its body (SlackFeedPanel) is a lazy overlay that
// loads before the drawer opens. The count on the tab is unread mentions only (`activityMentions`
// from the shared pending poll), never thread or reaction chatter.
import { Suspense, useCallback, useRef } from 'react';
import { useSlackPending } from '../hooks/useSlackPending.js';
import { SlackFeedPanel, loadSlackFeedPanel } from '../lib/lazy-overlays.js';
import { EdgeDrawer } from './EdgeDrawer.jsx';
import { ChunkBoundary } from './ScreenSlot.jsx';

export function SlackDrawer({ open, onToggle, drawerId }) {
  const tab = useRef(null);
  const state = useSlackPending();
  const { pending } = state;
  const unread = Number(pending?.available && pending.activityMentions) || 0;

  // Load the body's code first, then open (also when the load fails: the body says so).
  const toggle = useCallback(
    (next) => {
      const apply = () => onToggle(next);
      if (next) loadSlackFeedPanel().then(apply, apply);
      else apply();
    },
    [onToggle],
  );

  return (
    <EdgeDrawer
      name="slack-feed"
      id={drawerId}
      open={open}
      onToggle={toggle}
      tabRef={tab}
      slot="lower"
      label="Slack"
      count={unread > 99 ? '99+' : unread || undefined}
      attention={unread > 0}
      sweep={pending?.available && state}
      tabLabel={`Slack activity${unread ? `, ${unread} unread mention${unread > 1 ? 's' : ''}` : ''}`}
      title="Slack activity"
      closeLabel="Close Slack activity"
    >
      <ChunkBoundary
        fallback={
          <p className="slack-feed-load-failed" data-testid="slack-feed-load-failed">
            Slack activity could not load. Reload the page.
          </p>
        }
      >
        <Suspense>
          <SlackFeedPanel tabRef={tab} onClose={onToggle} />
        </Suspense>
      </ChunkBoundary>
    </EdgeDrawer>
  );
}
