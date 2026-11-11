// bot-bar.js — the pure rules behind the bot bar, the strip of mascots along the bottom of every
// screen, one per Claude session that belongs to a PR or its code review.
//
// Nothing here touches the DOM, a timer or the network. The bar polls GET /api/claude/tickets
// (the per-ticket entries `useClaudeTickets` holds) and these functions turn that map into the
// bots to draw: which sessions count, the state each shows, which mascot each one is, where it
// roams or rests, and when a finished one leaves.

// The ONE place that says which sessions get a bot: the phases tied to PRs and code review. An entry
// also carries investigate (the planning phase) and groom; they are left out, and adding a name here
// is all it takes to bring one in.
export const BOT_PHASES = ['implement', 'review'];

// Every session an entry can describe, in the order a ticket's bots are drawn. A ticket's workflow
// entry is the session of its current phase (`entry.phase`), so a ticket has one implement or
// investigate session at a time; review and groom are side sessions with their own `{ state, reason }`.
const IMPLEMENT = 'implement-plan';
const INVESTIGATE = 'investigate-and-plan';
const SESSIONS = [
  ['investigate', (entry) => (entry.phase === INVESTIGATE ? entry : null)],
  ['implement', (entry) => (entry.phase === IMPLEMENT ? entry : null)],
  ['review', (entry) => entry.review ?? null],
  ['groom', (entry) => entry.groom ?? null],
];

// A bot shows one of four states. `none` (never started) and `unknown` (the CLI listing could not
// be read) have no mascot, so a session in either is not listed.
export const BOT_STATES = Object.freeze({
  working: 'working',
  waiting: 'waiting',
  done: 'done',
  failed: 'failed',
});

// What each state is called to a person: a waiting session is idle, and it is waiting for you.
export const BOT_STATE_WORDS = Object.freeze({
  working: 'working',
  waiting: 'idle',
  done: 'done',
  failed: 'failed',
});

// A finished session stays this long after the bar first saw it done, then fades out. The bar
// remembers that in memory only, so a reload starts the clock again.
export const DONE_TTL_MS = 10 * 60 * 1000;
// The last stretch of that time is the fade.
export const FADE_MS = 20 * 1000;

export const botKey = (ticket, phase) => `${ticket}:${phase}`;

// The sessions of the response (the `tickets` map, or the whole response holding it) that get a
// bot, as `{ key, ticket, phase, state, reason }` in a stable order: by ticket, then by phase.
export function botsFromTickets(response) {
  const tickets = response?.tickets ?? response;
  if (!tickets || typeof tickets !== 'object') return [];
  const order = (phase) => BOT_PHASES.indexOf(phase);
  return Object.entries(tickets)
    .flatMap(([ticket, entry]) =>
      entry && typeof entry === 'object'
        ? SESSIONS.flatMap(([phase, read]) => {
            const session = BOT_PHASES.includes(phase) ? read(entry) : null;
            const state = BOT_STATES[session?.state];
            return state
              ? [
                  {
                    key: botKey(ticket, phase),
                    ticket,
                    phase,
                    state,
                    reason: session.reason ?? null,
                  },
                ]
              : [];
          })
        : [],
    )
    .sort(
      (a, b) =>
        (a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : 0) || order(a.phase) - order(b.phase),
    );
}

// A ticket key as the rest of the app compares it: trimmed and upper case (`tap-12 ` is TAP-12).
export const normalizeTicketKey = (key) =>
  String(key ?? '')
    .trim()
    .toUpperCase();

// The bots whose ticket is in a sprint Jira calls active: the bar's second filter, applied to what
// `botsFromTickets` returns. `sprintKeys` is the set (or array) of ticket keys GET
// /api/active-sprint-tickets last answered, or null while none has been. A ticket whose sprint is
// not known, because nothing has loaded or Jira could not say, gets no bot.
export function inActiveSprint(items, sprintKeys) {
  if (!sprintKeys) return [];
  const active = new Set([...sprintKeys].map(normalizeTicketKey));
  return active.size ? items.filter(({ ticket }) => active.has(normalizeTicketKey(ticket))) : [];
}

