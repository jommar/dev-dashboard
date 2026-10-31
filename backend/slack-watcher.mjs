// slack-watcher.mjs — polls each watched Slack thread and appends one plain notice line to the
// inbox of every session attached to it when the newest message is somebody else's and new.
//
// Only keys, ids, timestamps and fixed reason codes are kept; no message text, name or error
// text is held, logged or returned. The watcher reads Slack and never writes to it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderNotice } from './slack-notice.mjs';
import { shouldWake } from './slack-model.mjs';

export const MAX_DELIVERY_ATTEMPTS = 3;
const CONCURRENT_READS = 3;
const LINES_PER_TICK = 20;
const PRUNE_INTERVAL_MS = 600_000;
const PRUNE_ABSENT_PASSES = 2;
const BACKOFF_FIRST_SECONDS = 60;
const BACKOFF_CEILING_SECONDS = 900;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const DISABLED_REASON = 'claude_home_unreadable';
const PER_LINK_FAILURES = new Set(['too_long', 'thread_unreadable']);

export function claudeHomeReadable(home = os.homedir()) {
  try {
    fs.accessSync(path.join(home, '.claude'), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function slackTsFromMs(milliseconds) {
  const micro = (milliseconds % 1000) * 1000;
  return `${Math.floor(milliseconds / 1000)}.${String(micro).padStart(6, '0')}`;
}

// A rate limit waits the delay Slack named; any other failure waits 60 seconds, doubling to a
// ceiling, until a read succeeds. The rate-limit block is kept apart so a success never clears it
// and a later block never shortens it.
function createBackoff() {
  let failures = 0;
  let failureBlockedUntilMs = 0;
  let rateLimitBlockedUntilMs = 0;
  return {
    isBlocked: (nowMs) => nowMs < Math.max(failureBlockedUntilMs, rateLimitBlockedUntilMs),
    rateLimited(nowMs, retryAfterSeconds) {
      const seconds =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds
          : DEFAULT_RETRY_AFTER_SECONDS;
      rateLimitBlockedUntilMs = Math.max(rateLimitBlockedUntilMs, nowMs + seconds * 1000);
    },
    failed(nowMs) {
      const seconds = Math.min(BACKOFF_FIRST_SECONDS * 2 ** failures, BACKOFF_CEILING_SECONDS);
      failures += 1;
      failureBlockedUntilMs = Math.max(failureBlockedUntilMs, nowMs + seconds * 1000);
    },
    succeeded() {
      failures = 0;
      failureBlockedUntilMs = 0;
    },
  };
}

const isSettled = (record) =>
  record?.status === 'delivered' || record?.status === 'failed-permanent';

export function createSlackWatcher({
  slack,
  store,
  settings,
  sessions,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  claudeHomeReadable: homeReadable = claudeHomeReadable,
}) {
  let started = false;
  let generation = 0;
  let timer = null;
  let ticking = false;
  let lastTickAt = null;
  let lastPruneAt = null;
  const globalBackoff = createBackoff();
  const linkBackoffs = new Map();
  const reads = new Map();
  const deliveries = new Map();
  const absentPasses = new Map();
  const seenListed = new Set();

  const watchSettings = () => settings.getPublicSettings().slackWatch;
  const isoNow = () => new Date(now()).toISOString();
  const isDisabled = () => !homeReadable();

  function clearTimer() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  async function onTimer() {
    timer = null;
    await tickOnce();
    if (started) arm();
  }

  function arm(delayMs = watchSettings().intervalSeconds * 1000) {
    clearTimer();
    if (!started || isDisabled()) return;
    timer = timers.setTimeout(onTimer, delayMs);
    timer.unref?.();
  }

  function start() {
    started = true;
    arm();
  }

  function stop() {
    started = false;
    generation += 1;
    clearTimer();
  }

  // A saved interval takes effect at once, measured from the last tick.
  function refreshSchedule() {
    const intervalMs = watchSettings().intervalSeconds * 1000;
    const elapsed = lastTickAt === null ? 0 : now() - lastTickAt;
    arm(Math.max(0, intervalMs - elapsed));
  }

  function state() {
    if (isDisabled()) return 'disabled';
    return watchSettings().paused ? 'paused' : 'running';
  }

  async function pause() {
    await settings.saveSlackWatch({ paused: true });
    refreshSchedule();
    return state();
  }

  async function resume() {
    await settings.saveSlackWatch({ paused: false });
    refreshSchedule();
    await tickOnce();
    return state();
  }

  function rememberListed(listing) {
    if (listing.source === 'claude')
      for (const { sessionId } of listing.sessions) seenListed.add(sessionId);
    return listing;
  }

  function lazyListing() {
    let listing;
    return () =>
      (listing ??= Promise.resolve()
        .then(() => sessions.listSessions())
        .catch(() => ({ source: 'map', sessions: [] }))
        .then(rememberListed));
  }

  async function pruneIfDue(listing, isCurrent) {
    if (lastPruneAt !== null && now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
    lastPruneAt = now();
    const { source, sessions: listed } = await listing();
    if (source !== 'claude') return;
    const listedIds = new Set(listed.map(({ sessionId }) => sessionId));
    const attachedIds = new Set(
      Object.values(store.snapshot().links).flatMap((entry) => entry.sessionIds),
    );
    for (const sessionId of absentPasses.keys())
      if (!attachedIds.has(sessionId)) absentPasses.delete(sessionId);
    for (const sessionId of attachedIds) {
      if (listedIds.has(sessionId)) {
        absentPasses.delete(sessionId);
        continue;
      }
      // An interactive session attached by manual id may never be listed.
      if (!seenListed.has(sessionId)) continue;
      const absent = (absentPasses.get(sessionId) ?? 0) + 1;
      if (absent < PRUNE_ABSENT_PASSES) {
        absentPasses.set(sessionId, absent);
        continue;
      }
      absentPasses.delete(sessionId);
      if (isCurrent()) await store.removeSession(sessionId);
    }
  }

  const isReadable = (key) =>
    !globalBackoff.isBlocked(now()) && !linkBackoffs.get(key)?.isBlocked(now());

  function recordRead(entry, result) {
    reads.set(entry.key, {
      lastCheckedAt: isoNow(),
      lastStatus: result.ok ? 'ok' : result.reason,
    });
    if (result.ok) {
      globalBackoff.succeeded();
      linkBackoffs.delete(entry.key);
    } else if (result.reason === 'rate_limited') {
      globalBackoff.rateLimited(now(), result.retryAfterSeconds);
    } else if (PER_LINK_FAILURES.has(result.reason)) {
      // One endless or unreadable thread must not slow every other link.
      if (!linkBackoffs.has(entry.key)) linkBackoffs.set(entry.key, createBackoff());
      linkBackoffs.get(entry.key).failed(now());
    } else {
      globalBackoff.failed(now());
    }
  }

  async function readLink(entry) {
    const asOfTs = entry.lastNotifiedTs ? undefined : slackTsFromMs(Date.parse(entry.baselineAt));
    let result;
    try {
      result = await slack.lastInThread({
        channelId: entry.channelId,
        threadTs: entry.threadTs,
        asOfTs,
      });
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    recordRead(entry, result);
    return result;
  }

  async function readDueLinks(entries, isCurrent) {
    const results = new Array(entries.length);
    let next = 0;
    const worker = async () => {
      while (next < entries.length && isCurrent()) {
        const index = next++;
        if (isReadable(entries[index].key)) results[index] = await readLink(entries[index]);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENT_READS }, worker));
    return results;
  }

  function recordOutcome(record, outcome) {
    const attempts = outcome.status === 'delivered' ? record.attempts : record.attempts + 1;
    const exhausted = outcome.status === 'failed-transient' && attempts >= MAX_DELIVERY_ATTEMPTS;
    Object.assign(record, {
      status: exhausted ? 'failed-permanent' : outcome.status,
      reason: outcome.reason ?? null,
      at: isoNow(),
      attempts,
    });
  }

  async function resumeSession(sessionId, notice) {
    try {
      return await sessions.resume({ sessionId, notice });
    } catch {
      return { status: 'failed-transient', reason: 'spawn_failed' };
    }
  }

  // A finished session is resumed at most once per tick: a second link woken in the same tick
  // shares the outcome, and its notice line is already in the inbox the resumed session reads.
  async function resumeIfFinished(sessionId, notice, tickState) {
    const { source, sessions: listedSessions } = await tickState.listing();
    if (source !== 'claude') return { status: 'failed-transient', reason: 'listing_unavailable' };
    const listed = listedSessions.find((session) => session.sessionId === sessionId);
    if (!listed) return { status: 'delivered', reason: 'not_listed' };
    if (listed.state !== 'finished') return { status: 'delivered' };
    if (!tickState.resumes.has(sessionId))
      tickState.resumes.set(sessionId, await resumeSession(sessionId, notice));
    return tickState.resumes.get(sessionId);
  }

  // The inbox line is written once per notice; a retry repeats only the step that failed.
  async function attemptDelivery(entry, sessionId, record, notice, tickState) {
    let outcome;
    if (!record.appended) {
      try {
        if (!store.snapshot().links[entry.key]?.sessionIds.includes(sessionId))
          throw new Error('detached');
        await store.append(sessionId, notice);
        record.appended = true;
        tickState.linesLeft -= 1;
      } catch {
        outcome = { status: 'failed-transient', reason: 'append_failed' };
      }
    }
    outcome ??= await resumeIfFinished(sessionId, notice, tickState);
    recordOutcome(record, outcome);
  }

  async function deliver(entry, noticeTs, tickState) {
    let delivery = deliveries.get(entry.key);
    if (delivery?.noticeTs !== noticeTs) {
      delivery = { noticeTs, bySession: new Map() };
      deliveries.set(entry.key, delivery);
    }
    const notice = renderNotice(tickState.noticeTemplate, entry.link);
    for (const sessionId of entry.sessionIds) {
      if (!tickState.isCurrent()) return;
      const record = delivery.bySession.get(sessionId) ?? {
        status: null,
        reason: null,
        at: null,
        attempts: 0,
        appended: false,
      };
      if (isSettled(record) || (!record.appended && tickState.linesLeft <= 0)) continue;
      delivery.bySession.set(sessionId, record);
      await attemptDelivery(entry, sessionId, record, notice, tickState);
    }
    const everyoneSettled = entry.sessionIds.every((id) => isSettled(delivery.bySession.get(id)));
    if (everyoneSettled && tickState.isCurrent())
      await store.setLastNotifiedTs(entry.key, noticeTs);
  }

  // A notice still being retried stays owed even if a bot or the user has posted since.
  function owedNoticeTs(key, cursor) {
    const noticeTs = deliveries.get(key)?.noticeTs;
    return noticeTs && noticeTs !== cursor ? noticeTs : null;
  }

  // A link whose last session left and a new one attached during the read has a new baseline the
  // read knows nothing about.
  const wasRebaselined = (read, current) =>
    current.baselineAt !== read.baselineAt ||
    (current.lastNotifiedTs === null && read.lastNotifiedTs !== null);

  async function handleRead(readEntry, result, tickState) {
    if (!result?.ok) return;
    const entry = store.snapshot().links[readEntry.key];
    if (!entry?.sessionIds.length || wasRebaselined(readEntry, entry)) return;
    let cursor = entry.lastNotifiedTs;
    if (cursor === null) {
      deliveries.delete(entry.key);
      if (result.asOf !== null) {
        cursor = result.asOf;
        await store.setLastNotifiedTs(entry.key, cursor);
      }
    }
    const noticeTs = shouldWake(result.last, result.me, cursor)
      ? result.last.ts
      : owedNoticeTs(entry.key, cursor);
    if (noticeTs) await deliver(entry, noticeTs, tickState);
  }

  async function runTick(isCurrent) {
    const tickState = {
      isCurrent,
      listing: lazyListing(),
      resumes: new Map(),
      linesLeft: LINES_PER_TICK,
      noticeTemplate: watchSettings().noticeTemplate,
    };
    const entries = Object.values(store.snapshot().links).filter(
      (entry) => entry.sessionIds.length > 0,
    );
    const results = await readDueLinks(entries, isCurrent);
    for (const [index, entry] of entries.entries()) {
      if (!isCurrent()) return;
      await handleRead(entry, results[index], tickState);
    }
    // After delivery, so a session about to be pruned still gets what this tick owes it.
    if (isCurrent()) await pruneIfDue(tickState.listing, isCurrent);
  }

  async function tickOnce() {
    if (ticking) return;
    ticking = true;
    const tickGeneration = generation;
    try {
      if (state() !== 'running') return;
      lastTickAt = now();
      await runTick(() => tickGeneration === generation);
    } catch {
      // A failed tick is retried by the next one; nothing may escape the timer callback.
    } finally {
      ticking = false;
    }
  }

  function list() {
    const reason = isDisabled() ? DISABLED_REASON : null;
    return {
      state: state(),
      ...(reason && { reason }),
      settings: { ...watchSettings() },
      links: Object.values(store.snapshot().links).map((entry) => {
        const read = reads.get(entry.key);
        const bySession = deliveries.get(entry.key)?.bySession;
        return {
          key: entry.key,
          link: entry.link,
          lastCheckedAt: read?.lastCheckedAt ?? null,
          lastStatus: read?.lastStatus ?? null,
          sessions: entry.sessionIds.map((sessionId) => {
            const record = bySession?.get(sessionId);
            return {
              sessionId,
              delivery: record?.status
                ? { status: record.status, reason: record.reason, at: record.at }
                : null,
            };
          }),
        };
      }),
    };
  }

  return {
    start,
    stop,
    refreshSchedule,
    tickOnce,
    pause,
    resume,
    list,
    isDisabled,
  };
}
