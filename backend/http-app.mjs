import { hasBuiltUi, serveBuiltUi, serveUi } from './static.mjs';
import { parseLines } from './log-lines.mjs';
import { DEFAULT_TAIL_LINES } from './config.mjs';
import { fetchOpenPRs, groupByTicket, filterPrsByTicketStatus } from './github.mjs';
import {
  fetchMyTickets,
  fetchTicketMetadata,
  CODE_REVIEW_STATUS,
  READY_FOR_CODE_REVIEW_STATUS,
} from './jira.mjs';
import { fetchUatPromoteCandidates } from './uat-promote.mjs';
import { enrichOpenPRs, filterPrsNeedingApprovals } from './review.mjs';
import { fetchTicketPrs } from './ticket-prs.mjs';
import { getOriginDiff } from './diff.mjs';
import { fetchRelease } from './releases.mjs';
import { parseReleaseQuery } from './release-model.mjs';
import { slackIntegration } from './slack.mjs';
import { parseSlackLink } from './slack-link.mjs';
import { withAttachedSessions } from './slack-model.mjs';
import { createSlackWatchStore, isSessionId } from './slack-watch-store.mjs';
import { createClaudeSessions } from './claude-sessions.mjs';
import { createClaudeLauncher } from './claude-launcher.mjs';
import { createSlackWatcher } from './slack-watcher.mjs';

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

export function createHttpHandler({ settings, manager, integrations = {} }) {
  const slack = integrations.slack || slackIntegration;
  const slackWatchStore = integrations.slackWatchStore || createSlackWatchStore();
  const claudeSessions =
    integrations.claudeSessions || createClaudeSessions({ store: slackWatchStore });
  const claudeLauncher = integrations.claudeLauncher || createClaudeLauncher({ claudeSessions });
  const slackWatcher =
    integrations.slackWatcher ||
    createSlackWatcher({ slack, store: slackWatchStore, settings, sessions: claudeSessions });
  const api = {
    fetchOpenPRs,
    fetchMyTickets,
    fetchTicketMetadata,
    fetchUatPromoteCandidates,
    enrichOpenPRs,
    getOriginDiff,
    fetchRelease,
    fetchTicketPrs,
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
    'GET /api/claude/tickets': () => claudeLauncher.list(),
    'POST /api/claude/launch': async (req) => {
      const { key, phase } = await readJson(req);
      return claudeLauncher.launch({ key, phase });
    },
    'POST /api/claude/answers': async (req) => {
      const { key, answers } = await readJson(req);
      return claudeLauncher.answer({ key, answers });
    },
  };
  const guard = () => {
    if (!settings.getSetupStatus().ready)
      throw Object.assign(new Error('Complete Settings setup.'), {
        code: 'SETUP_REQUIRED',
        status: 409,
      });
  };
  const handler = async function handler(req, res) {
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
      const tableRoute = slackWatchRoutes[routeKey] || claudeRoutes[routeKey];
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
      if (req.method === 'GET' && pathname === '/api/my-tickets') {
        const includeDone = ['1', 'true'].includes(url.searchParams.get('includeDone'));
        json(res, 200, {
          ...(await api.fetchMyTickets({ ...options, includeDone })),
          updatedAt: new Date().toISOString(),
        });
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
        const uatPromise = api.fetchUatPromoteCandidates(options);
        const approvalPromise = api.fetchOpenPRs({ ...options, mine: false }).catch(() => null);
        let data,
          prsAvailable = true;
        try {
          data = await api.fetchOpenPRs(options);
        } catch {
          prsAvailable = false;
          data = { prs: [], groups: {} };
        }
        const approvalData = await approvalPromise;
        const draftPrs = data.prs
          .filter((pr) => pr.draft)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        const draftGroups = groupByTicket(draftPrs);
        const keys = Object.keys(data.groups).filter((key) => key !== 'Unticketed');
        const { statuses: ticketStatuses, sprints: ticketSprints } = await api.fetchTicketMetadata(
          keys,
          options,
        );
        data.prs = filterPrsByTicketStatus(data.prs, ticketStatuses, CODE_REVIEW_STATUS);
        data.groups = groupByTicket(data.prs);
        const approvalKeys = approvalData
          ? Object.keys(approvalData.groups).filter((key) => key !== 'Unticketed')
          : [];
        const { statuses: approvalStatuses, sprints: approvalTicketSprints } =
          await api.fetchTicketMetadata(approvalKeys, options);
        const [approvalReviewData, reviewData, uatData] = await Promise.all([
          approvalData
            ? api.enrichOpenPRs(approvalData.prs, options)
            : { available: false, reviews: {} },
          prsAvailable ? api.enrichOpenPRs(data.prs, options) : { available: false, reviews: {} },
          uatPromise,
        ]);
        for (const pr of data.prs)
          pr.reviews = reviewData.reviews[`${pr.repo}#${pr.number}`] || null;
        const approvalThreshold = snapshot.minPrApprover;
        const prsNeedingApprovals = approvalReviewData.available
          ? filterPrsByTicketStatus(
              filterPrsNeedingApprovals(approvalData.prs, approvalThreshold),
              approvalStatuses,
              READY_FOR_CODE_REVIEW_STATUS,
            )
          : [];
        json(res, 200, {
          ...data,
          total: data.prs.length,
          prsAvailable,
          draftPrs,
          draftGroups,
          ticketStatuses,
          ticketSprints,
          approvalThreshold,
          reviewDataAvailable: approvalReviewData.available,
          prsNeedingApprovals,
          approvalGroups: approvalReviewData.available ? groupByTicket(prsNeedingApprovals) : {},
          approvalTicketStatuses: approvalStatuses,
          approvalTicketSprints,
          uatPromoteAvailable: uatData.available,
          uatPromoteGroups: uatData.groups,
          uatPromoteTotal: uatData.total,
        });
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
        'UNSAFE_CREDENTIAL',
        'BODY_TOO_LARGE',
        'INVALID_JSON',
        'INVALID_LINK',
        'INVALID_SESSION',
        'WATCH_DISABLED',
        'WATCH_PAUSED',
        'INVALID_TICKET',
        'INVALID_ANSWER',
        'CLAUDE_REFUSED',
        'CLAUDE_FAILED',
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
    unsubscribe?.();
    for (const res of clients) res.end();
    clients.clear();
    manager.onUpdate = null;
  };
  return handler;
}