// The sprint keys after an answer: the answer's keys (as a Set) when Jira could say, otherwise
// `previous` unchanged, so a failed or unavailable read keeps the last good set (null if none).
export function nextSprintKeys(previous, result) {
  if (!result?.ok || result.available !== true || !Array.isArray(result.keys)) return previous;
  const next = new Set(result.keys.map(normalizeTicketKey));
  const same = previous && previous.size === next.size && [...next].every((k) => previous.has(k));
  return same ? previous : next;
}

// What the bar remembers while the page is open: when each session was first seen done, and which
// finished bots the user sent away (and the state they were in, so a new state brings one back).
export const NO_MEMORY = Object.freeze({ seenDoneAt: new Map(), dismissed: new Map() });

const isFinished = (state) => state === 'done' || state === 'failed';

// The memory after `bots` was read at `now`: a session seen done keeps its first time, one that is
// not done any more forgets it (a re-run starts its own clock), and a dismissal holds only while the
// bot is still in the state it was dismissed in. Returns `memory` itself when nothing changed.
export function rememberBots(memory, bots, now) {
  const seenDoneAt = new Map();
  for (const { key, state } of bots)
    if (state === 'done') seenDoneAt.set(key, memory.seenDoneAt.get(key) ?? now);
  const stateOf = new Map(bots.map(({ key, state }) => [key, state]));
  const dismissed = new Map(
    [...memory.dismissed].filter(([key, state]) => stateOf.get(key) === state),
  );
  const same = (a, b) => a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
  return same(seenDoneAt, memory.seenDoneAt) && same(dismissed, memory.dismissed)
    ? memory
    : { seenDoneAt, dismissed };
}

// Sends a finished bot away; the memory is unchanged for a bot that is not done or failed.
export const dismissBot = (memory, { key, state }) =>
  isFinished(state) ? { ...memory, dismissed: new Map(memory.dismissed).set(key, state) } : memory;

// The bots to draw at `now`: all of them but a dismissed one and a done one past its time to live.
// A done bot the memory has not seen yet counts as seen now. `fading` marks a done bot in its last
// stretch.
export function liveBots(bots, memory, now, { ttl = DONE_TTL_MS, fade = FADE_MS } = {}) {
  return bots.flatMap((bot) => {
    if (memory.dismissed.get(bot.key) === bot.state) return [];
    if (bot.state !== 'done') return [{ ...bot, fading: false }];
    const age = now - (memory.seenDoneAt.get(bot.key) ?? now);
    return age >= ttl ? [] : [{ ...bot, fading: age >= ttl - fade }];
  });
}

// When the picture next changes without any new data: the earliest moment a done bot starts to
// fade or leaves, as milliseconds from `now`, or null when no done bot is waiting on a clock.
export function nextBotChange(bots, memory, now, { ttl = DONE_TTL_MS, fade = FADE_MS } = {}) {
  const waits = bots
    .filter(({ key, state }) => state === 'done' && memory.seenDoneAt.has(key))
    .flatMap(({ key }) => {
      const age = now - memory.seenDoneAt.get(key);
      return [ttl - fade - age, ttl - age].filter((wait) => wait > 0);
    });
  return waits.length ? Math.min(...waits) : null;
}

// What a callout says when a bot's state changes: one small map, easy to edit. The bubble reads
// `<TICKET> · <text>`.
export const CALLOUT_TEXT = Object.freeze({
  working: 'Working on it…',
  waiting: 'Needs you',
  done: 'Done ✓',
  failed: 'Failed',
});
// Working and done callouts go by themselves after this long; waiting and failed ones stay until the
// bot is hovered, focused or clicked, or its state changes again.
export const CALLOUT_AUTO_HIDE_MS = 6000;
export const CALLOUT_AUTO_HIDE = Object.freeze({ working: true, done: true });
// The bubble fades out over this long before it is removed (keep equal to bot-bar-callout-out).
export const CALLOUT_EXIT_MS = 300;
// At most this many bubbles at once; a new one beyond that pushes the oldest out.
export const MAX_CALLOUTS = 3;
// A change whose ticket the sprint filter has not placed yet waits this long for it to be.
export const CALLOUT_PENDING_MS = 60 * 1000;

