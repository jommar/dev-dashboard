// Bounded discovery for the shared Slack lists. The independent watcher does
// not use this module or its age limit.
import { randomUUID } from 'node:crypto';
import { eligibleSlackRoot, SLACK_WINDOW_MS } from '../ui/slack-activity.js';
import {
  applyLastReply,
  buildThread,
  compareSlackTs,
  mentionedUserIds,
  sortByActivity,
  validSlackTs,
} from './slack-model.mjs';

const WINDOW_MS = SLACK_WINDOW_MS;
const HISTORY_PAGES = 3;
const SEARCH_PAGES = 2;
const REPLY_PAGES = 2;
const SCAN_BUDGET = 40;
const CONCURRENCY = 5;
const CONTINUATION_TTL_MS = 10 * 60 * 1000;
const CONTINUATION_LIMIT = 10;
const UNVERIFIED_IDENTITY = Symbol('unverified identity');
const REJECTED_SESSION_ERRORS = new Set(['invalid_auth', 'token_revoked']);
const UNREADABLE_REPLY_ERRORS = new Set([
  'thread_not_found',
  'channel_not_found',
  'not_in_channel',
  'missing_scope',
  'invalid_auth',
  'token_revoked',
]);

function timestamp(ms) {
  const micros = BigInt(Math.trunc(ms)) * 1000n;
  return `${micros / 1000000n}.${String(micros % 1000000n).padStart(6, '0')}`;
}

export const eligibleRoot = eligibleSlackRoot;

// A search message's own ts is not evidence that it is the root. A root
// independently seen in bounded history is the sole exception.
function searchRoot(match, channelId, roots) {
  if (!validSlackTs(match?.ts) || match?.channel?.id !== channelId) return '';
  const signals = [];
  if (match.thread_ts !== undefined) {
    if (!validSlackTs(match.thread_ts)) return '';
    signals.push(match.thread_ts);
  }
  if (match.permalink !== undefined) {
    try {
      const url = new URL(match.permalink);
      const parts = url.pathname.split('/');
      const [seconds, fraction] = match.ts.split('.');
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !(url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')) ||
        parts.length !== 4 ||
        parts[1] !== 'archives' ||
        parts[2] !== channelId ||
        parts[3] !== `p${seconds}${fraction.padEnd(6, '0')}`
      )
        return '';
      if (url.searchParams.has('cid') && url.searchParams.get('cid') !== channelId) return '';
      if (url.searchParams.has('thread_ts')) {
        const ts = url.searchParams.get('thread_ts');
        if (!validSlackTs(ts)) return '';
        signals.push(ts);
      }
    } catch {
      return '';
    }
  }
  if (!signals.length && roots.get(match.ts)?.root) signals.push(match.ts);
  if (!signals.length || signals.some((ts) => compareSlackTs(ts, signals[0]) !== 0)) return '';
  return compareSlackTs(signals[0], match.ts) <= 0 ? signals[0] : '';
}

