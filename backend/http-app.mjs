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
import { getOriginDiff } from './diff.mjs';
import { fetchRelease } from './releases.mjs';
import { parseReleaseQuery } from './release-model.mjs';

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

export function createHttpHandler({ settings, manager, integrations = {} }) {
  const api = {
    fetchOpenPRs,
    fetchMyTickets,
    fetchTicketMetadata,
    fetchUatPromoteCandidates,
    enrichOpenPRs,
    getOriginDiff,
    fetchRelease,
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
          ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])
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
  handler.close = () => {
    unsubscribe?.();
    for (const res of clients) res.end();
    clients.clear();
    manager.onUpdate = null;
  };
  return handler;
}
