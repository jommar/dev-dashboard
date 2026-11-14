// harness-fake.mjs — the test-only harness adapter: a second adapter that is not Claude Code, so the
// seam is proven without any other real CLI. It has the full adapter shape (sessions service, chat,
// usage and spec-review facets, commands, a home gate) behind a scripted world, and records every call
// and every process start it would have made. No process is ever started.
//
// `await createFakeHarness({ without, overrides })` answers `{ harness, world, calls, starts, ... }`:
//   harness     the frozen adapter object, id `fake`, command `fake`, ready for `integrations.harness`
//   without     facets to leave out of it: any of 'chat', 'usage', 'limits'
//   overrides   members that replace the fake's own (a `commands` that gives null, a `homeReadable`)
//   calls       `{ method, args }` of every sessions-service call, in order (`sessionCalls(method)`)
//   starts      `{ file, args, options, session }` of every process the service would have started
//   setEntries  the listing the sessions service reads: an array of session entries, or null for an
//               unusable listing; `setChild('ok' | 'timeout' | 'error')` is what a started process does
//
// Both backend modules are imported inside the helper, so a scenario fails by itself while a module is
// missing. WP2 and WP3 import this file; a change to it goes through the WP1 owner.
import path from 'node:path';
import { withoutSecrets } from '../backend/config.mjs';
import { isSessionId } from '../backend/slack-watch-store.mjs';

export const FAKE_ID = 'fake';
export const FAKE_START_ID = 'fa4e0001';

