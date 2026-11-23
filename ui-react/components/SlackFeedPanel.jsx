// SlackFeedPanel.jsx — the body of the Slack activity drawer (lazy: SlackDrawer loads it before the
// drawer opens). It reads GET /api/slack/feed once when it mounts and again on Refresh, never on a timer,
// and is unmounted when the drawer shuts, so every open starts on Mentions. Threaded rows open the in-app
// thread dialog; non-threaded rows remain plain links to the message in Slack. A disconnected or
// unavailable Slack is a calm line, never an error.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSlackFeed, getSlackStatus } from '../lib/api.js';
import { useSlackThreadDialog } from '../hooks/useSlackThreadDialog.jsx';
import { timeAgo } from '../../ui/dom.js';
import { slackSessionIdentity } from '../../ui/slack-activity.js';
import { FEED_TABS, channelLabel, rowThread, tabCounts, unreadFirst } from '../../ui/slack-feed.js';
import { BoardNote, BoardState, BoardTabs, tabDomId, tabPanelDomId } from './BoardShell.jsx';
import { Button } from './Primitives.jsx';

const NAME = 'slack-feed';

const Frame = ({ children }) => <div className="slack-feed">{children}</div>;

function FeedRow({ row, onOpen }) {
  const { reaction, replies } = row;
  const thread = rowThread(row);
  const content = (
    <>
      <span className="slack-feed-row-head">
        {row.unread && <span className="slack-feed-dot" aria-hidden />}
        {row.unread && <span className="sr-only">Unread</span>}
        <span className="slack-feed-channel">{channelLabel(row.channel)}</span>
        {row.author && <span className="slack-feed-author">{row.author}</span>}
        <span className="slack-feed-when">{timeAgo(row.at)}</span>
      </span>
      <span className="slack-feed-text">{row.hydrated ? row.text : 'Message not loaded'}</span>
      {replies > 0 && (
        <span className="slack-feed-meta">
          {replies} new {replies === 1 ? 'reply' : 'replies'}
          {row.parentText && ` · ${row.parentText}`}
        </span>
      )}
      {reaction && (
        <span className="slack-feed-meta">
          {reaction.by || 'Someone'} reacted :{reaction.name}:
        </span>
      )}
    </>
  );
  return (
    <li>
      {thread ? (
        <button
          type="button"
          className="slack-feed-row"
          data-testid={`slack-feed-row-${row.id}`}
          data-unread={row.unread || undefined}
          aria-haspopup="dialog"
          onClick={() => onOpen(thread)}
        >
          {content}
        </button>
      ) : (
        <a
          className="slack-feed-row"
          data-testid={`slack-feed-row-${row.id}`}
          data-unread={row.unread || undefined}
          href={row.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {content}
        </a>
      )}
    </li>
  );
}

// `onClose` shuts the drawer and `tabRef` is its edge tab (the link to the Slack tab leaves the focus there).
export function SlackFeedPanel({ tabRef, onClose }) {
  const [feed, setFeed] = useState(null);
  const [view, setView] = useState(FEED_TABS[0].id);
  const [loading, setLoading] = useState(true);
  const [openThread, setOpenThread] = useState(null);
  const reading = useRef(false);
  const mounted = useRef(true);
  const request = useRef(0);
  const sessionIdentity = useRef('');

  // One read at a time; an answer that arrives after the drawer shut or a session change is dropped.
  const load = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const id = ++request.current;
    setLoading(true);
    const [answer, status] = await Promise.all([getSlackFeed(), getSlackStatus()]);
    if (!mounted.current || id !== request.current) return;
    reading.current = false;
    sessionIdentity.current = slackSessionIdentity(status, sessionIdentity.current);
    setFeed((was) => (was?.available && answer.reason === 'unavailable' ? was : answer));
    setLoading(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const resetSession = useCallback(() => {
    request.current += 1;
    reading.current = false;
    sessionIdentity.current = '';
    setFeed(null);
    setOpenThread(null);
  }, []);

  const { dialog } = useSlackThreadDialog({
    source: NAME,
    active: true,
    openThread,
    setOpenThread,
    sessionIdentity,
    resetSession,
    reloadSession: load,
    enforceWindow: false,
  });

  const leave = () => {
    onClose(false);
    tabRef.current?.focus();
  };
  const refresh = (
    <Button data-testid="slack-feed-refresh" aria-disabled={loading} onClick={load}>
      Refresh
    </Button>
  );

  if (!feed)
    return (
      <Frame>
        <BoardState kind="loading" testId="slack-feed-loading" label="Loading Slack activity…" />
      </Frame>
    );
  if (!feed.available)
    return (
      <Frame>
        {feed.reason === 'disconnected' ? (
          <BoardState testId="slack-feed-disconnected">
            <p>
              Slack is not connected. Connect Slack in the Slack tab.{' '}
              <a href="#/slack" data-testid="slack-feed-connect-link" onClick={leave}>
                Open the Slack tab
              </a>
            </p>
          </BoardState>
        ) : (
          <BoardState testId="slack-feed-unavailable">
            <p>Slack activity could not be read right now.</p>
            {refresh}
          </BoardState>
        )}
      </Frame>
    );

  const counts = tabCounts(feed);
  const tabs = FEED_TABS.map((tab) => ({
    ...tab,
    ...(counts[tab.id] && { count: counts[tab.id], hint: 'unread' }),
  }));
  const rows = unreadFirst(feed[view] ?? []);
  return (
    <Frame>
      <div className="slack-feed-toolbar">
        <BoardTabs
          name={NAME}
          label="Slack activity views"
          tabs={tabs}
          value={view}
          onChange={setView}
        />
        {refresh}
      </div>
      {feed.partial?.length > 0 && (
        <BoardNote testId="slack-feed-partial">
          Some rows could not be loaded. Refresh to try again.
        </BoardNote>
      )}
      <div
        className="slack-feed-body"
        id={tabPanelDomId(NAME)}
        role="tabpanel"
        aria-labelledby={tabDomId(NAME, view)}
        data-testid="slack-feed-body"
      >
        {rows.length ? (
          <ul className="slack-feed-list">
            {rows.map((row) => (
              <FeedRow key={row.id} row={row} onOpen={setOpenThread} />
            ))}
          </ul>
        ) : (
          <p className="slack-feed-empty" data-testid="slack-feed-empty">
            Nothing here in your recent Slack activity.
          </p>
        )}
      </div>
      {dialog}
    </Frame>
  );
}