// The state of every implement and review session in the response, by session key, including the
// states that get no bot (`none`, `unknown`): the baseline a change is measured against.
export function sessionStates(response) {
  const tickets = response?.tickets ?? response;
  const states = new Map();
  if (!tickets || typeof tickets !== 'object') return states;
  for (const [ticket, entry] of Object.entries(tickets))
    if (entry && typeof entry === 'object')
      for (const [phase, read] of SESSIONS)
        if (BOT_PHASES.includes(phase)) {
          const session = read(entry);
          if (typeof session?.state === 'string') states.set(botKey(ticket, phase), session.state);
        }
  return states;
}

// The baseline after a poll: `next`, except that a session the listing could not say anything about
// (`unknown`) keeps what was known of it, so a glitch is not read as a change when it clears.
export function rememberStates(previous, next) {
  const merged = new Map(next);
  for (const [key, state] of next)
    if (state === 'unknown' && previous?.has(key)) merged.set(key, previous.get(key));
  return merged;
}

// The state changes between two polls, as `{ key, ticket, phase, from, to }` in key order. Nothing on
// the first poll (`previous` is null), for a session whose state is the same, or for one that has no
// bot state to go to. A session that was not there, or had no state (`none`, `unknown`), is a change
// only when it is now working (a session just started); one that appears already waiting, done or
// failed is not news.
export function stateChanges(previous, next) {
  if (!previous) return [];
  const changes = [];
  for (const [key, to] of [...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const from = previous.get(key) ?? 'none';
    if (from === to || !BOT_STATES[to]) continue;
    if (!BOT_STATES[from] && to !== 'working') continue;
    const [ticket, phase] = key.split(':');
    changes.push({ key, ticket, phase, from, to });
  }
  return changes;
}

// The changes that can be shown now, the ones still waiting for their bot, and the rest dropped. A
// change is shown when its bot is among `bots` (in the sprint) still in the state it changed to; it
// waits while its ticket is not placed yet and gives up after CALLOUT_PENDING_MS.
export function settleChanges(pending, bots, now) {
  const stateOf = new Map(bots.map(({ key, state }) => [key, state]));
  const ready = [];
  const waiting = [];
  for (const change of pending) {
    if (stateOf.get(change.key) === change.to) ready.push(change);
    else if (!stateOf.has(change.key) && now - change.at < CALLOUT_PENDING_MS) waiting.push(change);
  }
  return { ready, waiting };
}

const isCalloutLive = ({ hideAt }, now) => hideAt === null || now < hideAt + CALLOUT_EXIT_MS;

// The bubbles after `changes` at `now`: one per bot (a newer one replaces its own), at most
// MAX_CALLOUTS (the oldest go first). A bubble is `{ key, ticket, state, hideAt }`; `hideAt` is when
// it starts to go (null for one that stays until the bot is attended to).
export function addCallouts(callouts, changes, now) {
  const added = changes.map(({ key, ticket, to }) => ({
    key,
    ticket,
    state: to,
    hideAt: CALLOUT_AUTO_HIDE[to] ? now + CALLOUT_AUTO_HIDE_MS : null,
  }));
  const kept = callouts.filter(
    (one) => isCalloutLive(one, now) && !added.some(({ key }) => key === one.key),
  );
  return [...kept, ...added].slice(-MAX_CALLOUTS);
}

// A bubble whose bot was hovered, focused or clicked starts to go now.
export const attendCallout = (callouts, key, now) =>
  callouts.some((one) => one.key === key && one.hideAt === null)
    ? callouts.map((one) => (one.key === key ? { ...one, hideAt: now } : one))
    : callouts;

// The bubbles to draw at `now`, each with `leaving` once it is in its last CALLOUT_EXIT_MS; one
// whose time has run out is gone.
export const liveCallouts = (callouts, now) =>
  callouts
    .filter((one) => isCalloutLive(one, now))
    .map((one) => ({ ...one, leaving: one.hideAt !== null && now >= one.hideAt }));

// Milliseconds until a bubble next starts to leave or is removed, or null when none will.
export function nextCalloutChange(callouts, now) {
  const waits = callouts
    .filter(({ hideAt }) => hideAt !== null)
    .flatMap(({ hideAt }) => [hideAt - now, hideAt + CALLOUT_EXIT_MS - now])
    .filter((wait) => wait > 0);
  return waits.length ? Math.min(...waits) : null;
}

// FNV-1a, 32 bits: small, dependency free and the same on every machine. `salt` makes each use of
// one session key an independent number.
export function hashOf(text, salt = '') {
  let hash = 0x811c9dc5;
  for (const char of `${salt}${text}`) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// A number in [0, 1) from the key, a different one for each salt.
const unit = (key, salt) => hashOf(key, salt) / 2 ** 32;

// The mascot a session is: the id, out of `ids` (the registry's mascot ids), whose hash with the
// session key is the highest (rendezvous hashing). The same key is the same mascot on every render
// and every reload, with nothing stored; adding a mascot moves only the sessions that now score
// highest with it (about 1 in N), and removing one moves only that mascot's sessions. The order of
// `ids` does not matter, and a tie goes to the id that sorts first. Null when there are no ids.
export function pickMascot(sessionKey, ids) {
  let best = null;
  let bestWeight = -1;
  for (const id of [...ids].sort()) {
    const weight = hashOf(`${sessionKey}:${id}`);
    if (weight > bestWeight) {
      best = id;
      bestWeight = weight;
    }
  }
  return best;
}

const between = (low, high, amount) => low + (high - low) * amount;

// One walk there and back takes `seconds` for a working bot; an idle (waiting) bot's takes this many
// times as long, and a done bot's stroll the second. A stroll is the calmest: a relaxed amble with
// a rest at each end and one on the way out, where idle is a slow wander that goes straight back.
export const IDLE_CYCLE_FACTOR = 2.2;
export const STROLL_CYCLE_FACTOR = 3;

// Done bots live in a zone on the left of the bar and never leave it; every other bot roams the whole
// bar, the zone included. The zone is this share of the bar's width (percent), but at least this many
// pixels so a few done bots fit on a narrow screen (it never passes the right edge margin).
export const DONE_ZONE_SHARE = 30;
export const DONE_ZONE_MIN_PX = 240;

const tenths = (number) => Math.round(number * 10) / 10;

// How one session moves, from its key alone. Percentages are of the room the bar leaves a bot
// (the bar's width less one bot): `from` and `range` are the stretch a working, waiting or done
// bot walks, `rest` is the place a bot stands when it is failed, or when motion is reduced.
// `zoneFrom` and `zoneRange` are the same for a done bot, as percentages of the room the done zone
// leaves it (see DONE_ZONE_SHARE), so its stroll stays inside the zone.
// `seconds` is the length of one working walk there and back (`idleSeconds` and `strollSeconds`
// are the idle wander's and the done stroll's), `phase` (0 to 1) how far into it the bot starts so
// no two begin together, and `facing` which way a standing bot looks.
export function roamFor(sessionKey) {
  const range = Math.round(between(25, 70, unit(sessionKey, 'range')));
  const seconds = Math.round(between(14, 28, unit(sessionKey, 'seconds')));
  const zoneRange = Math.round(between(55, 100, unit(sessionKey, 'zoneRange')));
  return {
    range,
    from: Math.round(unit(sessionKey, 'from') * (100 - range)),
    zoneRange,
    zoneFrom: Math.round(unit(sessionKey, 'zoneFrom') * (100 - zoneRange)),
    seconds,
    idleSeconds: tenths(seconds * IDLE_CYCLE_FACTOR),
    strollSeconds: tenths(seconds * STROLL_CYCLE_FACTOR),
    phase: Math.floor(unit(sessionKey, 'phase') * 100) / 100,
    rest: Math.round(unit(sessionKey, 'rest') * 100),
    facing: unit(sessionKey, 'facing') < 0.5 ? 'left' : 'right',
  };
}

// Whether a bot of this state walks the bar (working, waiting and done do; only failed stands).
export const walks = (state) => state === 'working' || state === 'waiting' || state === 'done';

// The stretch, in pixels, a bot's left edge walks along a bar `barWidth` wide: what bot-bar.css works
// out from the same numbers. A done bot walks inside the done zone (from `edge` to the zone's end less
// one bot); any other bot walks the whole bar between its two edge margins. A done bot rests inside
// the same zone, a failed one anywhere in the other.
export function walkStretch(roam, state, barWidth, { edge = 88, size = 56 } = {}) {
  const done = state === 'done';
  const zoneEnd = Math.min(
    Math.max(DONE_ZONE_MIN_PX, (barWidth * DONE_ZONE_SHARE) / 100),
    barWidth - edge,
  );
  const room = Math.max(0, done ? zoneEnd - edge - size : barWidth - size - 2 * edge);
  const min = edge + ((done ? roam.zoneFrom : roam.from) / 100) * room;
  return { min, max: min + ((done ? roam.zoneRange : roam.range) / 100) * room, room };
}

// What a bot is told about its pose: a bot that walks is turned by its lane's keyframes, so it is
// always handed `right`; a failed one stands and looks the way its key says. Only a working bot's
// feet step (`stepping`): a waiting one drifts and pauses, and the mascots' stepping feet exist only
// in their working and idle poses, so a strolling done bot glides in its done pose.
export function botPose(state, roam) {
  return { facing: walks(state) ? 'right' : roam.facing, stepping: state === 'working' };
}

// The custom properties ui-react/styles/bot-bar.css reads to place and move one bot's lane: where it
// walks and how long (`roam`, from roamFor; a done bot's walk is in the done zone), where a failed
// bot stands (`rest`) and where a bot stands when motion is reduced (`still`, from restingSpots; for a
// done bot a place in the zone; `rest` when not given).
export const laneStyle = (roam, rest, still = rest) => ({
  '--bot-from': roam.from,
  '--bot-range': roam.range,
  '--bot-zone-from': roam.zoneFrom,
  '--bot-zone-range': roam.zoneRange,
  '--bot-zone-share': DONE_ZONE_SHARE,
  '--bot-zone-min': DONE_ZONE_MIN_PX,
  '--bot-dur': roam.seconds,
  '--bot-dur-idle': roam.idleSeconds,
  '--bot-dur-stroll': roam.strollSeconds,
  '--bot-phase': roam.phase,
  '--bot-rest': rest,
  '--bot-rest-still': still,
});

// The resting place of each bot, by key, so no two stand on top of each other (give it the bots that
// really stand: the failed ones, or every bot when motion is reduced): every bot starts at
// its own `rest` and the crowded ones are pushed apart to at least `gap` percent (less when there
// are too many bots for that). A bot that has room keeps its own place; the order never changes.
export function restingSpots(bots, gap = 12) {
  const spots = bots
    .map(({ key }) => ({ key, at: roamFor(key).rest }))
    .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
  const step = spots.length > 1 ? Math.min(gap, 100 / (spots.length - 1)) : 0;
  for (let i = 1; i < spots.length; i += 1)
    spots[i].at = Math.max(spots[i].at, spots[i - 1].at + step);
  const last = spots.length - 1;
  if (last >= 0 && spots[last].at > 100) spots[last].at = 100;
  for (let i = last - 1; i >= 0; i -= 1)
    spots[i].at = Math.min(spots[i].at, spots[i + 1].at - step);
  return new Map(spots.map(({ key, at }) => [key, Math.round(at * 10) / 10]));
}