export async function createFakeHarness({ without = [], overrides = {} } = {}) {
  const { createSessionLock } = await import('../backend/harness/session-lock.mjs');
  const { stateOf } = await import('../backend/harness/session-entry.mjs');
  const calls = [];
  const starts = [];
  const created = [];
  const world = { entries: [], child: 'ok', homeReadable: true };

  const startProcess = (args, options, session) => {
    starts.push({
      file: 'fake',
      args,
      options: { ...options, env: withoutSecrets(process.env) },
      session,
    });
    return world.child;
  };

  function createSessions(options) {
    created.push(options);
    const lock = createSessionLock();
    const record = (method, args) => calls.push({ method, args });
    const listed = () =>
      world.entries === null
        ? null
        : world.entries.filter((entry) => isSessionId(entry?.sessionId));
    const outcomeOf = (child, ok, timedOut, failed) =>
      child === 'ok' ? ok : child === 'timeout' ? timedOut : failed;
    return {
      async entries({ fresh = false } = {}) {
        record('entries', { fresh });
        const entries = listed();
        return entries && lock.overlay(entries);
      },
      async listSessions({ sortByActivity = true } = {}) {
        record('listSessions', { sortByActivity });
        const entries = listed();
        return entries
          ? {
              source: 'claude',
              sessions: entries.map((entry) => ({
                sessionId: entry.sessionId,
                state: stateOf(entry),
                name: entry.name,
                attached: false,
                activity: null,
              })),
            }
          : { source: 'map', sessions: [] };
      },
      async launch(args) {
        record('launch', args);
        const child = startProcess(['launch', args.name], { cwd: args.cwd }, true);
        return outcomeOf(
          child,
          { status: 'delivered', id: FAKE_START_ID },
          { status: 'failed-transient', reason: 'timed_out' },
          { status: 'failed-transient', reason: 'spawn_failed' },
        );
      },
      async stop(args) {
        record('stop', args);
        const entries = listed();
        if (!entries) return { status: 'failed-transient', reason: 'listing_unavailable' };
        const entry = entries.find((candidate) => candidate.sessionId === args.sessionId);
        if (!entry) return { status: 'not_listed' };
        if (entry.status !== 'idle') return { status: 'not_idle', activity: entry.status ?? null };
        const child = startProcess(['stop', entry.id], {}, false);
        return outcomeOf(
          child,
          { status: 'stopped' },
          { status: 'failed-transient', reason: 'timed_out' },
          { status: 'failed-transient', reason: 'stop_failed' },
        );
      },
      async resume(args) {
        record('resume', args);
        const entries = listed();
        if (!entries) return { status: 'failed-transient', reason: 'listing_unavailable' };
        const entry = entries.find((candidate) => candidate.sessionId === args.sessionId);
        if (!entry) return { status: 'delivered', reason: 'not_listed' };
        if (stateOf(entry) !== 'finished' || lock.isHeld(args.sessionId))
          return { status: 'waiting', reason: 'live_at_resume' };
        const release = lock.beginTurn(args.sessionId);
        const child = startProcess(['resume', args.sessionId], { cwd: entry.cwd }, true);
        release();
        return outcomeOf(
          child,
          { status: 'delivered', reason: 'resumed' },
          { status: 'failed-transient', reason: 'timed_out' },
          { status: 'failed-transient', reason: 'spawn_failed' },
        );
      },
      async lastActive() {
        return {};
      },
      async transcriptFile() {
        return null;
      },
      async transcriptFiles() {
        return [];
      },
      async recoverSessionIds() {
        return new Map();
      },
      beginTurn: lock.beginTurn,
      isHeld: lock.isHeld,
    };
  }

  const chat = {
    buildTurn: ({ sessionId, resuming, message }) => ({
      command: 'fake',
      args: ['chat', resuming ? '--resume' : '--new', sessionId],
      input: `${JSON.stringify({ say: message })}\n`,
    }),
    // One stdout line is JSON: `{ delta }`, `{ item }` or `{ done: true }` (sets the turn's outcome).
    liveMessages(line, turn) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      if (parsed?.done === true) {
        Object.assign(turn, {
          outcome: 'completed',
          reason: null,
          error: null,
          denials: [],
          costUsd: null,
        });
        return [];
      }
      if (typeof parsed?.delta === 'string')
        return [{ event: 'delta', data: { text: parsed.delta } }];
      if (parsed?.item) return [{ event: 'item', data: { item: parsed.item } }];
      return [];
    },
    // A transcript is one JSON `{ id, text }` per line; each is an assistant item.
    historyItems(text) {
      const items = text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .map(({ id, text: said }) => ({ id, kind: 'assistant', text: said }));
      return { items, truncated: false };
    },
  };

  const usage = {
    // `{ "fake_usage": { id, model, in, out } }` is a usage line; anything else is nothing.
    parseLine(line) {
      let parsed;
      try {
        parsed = JSON.parse(line)?.fake_usage;
      } catch {
        return null;
      }
      if (!parsed || typeof parsed.id !== 'string') return null;
      return {
        id: parsed.id,
        model: typeof parsed.model === 'string' ? parsed.model : null,
        tokens: {
          input: Number(parsed.in) || 0,
          output: Number(parsed.out) || 0,
          cacheRead: 0,
          cacheCreation: 0,
        },
      };
    },
  };

  const limits = {
    specReview: ({ launchDirectory }) => ({
      tools: ['read'],
      disallowedTools: ['write'],
      mcpConfig: path.join(launchDirectory, 'fake-mcp.json'),
    }),
  };

  const members = {
    id: FAKE_ID,
    label: 'Fake Agent',
    name: 'Fake',
    command: 'fake',
    // Distinct from Claude Code's own words, so a prompt that shows them was filled from this adapter.
    prompt: { skill: 'playbook', askTool: 'an ask-prompt hook' },
    createSessions,
    homeReadable: () => world.homeReadable,
    commands: {
      attach: (shortId) => `fake attach ${shortId}`,
      resume: (sessionId) => `fake resume ${sessionId}`,
    },
    ...(!without.includes('chat') && { chat }),
    ...(!without.includes('usage') && { usage }),
    ...(!without.includes('limits') && { limits }),
    ...overrides,
  };

  return {
    harness: Object.freeze(members),
    world,
    calls,
    starts,
    created,
    sessionCalls: (method) => calls.filter((call) => call.method === method),
    setEntries(entries) {
      world.entries = entries;
    },
    setChild(outcome) {
      world.child = outcome;
    },
    setHomeReadable(readable) {
      world.homeReadable = readable;
    },
  };
}
