// slack-watcher.mjs — polls each watched Slack thread and appends one plain notice line to the
// inbox of every session attached to it when the newest message is somebody else's and new.
//
// A session that stays idle with the line unread is woken by the watcher itself: it is stopped a
// grace after the line and, after a settle gap, resumed under its own session id. Each step runs on
// its own timer; the poll tick advances a step that is overdue.
//
// Only keys, ids, timestamps and fixed reason codes are kept; no message text, name or error
// text is held, logged or returned. The watcher reads Slack and never writes to it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderNotice } from './slack-notice.mjs';
import { shouldWake } from './slack-model.mjs';

export const MAX_DELIVERY_ATTEMPTS = 3;
// Wall-clock time between a watcher stop and the resume that continues the same session; a resume
// sooner than this forks a copy under a new id.
export const SETTLE_MS = 90_000;
// How long an idle session has to read its line before the watcher stops it.
export const WAKE_GRACE_MS = 60_000;
// How long a wake waits for an idle session before it ends as never_idle.
export const WAKE_DEADLINE_MS = 2 * 60 * 60_000;
const CONCURRENT_READS = 3;
const LINES_PER_TICK = 20;
const PRUNE_INTERVAL_MS = 600_000;
const PRUNE_ABSENT_PASSES = 2;
const BACKOFF_FIRST_SECONDS = 60;
const BACKOFF_CEILING_SECONDS = 900;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const DISABLED_REASON = 'claude_home_unreadable';
const PER_LINK_FAILURES = new Set(['too_long', 'thread_unreadable']);
const WAITING_AWAITING = { status: 'waiting', reason: 'awaiting_wake' };
const WAITING_SETTLING = { status: 'waiting', reason: 'settling' };
const LISTING_UNAVAILABLE = { status: 'failed-transient', reason: 'listing_unavailable' };
const WAKE_STEPS = 3;
const NO_STEP = { step: null, steps: null, nextStepAt: null };

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

