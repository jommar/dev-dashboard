import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDashboardApi } from './useDashboardApi.js';
import { useSlackThreadDialog } from './useSlackThreadDialog.jsx';
import { notifySlackSessionChanged } from './useSlackPending.js';
import { threadsByTicket } from '../../ui/slack-ticket-links.js';
import { eligibleSlackRoot, slackSessionIdentity } from '../../ui/slack-activity.js';
import { slackCoverage } from '../../ui/slack-coverage.js';

const NO_KEYS = [];
// Search is bounded per call (a few tickets each), so the rest is asked again shortly.
const TICKET_RETRY_MS = 20_000;
const TICKET_RETRY_LIMIT = 12;

// The Slack threads that name a ticket, as the ticket boards (My Tickets, Pull Requests) show
// them: the optional, often slow thread read, the session-identity guard around it, the thread
// dialog a chip opens, and the chips' matching. Slack has no error state here by design — it
// degrades to "no threads".
//
// `source` is the panel's name in `slack-session-changed` events; `active` is whether its tab is
// the visible one; `resolveOpener(ts)` is where focus returns when the dialog closes.
// `includeMentions` adds the threads the user was mentioned in to the ones they started: a board
// of other people's tickets (Pull Requests) finds its threads there, since someone else opened them.
// `ticketKeys` (the board's tickets) also asks Slack's own search which threads in ANY conversation
// the user can see name those tickets, so a thread in another channel, or one started by someone
// who never mentioned the user, gets its chip too; its rows say which channel they are in.
// Returns `loadSlack` (call it from the panel's own load), `openThread` (hand it a thread, with
// `selectedTicketKey` when the ticket is known), `linksByTicket`, the `dialog` element to render
// inside the panel, and the coverage warnings (`snapshot`, `incomplete`, ...).
export function useTicketSlackThreads({
  source,
  active,
  resolveOpener,
  includeMentions = false,
  ticketKeys = NO_KEYS,
}) {
  const api = useDashboardApi();
  const [snapshot, setSnapshot] = useState(null);
  const [openThread, setOpenThread] = useState(null);
  const [ticketRows, setTicketRows] = useState(NO_KEYS);
  const request = useRef(0);
  const ticketRequest = useRef(0);
  const ticketTimer = useRef(null);
  const keysRef = useRef(NO_KEYS);
  keysRef.current = ticketKeys;
  const keysKey = ticketKeys.join(',');
  const identity = useRef('');
  const dirty = useRef(false);
  const dialogWasOpen = useRef(false);
  const expiredDialog = useRef(false);
  const clearSlackData = useCallback(() => {
    dialogWasOpen.current = false;
    setOpenThread(null);
    setSnapshot(null);
    // The ticket search ran under the session that just went away.
    ticketRequest.current += 1;
    clearTimeout(ticketTimer.current);
    setTicketRows(NO_KEYS);
  }, []);
  // The threads that name this board's tickets, anywhere. A bounded answer leaves tickets for the
  // next call, so it is asked again a few times until nothing remains. Only the newest ask counts.
  const loadTicketThreads = useCallback(
    async (attempt = 0) => {
      clearTimeout(ticketTimer.current);
      const keys = keysRef.current;
      const id = ++ticketRequest.current;
      if (!keys.length) {
        setTicketRows(NO_KEYS);
        return;
      }
      const result = await api.getSlackTicketThreads(keys);
      if (id !== ticketRequest.current) return;
      setTicketRows(result?.available ? result.threads || NO_KEYS : NO_KEYS);
      if (result?.available && result.remaining > 0 && attempt < TICKET_RETRY_LIMIT)
        ticketTimer.current = setTimeout(() => loadTicketThreads(attempt + 1), TICKET_RETRY_MS);
    },
    [api],
  );
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
        // Fired, never awaited, like the list itself: it is optional and may take several searches.
        loadTicketThreads();
        return;
      }
    } catch {
      if (id === request.current) setSnapshot(null);
    }
  }, [api, clearSlackData, loadTicketThreads, source]);
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
  // A board whose tickets arrive after Slack's list asks again for the new set; nothing is asked
  // while Slack is not connected (no identity yet) or the tab is hidden.
  useEffect(() => {
    if (active && identity.current && keysKey) loadTicketThreads();
  }, [active, keysKey, loadTicketThreads]);
  useEffect(() => () => clearTimeout(ticketTimer.current), []);
  const linksByTicket = useMemo(() => {
    // The list's own rows carry no channel: they are the list's channel. A thread is told apart by
    // channel and timestamp, since a timestamp is only unique within one conversation.
    const own = snapshot?.channel;
    const rows = [
      ...[...(snapshot?.started || []), ...(includeMentions ? snapshot?.mentions || [] : [])].map(
        (row) => (own && !row.channel ? { ...row, channel: { ...own, kind: 'channel' } } : row),
      ),
      ...ticketRows,
    ];
    const seen = new Set();
    return threadsByTicket(
      rows.filter((row) => {
        const id = `${row.channel?.id ?? ''}:${row.ts}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return eligibleSlackRoot(row.ts, now);
      }),
    );
  }, [snapshot, ticketRows, includeMentions, now]);
  return {
    snapshot,
    loadSlack,
    openThread: setOpenThread,
    linksByTicket,
    dialog,
    ...slackCoverage(snapshot),
  };
}
