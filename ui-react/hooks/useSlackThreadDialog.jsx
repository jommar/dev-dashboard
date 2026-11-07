import { useCallback, useEffect } from 'react';
import { SlackThreadDialog } from '../components/SlackThreadDialog.jsx';
import { eligibleSlackRoot } from '../../ui/slack-activity.js';
import { useSlackActivityClock } from './useSlackActivityClock.js';
import { notifySlackSessionChanged } from './useSlackPending.js';

// The Slack thread dialog as every screen that opens one wires it (Slack, My Tickets): the
// activity clock, the rule that a thread past the cutoff closes its dialog, the reaction to a
// session that changed elsewhere or under the open conversation, and the dialog itself.
//
// The panel keeps what is its own and passes it in:
// - `openThread` / `setOpenThread`: the open thread. The panel's own session code closes it too,
//   which is why the state is not owned here.
// - `source`: the panel's name in `slack-session-changed` events; it ignores its own.
// - `snapshot` and `active`: what the clock reads, and whether the tab is the visible one.
// - `sessionIdentity`: a ref to the identity of the session the panel is showing.
// - `resetSession()` forgets the session's data, `reloadSession()` fetches it again (or notes
//   that it must be when the tab next opens). Both must be stable (useCallback).
// - `resolveOpener(ts)`: where focus returns on close (omit to let the dialog use its opener).
// - `onExpire()`: called just before an expired thread closes its dialog, for a panel that treats
//   that close differently from the user's.
// Returns the clock's `now` (what thread rows are placed and aged by) and the `dialog` element.
export function useSlackThreadDialog({
  source,
  snapshot,
  active,
  openThread,
  setOpenThread,
  sessionIdentity,
  resolveOpener,
  resetSession,
  reloadSession,
  onExpire,
}) {
  const [now, currentTime] = useSlackActivityClock(snapshot, active, openThread);
  const threadIsEligible = (ts) => eligibleSlackRoot(ts, currentTime());

  useEffect(() => {
    if (openThread && !eligibleSlackRoot(openThread.ts, now)) {
      onExpire?.();
      setOpenThread(null);
    }
  }, [openThread, now, setOpenThread, onExpire]);

  useEffect(() => {
    const sessionChanged = (event) => {
      if (event.detail?.source === source) return;
      resetSession();
      reloadSession();
    };
    window.addEventListener('slack-session-changed', sessionChanged);
    return () => window.removeEventListener('slack-session-changed', sessionChanged);
  }, [source, resetSession, reloadSession]);

  const sessionMismatch = useCallback(() => {
    resetSession();
    notifySlackSessionChanged(source);
    reloadSession();
  }, [source, resetSession, reloadSession]);

  const dialog = (
    <SlackThreadDialog
      thread={openThread}
      onClose={() => setOpenThread(null)}
      resolveOpener={resolveOpener}
      isEligible={threadIsEligible}
      sessionIdentity={sessionIdentity.current}
      onSessionMismatch={sessionMismatch}
    />
  );
  return { now, dialog };
}