// A wait costs no attempt. Any other outcome that is not a success costs one, and a transient one
// that reaches the cap becomes permanent.
function countAttempt(attempts, outcome) {
  const reason = outcome.reason ?? null;
  if (outcome.status === 'delivered' || outcome.status === 'waiting')
    return { status: outcome.status, reason, attempts };
  const nextAttempts = attempts + 1;
  const exhausted = outcome.status === 'failed-transient' && nextAttempts >= MAX_DELIVERY_ATTEMPTS;
  return {
    status: exhausted ? 'failed-permanent' : outcome.status,
    reason,
    attempts: nextAttempts,
  };
}

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
  let pollDueAtMs = null;
  let ticking = false;
  let lastTickAt = null;
  let lastPruneAt = null;
  const builtAtMs = now();
  const globalBackoff = createBackoff();
  const linkBackoffs = new Map();
  const reads = new Map();
  const deliveries = new Map();
  const absentPasses = new Map();
  const seenListed = new Set();
  // One wake per session that owes a line and is listed live. It belongs to the session, not to a
  // link or a notice, so a session attached to two links is stopped and resumed once.
  const wakes = new Map();
  let queue = Promise.resolve();

  const watchSettings = () => settings.getPublicSettings().slackWatch;
  const isoAt = (milliseconds) => new Date(milliseconds).toISOString();
  const isoNow = () => isoAt(now());
  const isDisabled = () => !homeReadable();

  function clearTimer() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    pollDueAtMs = null;
  }

  async function onTimer() {
    timer = null;
    pollDueAtMs = null;
    await tickOnce();
    if (started) arm();
  }

  function arm(delayMs = watchSettings().intervalSeconds * 1000) {
    clearTimer();
    if (!started || isDisabled()) return;
    timer = timers.setTimeout(onTimer, delayMs);
    timer.unref?.();
    pollDueAtMs = now() + delayMs;
  }

  function start() {
    started = true;
    arm();
    for (const [sessionId, wake] of wakes) armStep(sessionId, wake);
  }

  function stop() {
    started = false;
    generation += 1;
    clearTimer();
    for (const wake of wakes.values()) clearStepTimer(wake);
  }

  // A saved interval takes effect at once, measured from the last tick.
  function refreshSchedule() {
    const intervalMs = watchSettings().intervalSeconds * 1000;
    const elapsed = lastTickAt === null ? 0 : now() - lastTickAt;
    arm(Math.max(0, intervalMs - elapsed));
  }

  // The time the armed poll fires. Null while a poll runs, while paused or disabled, and before start,
  // because the countdown means nothing then.
  function nextCheckAt() {
    return state() === 'running' && !ticking && pollDueAtMs !== null ? isoAt(pollDueAtMs) : null;
  }

  // One timed poll now, then the countdown restarts from it. A poll already running is never doubled,
  // and a paused or disabled watcher reads nothing.
  async function checkNow() {
    if (ticking || state() !== 'running') return { state: state(), checked: false };
    clearTimer();
    await tickOnce();
    arm();
    return { state: state(), checked: true };
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

  function attachedSessionIds() {
    return new Set(Object.values(store.snapshot().links).flatMap((entry) => entry.sessionIds));
  }

  async function pruneIfDue(listing, isCurrent) {
    if (lastPruneAt !== null && now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
    lastPruneAt = now();
    const { source, sessions: listed } = await listing();
    if (source !== 'claude') return;
    const listedIds = new Set(listed.map(({ sessionId }) => sessionId));
    const attachedIds = attachedSessionIds();
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
    Object.assign(record, countAttempt(record.attempts, outcome), { at: isoNow() });
  }

  // Every unsettled record of a session shows the wake's one outcome and one attempt count.
  function showWake(record, wake) {
    Object.assign(record, { ...wake.outcome, attempts: wake.attempts, at: isoNow() });
  }

  // Only a record whose line is in the inbox can carry the wake's outcome; a record whose append
  // failed keeps its own status until its line is written.
  function mirrorWake(sessionId, wake) {
    for (const delivery of deliveries.values()) {
      const record = delivery.bySession.get(sessionId);
      if (record?.appended && !isSettled(record)) showWake(record, wake);
    }
  }

  // A wake's stop falls a grace after its line, and its resume a settle gap after the stop.
  function stepDueAtMs(wake) {
    return wake.phase === 'stopped'
      ? wake.stoppedAtMs + SETTLE_MS
      : wake.appendedAtMs + WAKE_GRACE_MS;
  }

  function clearStepTimer(wake) {
    if (wake.timer !== null) timers.clearTimeout(wake.timer);
    wake.timer = null;
  }

  // A step already due gets no timer: the poll tick advances it. Arming replaces any earlier timer.
  function armStep(sessionId, wake) {
    clearStepTimer(wake);
    const delayMs = stepDueAtMs(wake) - now();
    if (!started || delayMs <= 0) return;
    wake.timer = timers.setTimeout(() => onStepTimer(sessionId, wake), delayMs);
    wake.timer.unref?.();
  }

  function forgetWake(sessionId) {
    const wake = wakes.get(sessionId);
    if (wake) clearStepTimer(wake);
    wakes.delete(sessionId);
  }

  // A delivered or permanent outcome ends the wake; a waiting or transient one leaves it open, and
  // its next step is timed from here.
  function setWakeOutcome(sessionId, wake, outcome) {
    const next = countAttempt(wake.attempts, outcome);
    wake.attempts = next.attempts;
    wake.outcome = { status: next.status, reason: next.reason };
    if (next.status === 'delivered' || next.status === 'failed-permanent') forgetWake(sessionId);
    else armStep(sessionId, wake);
    mirrorWake(sessionId, wake);
  }

  async function resumeSession(sessionId, notice) {
    try {
      return await sessions.resume({ sessionId, notice });
    } catch {
      return { status: 'failed-transient', reason: 'spawn_failed' };
    }
  }

  async function stopSession(sessionId) {
    try {
      return await sessions.stop({ sessionId });
    } catch {
      return { status: 'failed-transient', reason: 'stop_failed' };
    }
  }

  // A finished session is resumed at most once per tick: a second link woken in the same tick
  // shares the outcome, and its notice line is already in the inbox the resumed session reads.
  // Nothing resumes until the settle gap has passed since this watcher was built, because a session
  // stopped just before a restart is still inside its gap.
  async function resumeFinished(sessionId, notice, tickState) {
    if (now() - builtAtMs < SETTLE_MS) return WAITING_SETTLING;
    if (!tickState.resumes.has(sessionId))
      tickState.resumes.set(sessionId, await resumeSession(sessionId, notice));
    return tickState.resumes.get(sessionId);
  }

  // The outcome of a line that is in the inbox and has no wake yet. An idle or busy session opens
  // a wake, which later ticks advance.
  async function classify(sessionId, notice, record, tickState) {
    const { source, sessions: listedSessions } = await tickState.listing();
    if (source !== 'claude') return LISTING_UNAVAILABLE;
    const listed = listedSessions.find((session) => session.sessionId === sessionId);
    if (!listed) return { status: 'delivered', reason: 'not_listed' };
    if (listed.state === 'finished') return resumeFinished(sessionId, notice, tickState);
    if (listed.activity !== 'idle' && listed.activity !== 'busy')
      return { status: 'delivered', reason: 'inbox_only' };
    const wake = {
      phase: 'awaiting',
      notice,
      appendedAtMs: record.appendedAtMs,
      openedBy: tickState,
      idleSeen: listed.activity === 'idle',
      stoppedAtMs: null,
      attempts: 0,
      outcome: WAITING_AWAITING,
      timer: null,
    };
    wakes.set(sessionId, wake);
    armStep(sessionId, wake);
    return WAITING_AWAITING;
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
        record.appendedAtMs = now();
        tickState.linesLeft -= 1;
      } catch {
        outcome = { status: 'failed-transient', reason: 'append_failed' };
      }
    }
    if (outcome) recordOutcome(record, outcome);
    else if (wakes.has(sessionId)) showWake(record, wakes.get(sessionId));
    else recordOutcome(record, await classify(sessionId, notice, record, tickState));
  }

  // A link's cursor moves once every session of its current notice has a settled record.
  async function settleCursor(key, tickState) {
    const entry = store.snapshot().links[key];
    const delivery = deliveries.get(key);
    if (!entry || !delivery || entry.lastNotifiedTs === delivery.noticeTs) return;
    if (!tickState.isCurrent()) return;
    if (entry.sessionIds.every((id) => isSettled(delivery.bySession.get(id))))
      await store.setLastNotifiedTs(key, delivery.noticeTs);
  }

  // A wake can settle a link's notice after that link's read, so the cursor moves in the same tick.
  // An unset cursor belongs to a link being rebaselined, whose next read drops the stale notice.
  async function settleWakeCursors(sessionId, tickState) {
    for (const [key, delivery] of deliveries)
      if (delivery.bySession.has(sessionId) && store.snapshot().links[key]?.lastNotifiedTs !== null)
        await settleCursor(key, tickState);
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
        appendedAtMs: null,
      };
      if (isSettled(record) || (!record.appended && tickState.linesLeft <= 0)) continue;
      delivery.bySession.set(sessionId, record);
      await attemptDelivery(entry, sessionId, record, notice, tickState);
    }
    await settleCursor(entry.key, tickState);
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

  // A stop needs an idle session that has had the grace to wake by itself, on a tick after the one
  // that opened its wake, while the watcher is running and still current.
  function mayStop(wake, tickState) {
    return (
      wake.openedBy !== tickState &&
      now() - wake.appendedAtMs >= WAKE_GRACE_MS &&
      state() === 'running' &&
      tickState.isCurrent()
    );
  }

  async function stopWake(sessionId, wake) {
    const result = await stopSession(sessionId);
    if (result.status === 'stopped') {
      wake.phase = 'stopped';
      wake.stoppedAtMs = now();
      setWakeOutcome(sessionId, wake, WAITING_SETTLING);
    } else if (result.status === 'not_listed') {
      setWakeOutcome(sessionId, wake, { status: 'delivered', reason: 'not_listed' });
    } else if (result.status === 'not_idle') {
      // Busy since the listing: it woke by itself, and a later tick reports woke_itself.
      setWakeOutcome(sessionId, wake, WAITING_AWAITING);
    } else {
      setWakeOutcome(sessionId, wake, result);
    }
  }

  async function advanceAwaiting(sessionId, wake, tickState) {
    if (!attachedSessionIds().has(sessionId)) {
      forgetWake(sessionId);
      return;
    }
    if (now() - wake.appendedAtMs >= WAKE_DEADLINE_MS) {
      setWakeOutcome(sessionId, wake, { status: 'failed-permanent', reason: 'never_idle' });
      return;
    }
    const { source, sessions: listedSessions } = await tickState.listing();
    if (!tickState.isCurrent()) return;
    if (source !== 'claude') {
      setWakeOutcome(sessionId, wake, LISTING_UNAVAILABLE);
      return;
    }
    const listed = listedSessions.find((session) => session.sessionId === sessionId);
    if (!listed) {
      setWakeOutcome(sessionId, wake, { status: 'delivered', reason: 'not_listed' });
      return;
    }
    if (listed.state === 'finished') {
      // Finished without a stop by the watcher, so someone else stopped it; the gap starts now.
      wake.phase = 'stopped';
      wake.stoppedAtMs = now();
      setWakeOutcome(sessionId, wake, WAITING_SETTLING);
      return;
    }
    if (listed.activity === 'busy') {
      const outcome = wake.idleSeen
        ? { status: 'delivered', reason: 'woke_itself' }
        : WAITING_AWAITING;
      setWakeOutcome(sessionId, wake, outcome);
      return;
    }
    if (listed.activity !== 'idle') {
      setWakeOutcome(sessionId, wake, { status: 'delivered', reason: 'inbox_only' });
      return;
    }
    wake.idleSeen = true;
    if (mayStop(wake, tickState)) await stopWake(sessionId, wake);
    else setWakeOutcome(sessionId, wake, WAITING_AWAITING);
  }

  async function advanceStopped(sessionId, wake) {
    if (now() - wake.stoppedAtMs < SETTLE_MS) {
      setWakeOutcome(sessionId, wake, WAITING_SETTLING);
      return;
    }
    const result = await resumeSession(sessionId, wake.notice);
    if (result.status === 'waiting') {
      // Someone else woke the session during the gap, so the wake awaits it again.
      wake.phase = 'awaiting';
      setWakeOutcome(sessionId, wake, WAITING_AWAITING);
      return;
    }
    setWakeOutcome(sessionId, wake, result);
  }

  async function advanceWake(sessionId, wake, tickState, { resumeOnly }) {
    if (wake.phase === 'stopped') await advanceStopped(sessionId, wake);
    else if (!resumeOnly) await advanceAwaiting(sessionId, wake, tickState);
    await settleWakeCursors(sessionId, tickState);
  }

  // Runs after a tick's reads. A paused or unavailable watcher runs only the resume of a session it
  // already stopped, since the settle gap must still end.
  async function advanceWakes(tickState, { resumeOnly }) {
    for (const sessionId of [...wakes.keys()]) {
      const wake = wakes.get(sessionId);
      if (!wake) continue;
      if (!tickState.isCurrent()) return;
      await advanceWake(sessionId, wake, tickState, { resumeOnly });
    }
  }

  // A step's own timer. Firing early re-arms for the rest of the wait, and a wake replaced or
  // forgotten meanwhile is left alone.
  async function advanceDueStep(sessionId, wake, isCurrent) {
    if (wakes.get(sessionId) !== wake || !isCurrent()) return;
    if (stepDueAtMs(wake) > now()) {
      armStep(sessionId, wake);
      return;
    }
    const tickState = tickStateFor(isCurrent);
    await advanceWake(sessionId, wake, tickState, { resumeOnly: state() !== 'running' });
  }

  function onStepTimer(sessionId, wake) {
    wake.timer = null;
    const tickGeneration = generation;
    const isCurrent = () => tickGeneration === generation;
    return queued(async () => {
      try {
        await advanceDueStep(sessionId, wake, isCurrent);
      } catch {
        // As for a poll tick, the next pass retries; nothing may escape a timer callback.
      }
    });
  }

  function tickStateFor(isCurrent) {
    return {
      isCurrent,
      listing: lazyListing(),
      resumes: new Map(),
      linesLeft: LINES_PER_TICK,
      noticeTemplate: watchSettings().noticeTemplate,
    };
  }

  async function runTick(isCurrent) {
    const tickState = tickStateFor(isCurrent);
    const entries = Object.values(store.snapshot().links).filter(
      (entry) => entry.sessionIds.length > 0,
    );
    const results = await readDueLinks(entries, isCurrent);
    for (const [index, entry] of entries.entries()) {
      if (!isCurrent()) return;
      await handleRead(entry, results[index], tickState);
    }
    await advanceWakes(tickState, { resumeOnly: false });
    // After delivery, so a session about to be pruned still gets what this tick owes it.
    if (isCurrent()) await pruneIfDue(tickState.listing, isCurrent);
  }

  // Ticks and step passes take turns on one queue, so neither acts on a wake the other is advancing.
  function queued(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  async function runPollPass(isCurrent) {
    try {
      if (state() === 'running') {
        lastTickAt = now();
        await runTick(isCurrent);
      } else {
        await advanceWakes(tickStateFor(isCurrent), { resumeOnly: true });
      }
    } catch {
      // A failed tick is retried by the next one; nothing may escape the timer callback.
    }
  }

  async function tickOnce() {
    if (ticking) return;
    ticking = true;
    const tickGeneration = generation;
    const isCurrent = () => tickGeneration === generation;
    try {
      await queued(() => runPollPass(isCurrent));
    } finally {
      ticking = false;
    }
  }

  // A settling session has a wake that knows its stop time. One found finished after a restart has
  // none, and its resume waits out the gap from this watcher's start.
  function settleEndMs(sessionId) {
    return (wakes.get(sessionId)?.stoppedAtMs ?? builtAtMs) + SETTLE_MS;
  }

  // Which of a wake's three steps a delivery is on. Every other delivery has none.
  function stepOf(sessionId, record) {
    if (record.status === 'waiting' && record.reason === 'awaiting_wake')
      return { step: 1, steps: WAKE_STEPS, nextStepAt: isoAt(record.appendedAtMs + WAKE_GRACE_MS) };
    if (record.status === 'waiting' && record.reason === 'settling')
      return { step: 2, steps: WAKE_STEPS, nextStepAt: isoAt(settleEndMs(sessionId)) };
    if (record.status === 'delivered' && record.reason === 'resumed')
      return { step: 3, steps: WAKE_STEPS, nextStepAt: null };
    return NO_STEP;
  }

  function list() {
    const reason = isDisabled() ? DISABLED_REASON : null;
    return {
      state: state(),
      ...(reason && { reason }),
      nextCheckAt: nextCheckAt(),
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
                ? {
                    status: record.status,
                    reason: record.reason,
                    at: record.at,
                    ...stepOf(sessionId, record),
                  }
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
    checkNow,
    tickOnce,
    pause,
    resume,
    list,
    isDisabled,
  };
}
