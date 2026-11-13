import { hasBuiltUi, serveBuiltUi, serveUi } from './static.mjs';
import { parseLines } from './log-lines.mjs';
import { DEFAULT_TAIL_LINES } from './config.mjs';
import { fetchOpenPRs, PR_DISCOVERY_UNAVAILABLE, PR_DISCOVERY_INCOMPLETE } from './github.mjs';
import { fetchActiveSprintKeys, fetchMyTickets, fetchTicketMetadata } from './jira.mjs';
import { fetchUatPromoteCandidates } from './uat-promote.mjs';
import { enrichOpenPRs } from './review.mjs';
import { fetchPrDashboard } from './prs.mjs';
import { fetchTicketPrs } from './ticket-prs.mjs';
import { fetchReviewTickets } from './review-tickets.mjs';
import { fetchSpecReviews } from './spec-reviews.mjs';
import { fetchHomeVelocity } from './home-velocity.mjs';
import { getOriginDiff } from './diff.mjs';
import { listWorktrees } from './checkouts.mjs';
import { fetchRelease } from './releases.mjs';
import { parseReleaseQuery } from './release-model.mjs';
import { slackIntegration } from './slack.mjs';
import { parseSlackLink } from './slack-link.mjs';
import { withAttachedSessions } from './slack-model.mjs';
import { createSlackWatchStore, isSessionId } from './slack-watch-store.mjs';
import { createClaudeSessions } from './claude-sessions.mjs';
import { createClaudeLauncher, failed } from './claude-launcher.mjs';
import { createClaudeChat } from './claude-chat.mjs';
import { createClaudeArtifacts } from './claude-artifacts.mjs';
import { PROMPT_NAMES, createPromptStore } from './claude-prompts.mjs';
import { createSlackWatcher } from './slack-watcher.mjs';
import { createBrowserDevtools } from './browser-devtools.mjs';
import { createBrowserScreencast } from './browser-screencast.mjs';
import { createDevtoolsStreams } from './devtools-stream.mjs';

const MAX_LINKS_PER_REQUEST = 50;
// The `Sec-Fetch-Site` values of a request that another site's page made. A client that sends none
// (curl, older browsers) is not one.
const CROSS_SITE = ['cross-site', 'same-site'];

function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes <= 65536) chunks.push(chunk);
  }
  if (bytes > 65536)
    throw Object.assign(new Error('Request too large.'), { code: 'BODY_TOO_LARGE', status: 413 });
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error('Malformed JSON.'), { code: 'INVALID_JSON', status: 400 });
  }
}

// One query-string value of a request, or null when it is absent.
function queryParam(req, name) {
  return new URL(req.url, 'http://localhost').searchParams.get(name);
}

// Server-sent events on `res`, as a stream sink: `send(event, payload)` is false when the client is
// not keeping up. The headers go out with the first message, so a refused stream is still a JSON error.
function eventStreamSink(res) {
  return {
    send: (event, payload) => {
      if (!res.headersSent)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
      return res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    },
    end: () => res.end(),
  };
}

function httpError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

function parseLinkInput(input) {
  const parsed = parseSlackLink(input);
  if (parsed.reason) throw httpError('INVALID_LINK', 'Invalid Slack link.', 400);
  return parsed;
}

function requireSessionId(sessionId) {
  if (!isSessionId(sessionId)) throw httpError('INVALID_SESSION', 'Invalid session id.', 400);
}

function reviewSprint(sprint) {
  if (!sprint) return null;
  const { id, name, state, startDate, endDate } = sprint;
  return { id, name, state, startDate, endDate };
}

function reviewPr(pr) {
  const { repo, number, title, url, owner, draft, updatedAt } = pr;
  const { complete, state, approvers, changesRequesters, reviewDecision } = pr.review;
  return {
    repo,
    number,
    title,
    url,
    owner,
    draft,
    updatedAt,
    review: { complete, state, approvers, changesRequesters, reviewDecision },
  };
}

