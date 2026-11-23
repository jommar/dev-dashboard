// slack-feed-route.test.mjs — GET /api/slack/feed: it sits before the setup gate, answers the
// integration's feed() verbatim with the pinned key sets, degrades calmly when Slack is not
// connected, and leaves a `[http]` line with no message, query or body. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';
import { settingsFixture, accept } from './settings-fixture.mjs';
import {
  ALEX,
  ME,
  SAM,
  connectedFeed,
  mentionItem,
  reactionItem,
  threadItem,
  tsOf,
} from './slack-feed-fixture.mjs';

async function startRoute(t, { ready = true, integrations = {} } = {}) {
  const fixture = settingsFixture(t);
  const store = await fixture.store();
  if (ready) await accept(fixture, store);
  else await store.initialize();
  const { createHttpHandler } = await import('../backend/http-app.mjs');
  const lines = [];
  const manager = { list: () => [], logs: () => '', applySettings: async () => {} };
  const handler = createHttpHandler({
    settings: store,
    manager,
    integrations: { log: (line) => lines.push(line), ...integrations },
  });
  const { origin } = await listenHttp(t, handler);
  const request = async (pathname, method = 'GET', headers) => {
    const { status, text } = await requestRaw(origin, pathname, { method, headers });
    return { status, text, json: () => JSON.parse(text) };
  };
  return { request, lines };
}

const ROOM = 'C0EXAMPLE1';
const MENTION_KEYS = ['at', 'author', 'channel', 'hydrated', 'id', 'kind', 'text', 'unread', 'url'];

function populated() {
  const mentionTs = tsOf(50);
  const parentTs = tsOf(60);
  const latestTs = tsOf(90);
  const reactedTs = tsOf(70);
  return {
    items: [
      mentionItem({ key: 'k-mention', channel: ROOM, ts: mentionTs, unread: true }),
      threadItem({ key: 'k-thread', channel: ROOM, threadTs: parentTs, latestTs, unreadCount: 2 }),
      reactionItem({ key: 'k-react', channel: ROOM, ts: reactedTs }),
    ],
    messages: {
      [`${ROOM}:${mentionTs}`]: { ts: mentionTs, user: ALEX, text: 'A mention' },
      [`${ROOM}:${parentTs}`]: { ts: parentTs, user: SAM, text: 'Parent' },
      [`${ROOM}:${latestTs}`]: { ts: latestTs, user: ALEX, text: 'Latest' },
      [`${ROOM}:${reactedTs}`]: { ts: reactedTs, user: ME, text: 'Mine' },
    },
  };
}

test('the route answers 200 with the integration feed reply as is', async (t) => {
  const reply = { available: false, reason: 'unavailable' };
  const { request } = await startRoute(t, { integrations: { slack: { feed: async () => reply } } });
  const res = await request('/api/slack/feed');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), reply);
});

test('the route sits before the setup gate', async (t) => {
  const reply = { available: false, reason: 'disconnected' };
  const { request } = await startRoute(t, {
    ready: false,
    integrations: { slack: { feed: async () => reply } },
  });
  const res = await request('/api/slack/feed');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), reply);
});

test('route reply key sets: calm degrade when nothing is connected', async (t) => {
  const { integration } = connectedFeed(t, {});
  const { request } = await startRoute(t, { integrations: { slack: integration } });
  const res = await request('/api/slack/feed');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { available: false, reason: 'disconnected' });
});

