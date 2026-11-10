import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDashboardApi } from './useDashboardApi.js';
import { useSlackThreadDialog } from './useSlackThreadDialog.jsx';
import { notifySlackSessionChanged } from './useSlackPending.js';
import { threadsByTicket } from '../../ui/slack-ticket-links.js';
import { eligibleSlackRoot, slackSessionIdentity } from '../../ui/slack-activity.js';
import { slackCoverage } from '../../ui/slack-coverage.js';

// The Slack threads that name a ticket, as the ticket boards (My Tickets, Pull Requests) show
// them: the optional, often slow thread read, the session-identity guard around it, the thread
// dialog a chip opens, and the chips' matching. Slack has no error state here by design — it
// degrades to "no threads".
//
// `source` is the panel's name in `slack-session-changed` events; `active` is whether its tab is
// the visible one; `resolveOpener(ts)` is where focus returns when the dialog closes.
// `includeMentions` adds the threads the user was mentioned in to the ones they started: a board
// of other people's tickets (Pull Requests) finds its threads there, since someone else opened them.
// Returns `loadSlack` (call it from the panel's own load), `openThread` (hand it a thread, with
// `selectedTicketKey` when the ticket is known), `linksByTicket`, the `dialog` element to render
// inside the panel, and the coverage warnings (`snapshot`, `incomplete`, ...).
export function useTicketSlackThreads({ source, active, resolveOpener, includeMentions = false }) {
  const api = useDashboardApi();
  const [snapshot, setSnapshot] = useState(null);
  const [openThread, setOpenThread] = useState(null);
  const request = useRef(0);
  const identity = useRef('');
  const dirty = useRef(false);
  const dialogWasOpen = useRef(false);
  const expiredDialog = useRef(false);
  const clearSlackData = useCallback(() => {
    dialogWasOpen.current = false;
    setOpenThread(null);
    setSnapshot(null);
  }, []);
  const loadSlack = useCallback(async () => {
    const id = ++request.current;
    try {
      // One immediate retry can load a versioned replacement session without
      // allowing changing credentials to create an unbounded request loop.
      for (let attempt = 0; attempt < 2; attempt++) {
        const status = await api.getSlackStatus();
        const before = slackSessionIdentity(status, identity.current);
        if (id !== request.current) return;
        if (identity.current && before !== identity.current) {
          clearSlackData();
          notifySlackSessionChanged(source);
        }
        identity.current = before;
        if (!before) {
          clearSlackData();
          return;
        }
        const requestStartedWallAt = Date.now();
        const requestStartedAt = performance.now();
        const result = await api.getSlackThreads();
        const after = slackSessionIdentity(await api.getSlackStatus(), before);
        if (id !== request.current) return;
        if (after !== before) {
          clearSlackData();
          identity.current = after;
          notifySlackSessionChanged(source);
          // A legacy savedAt/account identity does not establish that the
          // backend invalidated its old list cache. Discard rather than
          // immediately re-requesting a possibly old-session snapshot.
          if (before.startsWith('version:') && after.startsWith('version:')) continue;
          return;
        }
        identity.current = after;
        setSnapshot(
          result?.available
            ? {
                ...result,
                _requestStartedAt: requestStartedAt,
                _requestStartedWallAt: requestStartedWallAt,
              }
            : null,
        );
        return;
      }
    } catch {
      if (id === request.current) setSnapshot(null);
    }
  }, [api, clearSlackData, source]);
  const resetSlack = useCallback(() => {
    request.current += 1;
    identity.current = '';
    clearSlackData();
  }, [clearSlackData]);
  // A session that changed while this tab was hidden is fetched when it next opens (below).
  const reloadSlack = useCallback(() => {
    if (active) loadSlack();
    else dirty.current = true;
  }, [active, loadSlack]);
  // A thread that left the window closes its dialog without the re-read a user's close triggers.
  const expireDialog = useCallback(() => {
    expiredDialog.current = true;
  }, []);
  const { now, dialog } = useSlackThreadDialog({
    source,
    snapshot,
    active,
    openThread,
    setOpenThread,
    sessionIdentity: identity,
    resolveOpener,
    resetSession: resetSlack,
    reloadSession: reloadSlack,
    onExpire: expireDialog,
  });
  useEffect(() => {
    if (!active || !dirty.current) return;
    dirty.current = false;
    loadSlack();
  }, [active, loadSlack]);
  // The thread dialog is where a Claude session gets attached, so the threads are read again
  // once it closes and the chip shows the attach at once. The route answers from its cache, so
  // this costs no Slack call within the cache's lifetime.
  useEffect(() => {
    if (openThread) dialogWasOpen.current = true;
    else if (dialogWasOpen.current) {
      dialogWasOpen.current = false;
      if (!expiredDialog.current) loadSlack();
      expiredDialog.current = false;
    }
  }, [openThread, loadSlack]);
  const linksByTicket = useMemo(() => {
    const rows = [
      ...(snapshot?.started || []),
      ...(includeMentions ? snapshot?.mentions || [] : []),
    ];
    const seen = new Set();
    return threadsByTicket(
      rows.filter((row) => {
        if (seen.has(row.ts)) return false;
        seen.add(row.ts);
        return eligibleSlackRoot(row.ts, now);
      }),
    );
  }, [snapshot, includeMentions, now]);
  return {
    snapshot,
    loadSlack,
    openThread: setOpenThread,
    linksByTicket,
    dialog,
    ...slackCoverage(snapshot),
  };
}