function reviewQueueResponse(data) {
  const { available, complete, repos, reasons } = data.prCoverage;
  const safeReasons = reasons.filter((reason) =>
    [PR_DISCOVERY_UNAVAILABLE, PR_DISCOVERY_INCOMPLETE].includes(reason),
  );
  return {
    total: data.total,
    tickets: data.tickets.map((ticket) => {
      const { key, summary, assignee, status, statusCategory, priority, updated, created } = ticket;
      return {
        key,
        summary,
        assignee,
        status,
        statusCategory,
        priority,
        updated,
        created,
        sprint: reviewSprint(ticket.sprint),
        sprints: ticket.sprints.map(reviewSprint),
        prs: ticket.prs.map(reviewPr),
      };
    }),
    prCoverage: {
      available,
      complete,
      repos,
      reasons: complete
        ? []
        : safeReasons.length
          ? safeReasons
          : [available ? PR_DISCOVERY_INCOMPLETE : PR_DISCOVERY_UNAVAILABLE],
    },
    updatedAt: new Date().toISOString(),
  };
}

// The Spec review feed with the fields the lane reads, and nothing else the feed holds.
function specReviewResponse(data) {
  return {
    available: data.available,
    total: data.total,
    specs: data.specs.map(
      ({ number, title, url, author, draft, keys, ageDays, reviewsByOthers, review }) => ({
        number,
        title,
        url,
        author,
        draft,
        keys,
        ageDays,
        reviewsByOthers,
        review,
      }),
    ),
    updatedAt: data.updatedAt,
  };
}