test('route reply key sets: the page and every row kind', async (t) => {
  const { integration, writeSession } = connectedFeed(t, populated());
  writeSession();
  const { request } = await startRoute(t, { integrations: { slack: integration } });

  const res = await request('/api/slack/feed');

  assert.equal(res.status, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), [
    'available',
    'mentions',
    'partial',
    'reactions',
    'threads',
    'updatedAt',
  ]);
  assert.equal(new Date(body.updatedAt).toISOString(), body.updatedAt);
  assert.deepEqual(Object.keys(body.mentions[0]).sort(), MENTION_KEYS);
  assert.deepEqual(
    Object.keys(body.threads[0]).sort(),
    [...MENTION_KEYS, 'parentText', 'replies', 'thread'].sort(),
  );
  assert.deepEqual(Object.keys(body.threads[0].thread).sort(), ['channelId', 'ts']);
  assert.deepEqual(Object.keys(body.reactions[0]).sort(), [...MENTION_KEYS, 'reaction'].sort());
  assert.deepEqual(Object.keys(body.reactions[0].reaction).sort(), ['by', 'name']);
  assert.deepEqual(Object.keys(body.mentions[0].channel).sort(), ['name', 'type']);
});

test('route reply key sets: threaded mention and reaction carry thread { channelId, ts }', async (t) => {
  const rootTs = tsOf(40);
  const mentionTs = tsOf(55);
  const reactedTs = tsOf(65);
  const threadedReaction = reactionItem({ key: 'k-react-threaded', channel: ROOM, ts: reactedTs });
  threadedReaction.item.message.thread_ts = rootTs;
  const { integration, writeSession } = connectedFeed(t, {
    items: [
      mentionItem({
        key: 'k-mention-threaded',
        channel: ROOM,
        ts: mentionTs,
        threadTs: rootTs,
        unread: true,
      }),
      threadedReaction,
    ],
    messages: {
      [`${ROOM}:${mentionTs}`]: { ts: mentionTs, thread_ts: rootTs, user: ALEX, text: 'In thread' },
      [`${ROOM}:${reactedTs}`]: { ts: reactedTs, thread_ts: rootTs, user: ME, text: 'My reply' },
    },
  });
  writeSession();
  const { request } = await startRoute(t, { integrations: { slack: integration } });

  const res = await request('/api/slack/feed');

  assert.equal(res.status, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body.mentions[0]).sort(), [...MENTION_KEYS, 'thread'].sort());
  assert.deepEqual(body.mentions[0].thread, { ts: rootTs, channelId: ROOM });
  assert.deepEqual(
    Object.keys(body.reactions[0]).sort(),
    [...MENTION_KEYS, 'reaction', 'thread'].sort(),
  );
  assert.deepEqual(body.reactions[0].thread, { ts: rootTs, channelId: ROOM });
});

test('route hygiene: a failing feed leaves one [http] line with no message and no query', async (t) => {
  const { request, lines } = await startRoute(t, {
    integrations: {
      slack: {
        feed: async () => {
          throw new Error('feed broke SLACK-TEXT-SENTINEL');
        },
      },
    },
  });

  const res = await request('/api/slack/feed?q=QUERY-SENTINEL');

  assert.ok(res.status >= 500, 'a throwing feed is a server error');
  assert.equal(lines.length, 1);
  const text = lines.join('\n');
  for (const secret of ['SLACK-TEXT-SENTINEL', 'QUERY-SENTINEL'])
    assert.ok(!text.includes(secret), `${secret} must not be logged`);
  const line = JSON.parse(lines[0].slice('[http] '.length));
  assert.equal(line.route, '/api/slack/feed');
  assert.ok(!('message' in line), 'no message on the Slack routes');
});

test('a cross-site read is refused with INVALID_ORIGIN before Slack is asked anything', async (t) => {
  let asked = 0;
  const { request } = await startRoute(t, {
    integrations: {
      slack: {
        feed: async () => {
          asked += 1;
          return { available: false, reason: 'unavailable' };
        },
      },
    },
  });
  for (const site of ['cross-site', 'same-site']) {
    const res = await request('/api/slack/feed', 'GET', { 'sec-fetch-site': site });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json(), { code: 'INVALID_ORIGIN', error: 'INVALID ORIGIN', errors: [] });
  }
  assert.equal(
    (await request('/api/slack/feed', 'GET', { 'sec-fetch-site': 'same-origin' })).status,
    200,
  );
  assert.equal(asked, 1, 'only the same-origin read reached the integration');
});