export function createSlackBoard({
  call,
  session,
  verify,
  channel,
  users,
  now,
  isCurrent,
  generation,
}) {
  let cache = null;
  let cold = null;
  let refreshing = null;
  let retryAt = 0;
  let failedRefresh = null;
  let version = 0;
  let replyEpoch = 0;
  const continuations = new Map();

  function clear() {
    version++;
    cache = null;
    cold = null;
    refreshing = null;
    retryAt = 0;
    failedRefresh = null;
    replyEpoch++;
    continuations.clear();
  }

  const current = (state) => isCurrent(state.gen);
  const eligible = (ts) => eligibleRoot(ts, now());
  const reason = (state, text) => state.reasons.add(text);

  // Snapshots may share the same verified reply while an older scan is still
  // in flight. Revoking its evidence also revokes every copied fallback.
  const trustedReply = (evidence) => evidence && evidence.valid && evidence.epoch === replyEpoch;
  function invalidateReply(item) {
    if (item.lastGood) item.lastGood.valid = false;
    if (item.verifiedReply) item.verifiedReply.valid = false;
    item.lastGood = null;
  }

  function candidate(state, ts) {
    if (!state.candidates.has(ts))
      state.candidates.set(ts, {
        ts,
        root: null,
        mention: null,
        observed: ts,
        cursor: '',
        done: false,
      });
    return state.candidates.get(ts);
  }

  function setRoot(item, root) {
    if (
      item.root &&
      (item.root.latest_reply !== root.latest_reply || item.root.reply_count !== root.reply_count)
    ) {
      if (conflictingRootMetadata(item.root, root)) invalidateReply(item);
      item.cursor = '';
      item.done = false;
      item.last = null;
      item.latestUnverified = false;
      item.scanComplete = false;
      item.invalidReply = false;
      item.replyPaginationConflict = false;
      item.replyUnreadable = false;
      item.replyFailed = false;
      item.replyRootConflict = false;
      item.lastGood = null;
      item.verifiedReply = null;
      item.replyEpoch = null;
    }
    item.root = root;
  }

  function observe(item, message, me) {
    if (compareSlackTs(message.ts, item.observed) > 0) item.observed = message.ts;
    if (
      mentionedUserIds([message.text]).includes(me) &&
      (!item.mention || compareSlackTs(message.ts, item.mention.ts) > 0)
    )
      item.mention = message;
  }

  async function history(state, credentials) {
    if (state.history.done) return;
    for (let page = 0; page < HISTORY_PAGES && !state.history.done; page++) {
      if (!current(state)) return;
      const oldest = timestamp(now() - WINDOW_MS);
      let payload;
      try {
        payload = await call(
          'conversations.history',
          {
            channel: state.target.id,
            limit: 200,
            oldest,
            inclusive: true,
            ...(state.history.cursor ? { cursor: state.history.cursor } : {}),
          },
          credentials,
        );
        if (!payload?.ok || !Array.isArray(payload.messages))
          throw new Error('history unavailable');
      } catch {
        state.history.failed = true;
        reason(state, 'history_unavailable');
        return;
      }
      if (!current(state)) return;
      state.history.failed = false;
      state.reasons.delete('history_unavailable');
      let invalid = false;
      for (const message of payload.messages) {
        if (
          !validSlackTs(message?.ts) ||
          compareSlackTs(message.ts, oldest) < 0 ||
          compareSlackTs(message.ts, timestamp(now())) > 0
        ) {
          invalid = true;
          continue;
        }
        if (!eligible(message.ts)) continue;
        if (message.thread_ts !== message.ts) {
          const knownReply =
            validSlackTs(message.thread_ts) && compareSlackTs(message.thread_ts, message.ts) < 0;
          if (!knownReply && mentionedUserIds([message.text]).includes(state.me))
            reason(state, 'ambiguous_history_mention');
          continue;
        }
        const item = candidate(state, message.ts);
        setRoot(item, message);
        observe(item, message, state.me);
      }
      if (invalid) {
        reason(state, 'history_out_of_range');
        state.truncated = true;
        state.history.done = true;
        return;
      }
      state.history.cursor = payload.response_metadata?.next_cursor || '';
      if (!state.history.cursor) {
        state.history.done = true;
        if (payload.has_more) {
          reason(state, 'history_missing_cursor');
          state.truncated = true;
        }
      }
    }
  }

  async function search(state, credentials, stream) {
    if (stream.done) return;
    for (let count = 0; count < SEARCH_PAGES && !stream.done; count++) {
      if (!current(state)) return;
      let payload;
      try {
        payload = await call(
          'search.messages',
          {
            query: `in:${state.target.name} ${stream.mentions ? `<@${state.me}> ` : ''}after:${new Date(now() - WINDOW_MS).toISOString().slice(0, 10)}`,
            count: 100,
            page: stream.page,
            sort: 'timestamp',
            sort_dir: 'desc',
          },
          credentials,
        );
        if (!payload?.ok || !Array.isArray(payload.messages?.matches))
          throw new Error('search unavailable');
      } catch {
        stream.failed = true;
        reason(state, 'search_unavailable');
        return;
      }
      if (!current(state)) return;
      stream.failed = false;
      if (!state.searchAll.failed && !state.searchMentions.failed)
        state.reasons.delete('search_unavailable');
      for (const match of payload.messages.matches) {
        const ts = searchRoot(match, state.target.id, state.candidates);
        if (!ts) {
          reason(state, 'ambiguous_search_result');
          continue;
        }
        // An older root found by a recent message is discarded before any
        // targeted request. A future message is likewise not reliable.
        if (!eligible(ts)) continue;
        if (compareSlackTs(match.ts, timestamp(now())) > 0) {
          reason(state, 'invalid_search_timestamp');
          continue;
        }
        observe(candidate(state, ts), match, state.me);
      }
      const paging = payload.messages.paging;
      const pages = Number(paging?.pages) || Math.ceil((Number(payload.messages.total) || 0) / 100);
      if (stream.page >= 100 && pages > stream.page) {
        reason(state, 'search_page_limit');
        state.truncated = true;
      }
      if (stream.page >= pages || stream.page >= 100) stream.done = true;
      else stream.page++;
    }
  }

  async function resolveRoots(state, credentials, limit) {
    let remaining = limit;
    const queue = [...state.candidates.values()].filter((item) => !item.root && eligible(item.ts));
    const start = queue.length ? state.resolveOffset % queue.length : 0;
    const selected = Math.min(queue.length, remaining);
    state.resolveOffset = start + selected;
    for (let index = 0; index < selected; index++) {
      if (!current(state)) break;
      const item = queue[(start + index) % queue.length];
      remaining--;
      try {
        if (!eligible(item.ts)) continue;
        const payload = await call(
          'conversations.replies',
          {
            channel: state.target.id,
            ts: item.ts,
            limit: 1,
          },
          credentials,
        );
        if (!current(state) || !eligible(item.ts)) continue;
        const root = payload?.ok && payload.messages?.[0]?.ts === item.ts && payload.messages[0];
        if (!root || (root.thread_ts && root.thread_ts !== item.ts))
          throw new Error('root unavailable');
        setRoot(item, root);
        if (
          root.reply_count === 0 &&
          (payload.has_more || payload.response_metadata?.next_cursor)
        ) {
          item.replyPaginationConflict = true;
          reason(state, 'root_reply_count_inconsistent');
        }
        observe(item, root, state.me);
      } catch {
        reason(state, 'root_unavailable');
      }
    }
    return remaining;
  }

  function pendingWork(state) {
    return (
      !state.history.done ||
      !state.searchAll.done ||
      !state.searchMentions.done ||
      [...state.candidates.values()].some((item) => eligible(item.ts) && (!item.root || !item.done))
    );
  }

  function validActivityMetadata(item) {
    const root = item.root;
    const latest = root.reply_count ? root.latest_reply : root.ts;
    return (
      Number.isSafeInteger(root.reply_count) &&
      root.reply_count >= 0 &&
      !(root.reply_count === 0 && root.latest_reply) &&
      !item.replyPaginationConflict &&
      !item.replyRootConflict &&
      validSlackTs(latest) &&
      !item.latestUnverified &&
      compareSlackTs(latest, root.ts) >= 0 &&
      (!root.reply_count || compareSlackTs(latest, root.ts) > 0) &&
      compareSlackTs(latest, timestamp(now())) <= 0 &&
      compareSlackTs(item.observed, latest) <= 0
    );
  }

  function preserveVerifiedReplies(previous, next) {
    if (
      !previous ||
      previous.gen !== next.gen ||
      previous.me !== next.me ||
      previous.teamId !== next.teamId ||
      previous.target.id !== next.target.id
    )
      return;
    for (const [ts, item] of next.candidates) {
      const prior = previous.candidates.get(ts);
      if (
        !item.root ||
        !prior?.root ||
        !eligible(ts) ||
        prior.root.ts !== item.root.ts ||
        prior.root.reply_count !== item.root.reply_count ||
        !prior.root.reply_count ||
        prior.invalidReply ||
        prior.replyUnreadable ||
        item.replyUnreadable ||
        item.replyRootConflict ||
        !validActivityMetadata(prior) ||
        !validSlackTs(item.root.latest_reply) ||
        compareSlackTs(prior.root.latest_reply, item.root.latest_reply) !== 0
      )
        continue;
      const evidence = prior.scanComplete ? prior.verifiedReply : prior.lastGood;
      const last = trustedReply(evidence) && evidence.message;
      if (
        validSlackTs(last?.ts) &&
        compareSlackTs(last.ts, prior.root.latest_reply) === 0 &&
        (!item.last || item.last.user === last.user)
      )
        item.lastGood = evidence;
    }
  }

  function render(state) {
    const started = [];
    const mentions = [];
    let reusedActivity = false;
    for (const item of state.candidates.values()) {
      const root = item.root;
      if (!root || !eligible(item.ts)) continue;
      const latest = root.reply_count ? root.latest_reply : root.ts;
      const metadataValid = validActivityMetadata(item);
      const validActivity =
        metadataValid &&
        (root.reply_count === 0 ||
          (item.scanComplete && item.last && compareSlackTs(item.last.ts, latest) === 0));
      const fallback =
        !validActivity &&
        metadataValid &&
        !item.scanComplete &&
        !item.invalidReply &&
        !item.replyUnreadable &&
        trustedReply(item.lastGood) &&
        item.lastGood.message;
      if (!metadataValid || (item.done && !validActivity)) reason(state, 'activity_unavailable');
      const makeRow = (mention) => {
        const row = buildThread({
          root,
          mention,
          channelId: state.target.id,
          teamId: state.teamId,
          me: state.me,
          users: state.names,
        });
        if (!validActivity && !fallback) {
          row.activityAt = '';
          row.activityTs = null;
        } else if (validActivity && item.last && compareSlackTs(item.last.ts, latest) === 0) {
          applyLastReply(row, item.last, state.me, state.names);
        } else if (fallback) {
          reusedActivity = true;
          applyLastReply(row, fallback, state.me, state.names);
        }
        return row;
      };
      if (root.user === state.me) started.push(makeRow());
      if (item.mention) mentions.push(makeRow(item.mention));
    }
    const pending = pendingWork(state);
    const expired = now() - state.created > CONTINUATION_TTL_MS;
    const reasons = [...state.reasons];
    if ([...state.candidates.values()].some((item) => eligible(item.ts) && item.replyFailed))
      reasons.push('reply_unavailable');
    if (reusedActivity) reasons.push('reply_activity_stale');
    if (pending) reasons.push('bounded_work_remaining');
    if (pending && expired) reasons.push('continuation_expired');
    if (pending && !expired && !state.token) {
      state.token = randomUUID();
      if (continuations.size >= CONTINUATION_LIMIT)
        continuations.delete(continuations.keys().next().value);
      continuations.set(state.token, state);
    }
    if ((!pending || expired) && state.token) {
      continuations.delete(state.token);
      state.token = null;
    }
    Object.assign(state.value, {
      started: sortByActivity(started),
      mentions: sortByActivity(mentions),
      partial: Boolean(reasons.length),
      partialReasons: reasons,
      truncated: pending || state.truncated,
      continuation: state.token || null,
    });
  }

  function conflictingRootMetadata(root, message) {
    return (
      (Number.isSafeInteger(message.reply_count) &&
        message.reply_count >= 0 &&
        message.reply_count !== root.reply_count) ||
      (validSlackTs(message.latest_reply) &&
        validSlackTs(root.latest_reply) &&
        compareSlackTs(message.latest_reply, root.latest_reply) !== 0)
    );
  }

  async function scan(state, credentials, budget) {
    const queue = [...state.candidates.values()].filter(
      (item) => item.root && eligible(item.ts) && !item.done,
    );
    const start = queue.length ? state.scanOffset % queue.length : 0;
    const count = Math.min(queue.length, budget);
    const selected = Array.from(
      { length: count },
      (_, index) => queue[(start + index) % queue.length],
    );
    state.scanOffset = start + count;
    let networkProgress = false;
    let blockedReads = false;
    const worker = async () => {
      while (selected.length && current(state)) {
        const item = selected.shift();
        if (!eligible(item.ts)) continue;
        if (
          !Number.isSafeInteger(item.root.reply_count) ||
          item.root.reply_count < 0 ||
          (item.root.reply_count === 0 && item.root.latest_reply)
        ) {
          reason(state, 'reply_count_unavailable');
          item.done = true;
          continue;
        }
        if (item.root.reply_count === 0 && !item.replyPaginationConflict) {
          item.last = item.root;
          item.done = true;
          item.scanComplete = true;
          item.replyFailed = false;
          continue;
        }
        if (!item.cursor) item.replyEpoch = replyEpoch;
        for (let page = 0; page < REPLY_PAGES && !item.done; page++) {
          if (!eligible(item.ts) || !current(state)) break;
          try {
            const payload = await call(
              'conversations.replies',
              {
                channel: state.target.id,
                ts: item.ts,
                limit: 200,
                ...(item.cursor ? { cursor: item.cursor } : {}),
              },
              credentials,
            );
            networkProgress = true;
            if (!current(state) || !eligible(item.ts)) break;
            if (!payload?.ok || !Array.isArray(payload.messages)) {
              if (UNREADABLE_REPLY_ERRORS.has(payload?.error)) {
                item.replyUnreadable = true;
                invalidateReply(item);
                if (REJECTED_SESSION_ERRORS.has(payload.error)) replyEpoch++;
              }
              throw new Error('reply unavailable');
            }
            item.replyUnreadable = false;
            item.replyFailed = false;
            for (const message of payload.messages) {
              if (
                !validSlackTs(message?.ts) ||
                compareSlackTs(message.ts, item.ts) < 0 ||
                compareSlackTs(message.ts, timestamp(now())) > 0 ||
                (message.thread_ts && message.thread_ts !== item.ts)
              ) {
                reason(state, 'invalid_reply');
                item.invalidReply = true;
                invalidateReply(item);
                continue;
              }
              if (
                compareSlackTs(message.ts, item.ts) === 0 &&
                conflictingRootMetadata(item.root, message)
              ) {
                item.replyRootConflict = true;
                invalidateReply(item);
                reason(state, 'reply_root_metadata_conflict');
              }
              observe(item, message, state.me);
              if (
                validSlackTs(item.root.latest_reply) &&
                compareSlackTs(message.ts, item.root.latest_reply) === 0
              ) {
                item.last = message;
                if (item.lastGood && message.user !== item.lastGood.message.user)
                  invalidateReply(item);
              }
            }
            item.cursor = payload.response_metadata?.next_cursor || '';
            if (!item.cursor) {
              item.done = true;
              item.scanComplete = !payload.has_more && !item.invalidReply;
              if (item.scanComplete && item.last)
                item.verifiedReply = { message: item.last, valid: true, epoch: item.replyEpoch };
              if (payload.has_more) {
                reason(state, 'reply_missing_cursor');
                state.truncated = true;
              }
              if (validSlackTs(item.root.latest_reply) && !item.last) {
                item.latestUnverified = true;
                reason(state, 'latest_reply_unverified');
              }
            }
          } catch (error) {
            if (error?.message === 'rate_limited') blockedReads = true;
            else networkProgress = true;
            item.replyFailed = true;
            break;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));
    if (!current(state)) return { networkProgress: false, blockedReads, count };
    state.value.enriched = true;
    render(state);
    return { networkProgress, blockedReads, count };
  }

  function visible(state, stale = false, failed = false) {
    render(state);
    state.value.serverTime = new Date(now()).toISOString();
    state.value.stale = stale;
    if (stale) {
      state.value.partial = true;
      if (failed)
        state.value.partialReasons = [
          ...new Set([...state.value.partialReasons, 'refresh_failed']),
        ];
    }
    return state.value;
  }

  async function advance(state, credentials) {
    await history(state, credentials);
    await search(state, credentials, state.searchAll);
    await search(state, credentials, state.searchMentions);
    const needsScan = [...state.candidates.values()].some(
      (item) => item.root && eligible(item.ts) && !item.done,
    );
    if (state.preferScan && needsScan) {
      const needsRoots = [...state.candidates.values()].some(
        (item) => !item.root && eligible(item.ts),
      );
      const scanBudget = needsRoots ? Math.floor(SCAN_BUDGET / 2) : SCAN_BUDGET;
      const outcome = await scan(state, credentials, scanBudget);
      if (!current(state)) return null;
      state.preferScan = outcome.blockedReads && !outcome.networkProgress;
      await resolveRoots(state, credentials, SCAN_BUDGET - outcome.count);
      if (!current(state)) return null;
      state.value.enriched = true;
      render(state);
      state.scan = Promise.resolve();
      return state;
    }
    const rootBudget = needsScan ? Math.floor(SCAN_BUDGET / 2) : SCAN_BUDGET;
    const unused = await resolveRoots(state, credentials, rootBudget);
    const budget = SCAN_BUDGET - (rootBudget - unused);
    if (!current(state)) return null;
    state.value.enriched = false;
    render(state);
    state.preferScan = true;
    state.scan = scan(state, credentials, budget).then((outcome) => {
      state.preferScan = outcome.blockedReads && !outcome.networkProgress;
    });
    return state;
  }

  async function load(credentials) {
    const gen = generation();
    const identity = await verify(credentials, gen);
    if (!isCurrent(gen) || !identity.connected) return null;
    if (!identity.userId) return UNVERIFIED_IDENTITY;
    const target = await channel(credentials, gen);
    if (!isCurrent(gen) || !target) return null;
    let usersUnavailable = false;
    const members = await users(credentials, gen).catch(() => {
      usersUnavailable = true;
      return {};
    });
    if (!isCurrent(gen)) return null;
    const created = now();
    const state = {
      gen,
      me: identity.userId,
      teamId: identity.teamId || credentials.teamId || '',
      target,
      names: { ...members, [identity.userId]: identity.user || 'you' },
      history: { cursor: '', done: false },
      searchAll: { page: 1, done: false },
      searchMentions: { page: 1, done: false, mentions: true },
      candidates: new Map(),
      resolveOffset: 0,
      scanOffset: 0,
      preferScan: false,
      reasons: new Set(['search_coverage_uncertain']),
      created,
      token: null,
      truncated: false,
      scan: null,
      value: {
        available: true,
        channel: { id: target.id, name: target.name },
        started: [],
        mentions: [],
        updatedAt: new Date(created).toISOString(),
        enriched: false,
        scope: { creationWindowDays: 28 },
        coverageNotes: [
          'Slack search date boundaries, matching and unofficial session coverage are not verified.',
        ],
      },
    };
    if (usersUnavailable) reason(state, 'users_unavailable');
    await advance(state, credentials);
    if (!current(state)) return null;
    return state;
  }

  function emptyFailedRefresh() {
    const time = new Date(now()).toISOString();
    return {
      available: true,
      channel: null,
      started: [],
      mentions: [],
      updatedAt: time,
      serverTime: time,
      enriched: true,
      scope: { creationWindowDays: 28 },
      coverageNotes: ['The refresh could not be verified; no rows are confirmed.'],
      partial: true,
      partialReasons: ['refresh_failed'],
      stale: true,
      truncated: false,
      continuation: null,
    };
  }

  function failedRefreshResult() {
    return failedRefresh
      ? { ...failedRefresh, serverTime: new Date(now()).toISOString() }
      : { available: false };
  }

  function refresh(credentials) {
    if (refreshing) return;
    const gen = generation();
    const requestVersion = ++version;
    const task = (async () => {
      try {
        const next = await load(credentials);
        if (!isCurrent(gen) || requestVersion !== version) {
          if (next?.token) continuations.delete(next.token);
          return;
        }
        if (!next || next === UNVERIFIED_IDENTITY) throw new Error('refresh failed');
        const failed = next.history.failed || next.searchAll.failed || next.searchMentions.failed;
        preserveVerifiedReplies(cache?.state, next);
        render(next);
        if (cache?.state.token) continuations.delete(cache.state.token);
        cache = { at: now(), state: next, failed };
        failedRefresh = null;
        retryAt = failed ? now() + 60_000 : 0;
      } catch {
        if (!isCurrent(gen) || requestVersion !== version) return;
        if (cache?.state.token) continuations.delete(cache.state.token);
        cache = null;
        failedRefresh = emptyFailedRefresh();
        retryAt = now() + 60_000;
      }
    })();
    refreshing = task.finally(() => {
      if (refreshing === guarded) refreshing = null;
    });
    const guarded = refreshing;
  }

  async function threads({ continuation } = {}) {
    const credentials = session();
    if (!credentials) return { available: false };
    if (continuation) {
      const state = continuations.get(continuation);
      if (
        !state ||
        refreshing ||
        cache?.state !== state ||
        !current(state) ||
        now() - state.created > CONTINUATION_TTL_MS
      )
        return { available: false, partial: true, partialReasons: ['invalid_continuation'] };
      if (!state.continueTask) {
        const requestVersion = ++version;
        const valid = () => current(state) && cache?.state === state && requestVersion === version;
        const task = (async () => {
          await state.scan;
          if (!valid()) return { available: false };
          if (pendingWork(state)) await advance(state, credentials);
          if (!valid()) return { available: false };
          if (state.history.failed || state.searchAll.failed || state.searchMentions.failed) {
            cache.failed = true;
            retryAt = now() + 60_000;
            return visible(state, true, true);
          }
          cache = { at: now(), state, failed: false };
          retryAt = 0;
          return visible(state);
        })();
        const guarded = task.finally(() => {
          if (state.continueTask === guarded) state.continueTask = null;
        });
        state.continueTask = guarded;
      }
      return state.continueTask;
    }
    if (cache) {
      const stale = now() - cache.at >= 5 * 60 * 1000;
      if (
        (stale ||
          cache.failed ||
          (pendingWork(cache.state) && now() - cache.state.created > CONTINUATION_TTL_MS)) &&
        now() >= retryAt
      )
        refresh(credentials);
      return visible(cache.state, stale || cache.failed, cache.failed);
    }
    if (now() < retryAt) return failedRefreshResult();
    if (!cold) {
      const gen = generation();
      const task = load(credentials).catch(() => null);
      const guarded = task.finally(() => {
        if (cold === guarded) cold = null;
      });
      cold = guarded;
      const state = await guarded;
      if (!isCurrent(gen) || !state || state === UNVERIFIED_IDENTITY) {
        if (isCurrent(gen)) {
          retryAt = now() + 60_000;
          if (state === UNVERIFIED_IDENTITY && !failedRefresh) failedRefresh = emptyFailedRefresh();
        }
        return isCurrent(gen) ? failedRefreshResult() : { available: false };
      }
      const failed = state.history.failed || state.searchAll.failed || state.searchMentions.failed;
      cache = { at: now(), state, failed };
      failedRefresh = null;
      retryAt = failed ? now() + 60_000 : 0;
      return visible(state, failed, failed);
    }
    const gen = generation();
    const state = await cold;
    if (!isCurrent(gen)) return { available: false };
    if (state === UNVERIFIED_IDENTITY) {
      if (!failedRefresh) failedRefresh = emptyFailedRefresh();
      retryAt = now() + 60_000;
      return failedRefreshResult();
    }
    if (!state) return failedRefreshResult();
    if (!current(state)) return { available: false };
    const failed = state.history.failed || state.searchAll.failed || state.searchMentions.failed;
    return visible(state, failed, failed);
  }

  function isVerifiedRoot(ts) {
    const state = cache?.state;
    return Boolean(state && current(state) && eligible(ts) && state.candidates.get(ts)?.root);
  }

  return { threads, clear, isVerifiedRoot };
}