export function createHttpHandler({ settings, manager, integrations = {} }) {
  const slack = integrations.slack || slackIntegration;
  const slackWatchStore = integrations.slackWatchStore || createSlackWatchStore();
  const claudeSessions =
    integrations.claudeSessions || createClaudeSessions({ store: slackWatchStore });
  const claudePrompts = integrations.claudePrompts || createPromptStore();
  const claudeArtifacts = integrations.claudeArtifacts || createClaudeArtifacts();
  const claudeChat = integrations.claudeChat || createClaudeChat({ claudeSessions });
  const browserDevtools = integrations.browserDevtools || createBrowserDevtools();
  const claudeLauncher =
    integrations.claudeLauncher ||
    createClaudeLauncher({ claudeSessions, browsers: browserDevtools });
  const browserScreencast =
    integrations.browserScreencast || createBrowserScreencast({ devtools: browserDevtools });
  const devtoolsStreams =
    integrations.devtoolsStreams || createDevtoolsStreams({ screencast: browserScreencast });
  const slackWatcher =
    integrations.slackWatcher ||
    createSlackWatcher({ slack, store: slackWatchStore, settings, sessions: claudeSessions });
  const api = {
    fetchOpenPRs,
    fetchMyTickets,
    fetchTicketMetadata,
    fetchActiveSprintKeys,
    fetchUatPromoteCandidates,
    enrichOpenPRs,
    getOriginDiff,
    listWorktrees,
    fetchRelease,
    fetchTicketPrs,
    fetchReviewTickets,
    fetchSpecReviews,
    fetchHomeVelocity,
    ...integrations,
  };
  const clients = new Set();
  const broadcast = () => {
    if (!settings.getSetupStatus().ready) {
      for (const res of clients)
        res.end('event: setup-required\ndata: {"code":"SETUP_REQUIRED"}\n\n');
      clients.clear();
      return;
    }
    const data = `data: ${JSON.stringify(manager.list())}\n\n`;
    for (const res of clients) res.write(data);
  };
  manager.onUpdate = broadcast;
  const unsubscribe = settings.subscribe?.(broadcast);
  settings.bindLifecycle?.({
    run: manager.withSettingsLock ? (operation) => manager.withSettingsLock(operation) : undefined,
    check: manager.checkSettings ? (local) => manager.checkSettings(local) : undefined,
    apply: manager.reconcileSettings
      ? (local) => manager.reconcileSettings(local)
      : (local) => manager.applySettings(local),
  });
  const requireWatchEnabled = () => {
    if (slackWatcher.isDisabled())
      throw httpError('WATCH_DISABLED', 'Slack watching needs the Claude home directory.', 409);
  };
  // The watch store's links, for annotating thread rows. A disabled watcher, or a store that cannot
  // be read, leaves every row unattached: the threads route never fails because of the watch list.
  const attachedLinks = () => {
    try {
      return slackWatcher.isDisabled() ? {} : slackWatchStore.snapshot().links;
    } catch {
      return {};
    }
  };
  const slackWatchRoutes = {
    'GET /api/slack/watch': () => slackWatcher.list(),
    'GET /api/slack/watch/sessions': () => claudeSessions.listSessions(),
    'POST /api/slack/watch/links': async (req) => {
      const { links } = await readJson(req);
      requireWatchEnabled();
      if (!Array.isArray(links) || links.length > MAX_LINKS_PER_REQUEST)
        throw httpError('INVALID_LINK', 'Send at most 50 links.', 400);
      const results = [];
      for (const input of links) {
        const parsed = parseSlackLink(input);
        results.push(
          parsed.reason
            ? { input, ok: false, reason: parsed.reason }
            : { input, ok: true, key: parsed.key, ...(await slackWatchStore.addLink(parsed)) },
        );
      }
      return { results };
    },
    'POST /api/slack/watch/remove': async (req) => {
      const { link } = await readJson(req);
      requireWatchEnabled();
      const { key } = parseLinkInput(link);
      return { ok: true, ...(await slackWatchStore.removeLink(key)) };
    },
    'POST /api/slack/watch/attach': async (req) => {
      const { link, sessionId } = await readJson(req);
      requireWatchEnabled();
      const parsed = parseLinkInput(link);
      requireSessionId(sessionId);
      await slackWatchStore.addLink(parsed);
      const { inbox } = await slackWatchStore.attach(parsed.key, sessionId);
      return { ok: true, key: parsed.key, inbox };
    },
    'POST /api/slack/watch/detach': async (req) => {
      const { link, sessionId } = await readJson(req);
      const { key } = parseLinkInput(link);
      requireSessionId(sessionId);
      await slackWatchStore.detach(key, sessionId);
      return { ok: true };
    },
    'PUT /api/slack/watch/settings': async (req) => {
      const { intervalSeconds, noticeTemplate } = await readJson(req);
      const stored = await settings.saveSlackWatch({ intervalSeconds, noticeTemplate });
      slackWatcher.refreshSchedule();
      return { ok: true, settings: stored };
    },
    'POST /api/slack/watch/pause': async () => ({ ok: true, state: await slackWatcher.pause() }),
    'POST /api/slack/watch/resume': async () => ({ ok: true, state: await slackWatcher.resume() }),
    'POST /api/slack/watch/check': async () => {
      requireWatchEnabled();
      const { state, checked } = await slackWatcher.checkNow();
      if (state === 'paused') throw httpError('WATCH_PAUSED', 'Slack watching is paused.', 409);
      return { ok: true, state, checked };
    },
  };
  const claudeRoutes = {
    // The launcher's reply and, beside it, the standalone chats: one poll for the bar and the Chat screen.
    'GET /api/claude/tickets': async () => ({
      ...(await claudeLauncher.list()),
      chats: await claudeChat.list(),
    }),
    'POST /api/claude/launch': async (req) => {
      const { key, phase, pr, browserId } = await readJson(req);
      return claudeLauncher.launch({ key, phase, pr, browserId });
    },
    'POST /api/claude/answers': async (req) => {
      const { key, answers, resend } = await readJson(req);
      return claudeLauncher.answer({ key, answers, resend });
    },
    'POST /api/claude/approve': async (req) => {
      const { key } = await readJson(req);
      return claudeLauncher.approve({ key });
    },
    'POST /api/claude/rereview': async (req) => {
      const { key } = await readJson(req);
      return claudeLauncher.rereview({ key });
    },
    'GET /api/claude/prompts': () => ({ ok: true, prompts: claudePrompts.list() }),
    // The Markdown a ticket's sessions left: the list, and one file by name. Read-only.
    'GET /api/claude/artifacts': (req) => claudeArtifacts.list(queryParam(req, 'key')),
    'GET /api/claude/artifact': (req) =>
      claudeArtifacts.read(queryParam(req, 'key'), queryParam(req, 'name')),
    // The chat module validates the body, so nothing is read or started for a bad one.
    'POST /api/claude/chat/send': async (req) => {
      const { message, session } = await readJson(req);
      return claudeChat.send({ message, session });
    },
    'POST /api/claude/chat/stop': async (req) => {
      const { session } = await readJson(req);
      return claudeChat.stop({ session });
    },
  };
  // A prompt store call: its refusal of a bad text passes as it is, anything the disk does is a
  // failed Claude action.
  const promptCall = (operation) => {
    try {
      return { ok: true, prompt: operation() };
    } catch (error) {
      if (error.code === 'INVALID_PROMPT') throw error;
      throw failed('prompt_not_changed');
    }
  };
  // One route pair per known name, so nothing else in a path ever reaches the store.
  const promptRoutes = Object.fromEntries(
    PROMPT_NAMES.flatMap((name) => [
      [
        `PUT /api/claude/prompts/${name}`,
        async (req) => {
          const { text } = await readJson(req);
          return promptCall(() => claudePrompts.write(name, text));
        },
      ],
      [`DELETE /api/claude/prompts/${name}`, () => promptCall(() => claudePrompts.remove(name))],
    ]),
  );
  // The live view of every debug browser a dashboard tab watches, as ONE Server-Sent Events stream:
  // `hello` (the stream's id) first, then `frame`, `status`, `target` and `tabs` messages, each
  // tagged with the browser's `id`. Which browsers it carries is chosen by POST (subscribe,
  // unsubscribe). It is as sensitive as the signed-in sessions it shows, so another site's page may not
  // open one. A frame is dropped, never queued, while the client has not drained the last write.
  const openDevtoolsStream = (res) => {
    const handle = devtoolsStreams.open(eventStreamSink(res));
    res.on('drain', handle.drained);
    res.on('close', handle.close);
  };
  // The conversation of one Claude session: `hello` (the history and the turn in flight) first, then
  // `item`, `delta` and `state` messages. It carries what was said, so another site's page may not
  // open one. The module checks the session id and the stream cap before it sends anything.
  const openChatStream = async (res, session) => {
    let handle = null;
    let closed = false;
    res.on('drain', () => handle?.drained());
    res.on('close', () => {
      closed = true;
      handle?.close();
    });
    handle = await claudeChat.open({ session, sink: eventStreamSink(res) });
    // A client that went away while the history was read.
    if (closed) handle.close();
  };
  const guard = () => {
    if (!settings.getSetupStatus().ready)
      throw Object.assign(new Error('Complete Settings setup.'), {
        code: 'SETUP_REQUIRED',
        status: 409,
      });
  };
  const handler = async function handler(req, res) {
    // Every reply carries these, whichever path sends it: the dashboard may not be framed.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    try {
      const host = req.headers.host;
      let authority;
      try {
        authority = new URL(`http://${host}`);
        if (
          !host ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(authority.hostname) ||
          authority.host !== host ||
          authority.username ||
          authority.password
        )
          throw new Error();
        if (req.socket?.localPort && Number(authority.port || 80) !== req.socket.localPort)
          throw new Error();
      } catch {
        throw Object.assign(new Error('Invalid Host.'), { code: 'INVALID_HOST', status: 403 });
      }
      if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
        if (
          (req.headers.origin && req.headers.origin !== authority.origin) ||
          CROSS_SITE.includes(req.headers['sec-fetch-site'])
        )
          throw Object.assign(new Error('Invalid origin.'), {
            code: 'INVALID_ORIGIN',
            status: 403,
          });
        if (
          ['/api/settings', '/api/settings/validate'].includes(
            new URL(req.url, authority.origin).pathname,
          ) ||
          req.headers['content-type']
        ) {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
            throw Object.assign(new Error('JSON required.'), {
              code: 'UNSUPPORTED_CONTENT_TYPE',
              status: 415,
            });
        }
      }
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/assets/'))) {
        const served = serveBuiltUi(res, pathname);
        if (!served && !(pathname === '/' && !hasBuiltUi() && serveUi(res, 'index.html')))
          json(res, 404, { error: 'not found' });
        return;
      }
      if (req.method === 'GET' && pathname.startsWith('/ui/')) {
        if (!serveUi(res, pathname.slice(4))) json(res, 404, { error: 'not found' });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/config') {
        const publicSettings = settings.getPublicSettings();
        json(res, 200, {
          defaultTailLines: DEFAULT_TAIL_LINES,
          jiraBase: publicSettings.jira.baseUrl
            ? `${publicSettings.jira.baseUrl.replace(/\/+$/, '')}/browse/`
            : '',
          setup: settings.getSetupStatus(),
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/settings') {
        json(res, 200, settings.getPublicSettings());
        return;
      }
      if (req.method === 'PUT' && pathname === '/api/settings') {
        json(res, 200, await settings.save(await readJson(req)));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/settings/validate') {
        const input = await readJson(req);
        json(res, 200, await settings.validate({ expectedRevision: input.expectedRevision }));
        broadcast();
        return;
      }
      // Slack sits outside the setup gate on purpose: connecting, checking or
      // disconnecting it must never depend on GitHub/Jira setup, and every
      // response degrades to "not connected" instead of an error.
      if (req.method === 'GET' && pathname === '/api/slack/status') {
        json(res, 200, await slack.status());
        return;
      }
      if (req.method === 'GET' && pathname === '/api/slack/threads') {
        const continuation = url.searchParams.get('continuation');
        json(
          res,
          200,
          withAttachedSessions(
            await slack.threads(continuation ? { continuation } : undefined),
            attachedLinks(),
          ),
        );
        return;
      }
      if (req.method === 'GET' && pathname === '/api/slack/pending') {
        json(res, 200, await slack.pending());
        return;
      }
      // Opened from a ticket's Slack glyph; a missing `ts` is answered locally
      // rather than by asking Slack to look up nothing.
      if (req.method === 'GET' && pathname === '/api/slack/thread') {
        json(res, 200, await slack.thread(url.searchParams.get('ts')));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/slack/connect') {
        json(res, 200, slack.connect());
        return;
      }
      if (req.method === 'POST' && pathname === '/api/slack/disconnect') {
        json(res, 200, slack.disconnect());
        return;
      }
      // The watch routes need Slack and the host only, never GitHub or Jira setup; the Claude
      // routes need the claude CLI and this directory only.
      const routeKey = `${req.method} ${pathname}`;
      const devtoolsRoutes = {
        'GET /api/devtools/browsers': () =>
          browserDevtools.list().then((browsers) => ({ browsers })),
        'POST /api/devtools/browsers': async (request) => {
          const { label, url, headed } = await readJson(request);
          // headed goes through uncoerced (launch validates it), and only when posted.
          const options = { label, url, ...(headed !== undefined && { headed }) };
          return { ok: true, browser: await browserDevtools.launch(options) };
        },
        'POST /api/devtools/browsers/start': async (request) => {
          const { id } = await readJson(request);
          return { ok: true, browser: await browserDevtools.start(id) };
        },
        'POST /api/devtools/browsers/stop': async (request) => {
          const { id } = await readJson(request);
          return { ok: true, browser: await browserDevtools.stop(id) };
        },
        'POST /api/devtools/browsers/remove': async (request) => {
          const { id } = await readJson(request);
          return { ok: true, ...(await browserDevtools.remove(id)) };
        },
        // Which browsers the live view stream carries, and at what quality (tile or full).
        'POST /api/devtools/stream/subscribe': async (request) => {
          const { stream, id, quality } = await readJson(request);
          await devtoolsStreams.subscribe(stream, id, quality);
          return { ok: true };
        },
        'POST /api/devtools/stream/unsubscribe': async (request) => {
          const { stream, id } = await readJson(request);
          devtoolsStreams.unsubscribe(stream, id);
          return { ok: true };
        },
        // Mouse, wheel and key events for a viewed browser; the module whitelists every field.
        'POST /api/devtools/browsers/input': async (request) => {
          const { id, event, targetId } = await readJson(request);
          await browserScreencast.input(id, event, targetId);
          return { ok: true };
        },
        // Which tab the live view shows: a tab the browser reported, or null to follow the newest.
        'POST /api/devtools/browsers/tab': async (request) => {
          const { id, targetId } = await readJson(request);
          await browserScreencast.selectTab(id, targetId);
          return { ok: true };
        },
      };
      if (req.method === 'GET' && pathname === '/api/devtools/stream') {
        if (CROSS_SITE.includes(req.headers['sec-fetch-site']))
          throw httpError('INVALID_ORIGIN', 'Invalid origin.', 403);
        openDevtoolsStream(res);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/claude/chat/stream') {
        // Answered here, not thrown: a thrown `INVALID_ORIGIN` reads OPERATION_FAILED on the other
        // routes (it is not in the allow-list), and this stream's clients get the real code.
        if (CROSS_SITE.includes(req.headers['sec-fetch-site'])) {
          json(res, 403, { code: 'INVALID_ORIGIN', error: 'INVALID ORIGIN', errors: [] });
          return;
        }
        await openChatStream(res, url.searchParams.get('session'));
        return;
      }
      const tableRoute =
        devtoolsRoutes[routeKey] ||
        slackWatchRoutes[routeKey] ||
        claudeRoutes[routeKey] ||
        promptRoutes[routeKey];
      if (tableRoute) {
        json(res, 200, await tableRoute(req));
        return;
      }
      if (pathname.startsWith('/api/')) {
        await settings.refreshReadiness?.();
        guard();
      }
      const snapshot = settings.getSnapshot();
      const options = { snapshot };
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(manager.list())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/services') {
        json(res, 200, { services: manager.list() });
        return;
      }
      if (req.method === 'GET' && pathname.startsWith('/api/logs/')) {
        const tail = manager.logs(
          decodeURIComponent(pathname.slice(10)),
          parseLines(url.searchParams.get('lines'), DEFAULT_TAIL_LINES),
        );
        if (tail === null) {
          json(res, 404, { error: 'unknown service' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(tail);
        return;
      }
      const control = pathname.match(/^\/api\/services\/([^/]+)\/(start|stop|restart)$/);
      if (req.method === 'POST' && control) {
        const id = decodeURIComponent(control[1]);
        const action = control[2];
        const operation = async () => {
          guard();
          return manager[`${action}Unlocked`]
            ? manager[`${action}Unlocked`](id)
            : manager[action](id);
        };
        const result = await (manager.withSettingsLock
          ? manager.withSettingsLock(operation)
          : operation());
        broadcast();
        json(res, result.ok ? 200 : 400, result);
        return;
      }
      const repo = pathname.match(/^\/api\/repos\/([^/]+)\/(worktrees|checkout)$/);
      if (repo && req.method === (repo[2] === 'worktrees' ? 'GET' : 'PUT')) {
        const dir = decodeURIComponent(repo[1]);
        const groupOf = () => {
          const group = manager.checkoutGroup(dir);
          if (!group) throw httpError('UNKNOWN_REPO', 'Unknown repo.', 404);
          return group;
        };
        if (repo[2] === 'worktrees') {
          json(res, 200, { dir, worktrees: await api.listWorktrees(groupOf().main) });
          return;
        }
        groupOf();
        const { path: picked, restart } = await readJson(req);
        if (
          typeof picked !== 'string' ||
          picked === '' ||
          ![undefined, true, false].includes(restart)
        )
          throw httpError('INVALID_CHECKOUT', 'Invalid checkout.', 400);
        try {
          // The listing is read under the lock, so the repo cannot change between check and switch.
          const result = await manager.withSettingsLock(async () => {
            const chosen = (await api.listWorktrees(groupOf().main)).find(
              ({ path }) => path === picked,
            );
            if (!chosen) throw httpError('INVALID_CHECKOUT', 'Not a worktree of this repo.', 400);
            return manager.switchCheckoutUnlocked(dir, chosen.isMain ? null : chosen.path, {
              restart: restart === true,
            });
          });
          json(res, 200, { ok: true, dir, ...result });
        } finally {
          // A stop that timed out can leave members stopped, so the feed follows errors too.
          broadcast();
        }
        return;
      }
      if (req.method === 'GET' && pathname === '/api/my-tickets') {
        const includeDone = ['1', 'true'].includes(url.searchParams.get('includeDone'));
        json(res, 200, {
          ...(await api.fetchMyTickets({ ...options, includeDone })),
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      // Which of `?keys=A-1,B-2` are in a sprint Jira calls active: the bot bar's filter, asked on
      // every screen, so Jira is searched only for keys with no answer from the last few minutes.
      // Never fails the bar: an unavailable Jira is still a 200 with `available: false`.
      if (req.method === 'GET' && pathname === '/api/active-sprint-tickets') {
        if (CROSS_SITE.includes(req.headers['sec-fetch-site']))
          throw httpError('INVALID_ORIGIN', 'Invalid origin.', 403);
        const keys = (url.searchParams.get('keys') || '').split(',');
        json(res, 200, {
          ...(await api.fetchActiveSprintKeys(keys, options)),
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/team-velocity') {
        if (CROSS_SITE.includes(req.headers['sec-fetch-site']))
          throw httpError('INVALID_ORIGIN', 'Invalid origin.', 403);
        json(res, 200, await api.fetchHomeVelocity(options));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/review-tickets') {
        if (CROSS_SITE.includes(req.headers['sec-fetch-site']))
          throw httpError('INVALID_ORIGIN', 'Invalid origin.', 403);
        json(res, 200, reviewQueueResponse(await api.fetchReviewTickets(options)));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/spec-reviews') {
        if (CROSS_SITE.includes(req.headers['sec-fetch-site']))
          throw httpError('INVALID_ORIGIN', 'Invalid origin.', 403);
        json(res, 200, specReviewResponse(await api.fetchSpecReviews(options)));
        return;
      }
      // Never fails the board: an unavailable result is still a 200 the board can render. A load
      // costs many GitHub calls and is never cached, so another site's page may not trigger one.
      if (req.method === 'GET' && pathname === '/api/ticket-prs') {
        if (CROSS_SITE.includes(req.headers['sec-fetch-site']))
          throw httpError('INVALID_ORIGIN', 'Invalid origin.', 403);
        const { available, login, total, truncated, byTicket } = await api.fetchTicketPrs(options);
        json(res, 200, {
          available,
          login,
          total,
          truncated,
          byTicket,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/releases') {
        json(res, 200, {
          ...(await api.fetchRelease({ ...parseReleaseQuery(url.searchParams), snapshot })),
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/pr-diff') {
        json(
          res,
          200,
          await api.getOriginDiff(
            { repo: url.searchParams.get('repo'), number: url.searchParams.get('number') },
            undefined,
            options,
          ),
        );
        return;
      }
      if (req.method === 'GET' && pathname === '/api/prs') {
        json(res, 200, await fetchPrDashboard(options, api));
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      const allowed = [
        'SETUP_REQUIRED',
        'REVISION_CONFLICT',
        'SERVICE_IN_USE',
        'INVALID_SETTINGS',
        'VALIDATION_FAILED',
        'VALIDATION_UNAVAILABLE',
        'PERSISTENCE_FAILED',
        'UNKNOWN_REPO',
        'INVALID_CHECKOUT',
        'CHECKOUT_IN_USE',
        'CHECKOUT_UNUSABLE',
        'WORKTREES_UNAVAILABLE',
        'UNSAFE_CREDENTIAL',
        'BODY_TOO_LARGE',
        'INVALID_JSON',
        'INVALID_LINK',
        'INVALID_SESSION',
        'INVALID_MESSAGE',
        'WATCH_DISABLED',
        'WATCH_PAUSED',
        'INVALID_TICKET',
        'INVALID_ANSWER',
        'INVALID_PROMPT',
        'INVALID_ARTIFACT',
        'ARTIFACT_NOT_FOUND',
        'ARTIFACT_TOO_LARGE',
        'CLAUDE_REFUSED',
        'CLAUDE_FAILED',
        'UNKNOWN_BROWSER',
        'NO_FREE_PORT',
        'BROWSER_NOT_FOUND',
        'LAUNCH_FAILED',
        'INVALID_URL',
        'INVALID_HEADED',
        'BROWSER_NOT_RUNNING',
        'SCREENCAST_NOT_ACTIVE',
        'INVALID_INPUT',
        'INVALID_TAB',
        'UNKNOWN_TAB',
        'TAB_CHANGED',
        'INVALID_STREAM',
        'UNKNOWN_STREAM',
        'INVALID_QUALITY',
        'TOO_MANY_STREAMS',
        'TOO_MANY_SUBSCRIPTIONS',
      ];
      const code = allowed.includes(error.code) ? error.code : 'OPERATION_FAILED';
      const conflict = ['SETUP_REQUIRED', 'REVISION_CONFLICT', 'SERVICE_IN_USE'].includes(code);
      json(
        res,
        conflict
          ? 409
          : Number.isInteger(error.status)
            ? error.status
            : Number.isInteger(error.statusHint)
              ? error.statusHint
              : 502,
        {
          code,
          error: code === 'SETUP_REQUIRED' ? 'Complete Settings setup.' : code.replaceAll('_', ' '),
          errors: allowed.includes(error.code) ? error.errors || [] : [],
          ...(code === 'SETUP_REQUIRED' ? { setup: settings.getSetupStatus() } : {}),
        },
      );
    }
  };
  handler.slackWatcher = slackWatcher;
  handler.close = () => {
    slackWatcher.stop();
    claudeChat.close();
    devtoolsStreams.close();
    browserScreencast.close?.();
    unsubscribe?.();
    for (const res of clients) res.end();
    clients.clear();
    manager.onUpdate = null;
  };
  return handler;
}
