const setupListeners = new Set();
const controlListeners = new Set();
const pendingControls = new Set();

export function onSetupRequired(listener) {
  setupListeners.add(listener);
  return () => setupListeners.delete(listener);
}

function notifySetupRequired() {
  for (const listener of setupListeners) listener();
}

async function checkResponse(res) {
  if (res.ok) return;
  let body;
  try {
    body = await res.json();
  } catch {
    /* Use the status fallback for non-JSON responses. */
  }
  const error = new Error(body?.error || body?.message || `Request failed (status ${res.status})`);
  error.status = res.status;
  error.code = body?.code;
  error.errors = body?.errors || [];
  if (error.code === 'SETUP_REQUIRED') notifySetupRequired();
  throw error;
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  await checkResponse(res);
  return res.json();
}

export const getConfig = () => getJson('/api/config');
export const getSettings = () => getJson('/api/settings');
export const saveSettings = (settings) =>
  getJson('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
export const validateSettings = (expectedRevision) =>
  getJson('/api/settings/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision }),
  });

export async function getServices() {
  const { services } = await getJson('/api/services');
  return services;
}

export async function getLog(id, lines) {
  const res = await fetch(`/api/logs/${encodeURIComponent(id)}?lines=${lines}`);
  await checkResponse(res);
  return res.text();
}

export function onControlPending(listener) {
  controlListeners.add(listener);
  return () => controlListeners.delete(listener);
}

export function isControlPending(id) {
  return pendingControls.has(id);
}

// Marks every id pending while `task` runs, so the cards that read `isControlPending` lock for
// exactly the length of the request. Refuses, without running `task`, when any id is already pending.
async function withPending(ids, task) {
  if (ids.some((id) => pendingControls.has(id)))
    throw new Error('A command is already pending for this service');
  for (const id of ids) {
    pendingControls.add(id);
    for (const listener of controlListeners) listener(id, true);
  }
  try {
    return await task();
  } finally {
    for (const id of ids) {
      pendingControls.delete(id);
      for (const listener of controlListeners) listener(id, false);
    }
  }
}

export const control = (id, action) =>
  withPending([id], async () => {
    const res = await fetch(`/api/services/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
    });
    await checkResponse(res);
    return res;
  });

export const getWorktrees = (dir) => getJson(`/api/repos/${encodeURIComponent(dir)}/worktrees`);

// `ids` are every service of the repo: all of them lock while the switch (and any restart) runs.
export const setCheckout = (dir, path, { restart = false, ids }) =>
  withPending(ids, () =>
    getJson(`/api/repos/${encodeURIComponent(dir)}/checkout`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, restart }),
    }),
  );

export async function getPrs() {
  const res = await fetch('/api/prs');
  if (res.status === 401) return null;
  await checkResponse(res);
  return res.json();
}

export const getReviewTickets = () => getJson('/api/review-tickets');
export const getSpecReviews = (limit = 3, signal) =>
  getJson(`/api/spec-reviews?limit=${encodeURIComponent(limit)}`, { signal });
export const getTeamVelocity = () => getJson('/api/team-velocity');

export async function getMyTickets(includeDone = false) {
  const res = await fetch(`/api/my-tickets${includeDone ? '?includeDone=1' : ''}`);
  if (res.status === 401) return null;
  await checkResponse(res);
  return res.json();
}

// PR status is optional: any failure reads as unavailable and never throws, so the
// board keeps its tickets. Deliberately not checkResponse, which would also fire
// the setup listeners for a PR-only failure.
export async function getTicketPrs() {
  try {
    const res = await fetch('/api/ticket-prs');
    if (!res.ok) return { available: false };
    return await res.json();
  } catch {
    return { available: false };
  }
}

export function getReleases({ version, scope, refresh } = {}) {
  const params = new URLSearchParams();
  if (version) params.set('version', version);
  if (scope === 'all') params.set('scope', 'all');
  if (refresh) params.set('refresh', '1');
  const query = params.toString();
  return getJson(`/api/releases${query ? `?${query}` : ''}`);
}

export async function getPrDiff(repo, number) {
  const res = await fetch(
    `/api/pr-diff?repo=${encodeURIComponent(repo)}&number=${encodeURIComponent(String(number))}`,
  );
  await checkResponse(res);
  return res.json();
}

// Slack is optional, so every Slack call resolves instead of throwing: an
// unreachable or unconnected integration is a state the panel renders, never an
// error that blocks it.
export async function getSlackStatus() {
  try {
    const res = await fetch('/api/slack/status');
    if (!res.ok) return { connected: false, connecting: false };
    return await res.json();
  } catch {
    return { connected: false, connecting: false };
  }
}

export async function getSlackThreads(continuation) {
  try {
    const url = continuation
      ? `/api/slack/threads?continuation=${encodeURIComponent(continuation)}`
      : '/api/slack/threads';
    const res = await fetch(url);
    if (!res.ok) return { available: false };
    return await res.json();
  } catch {
    return { available: false };
  }
}

// The full conversation behind one row's glyph. Also resolves on failure, so a
// disconnected Slack becomes a Retry in the dialog rather than an error there.
export async function getSlackThread(ts) {
  try {
    const res = await fetch(`/api/slack/thread?ts=${encodeURIComponent(ts)}`);
    if (!res.ok) return { available: false };
    return await res.json();
  } catch {
    return { available: false };
  }
}

export async function getSlackPending() {
  try {
    const res = await fetch('/api/slack/pending');
    if (!res.ok) return { available: false };
    return await res.json();
  } catch {
    return { available: false };
  }
}

export async function connectSlack() {
  try {
    const res = await fetch('/api/slack/connect', { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function disconnectSlack() {
  try {
    const res = await fetch('/api/slack/disconnect', { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

// The watch wrappers resolve like the Slack ones, but they also carry the status
// and the server's error text, because the card shows why a save or an attach was
// refused instead of collapsing every failure into "unavailable".
const WATCH_UNAVAILABLE = {
  ok: false,
  status: 0,
  code: 'UNAVAILABLE',
  error: 'The dashboard server could not be reached.',
  errors: [],
};

async function watchRequest(url, { method = 'GET', body } = {}) {
  const init =
    body === undefined
      ? { method }
      : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  try {
    const res = await fetch(url, init);
    const payload = await res.json().catch(() => ({}));
    return { errors: [], ...payload, ok: res.ok, status: res.status };
  } catch {
    return WATCH_UNAVAILABLE;
  }
}

// The DevTools tab: the debug browsers this machine can hand to an agent over CDP.
export const getDevtoolsBrowsers = () => watchRequest('/api/devtools/browsers');
// Browsers launch headless; `headed: true` (sent only when asked for) opens a real window.
export const launchDevtoolsBrowser = ({ label, url, headed } = {}) =>
  watchRequest('/api/devtools/browsers', {
    method: 'POST',
    body: { label, ...(url && { url }), ...(headed === true && { headed: true }) },
  });
export const startDevtoolsBrowser = (id) =>
  watchRequest('/api/devtools/browsers/start', { method: 'POST', body: { id } });
export const stopDevtoolsBrowser = (id) =>
  watchRequest('/api/devtools/browsers/stop', { method: 'POST', body: { id } });
export const removeDevtoolsBrowser = (id) =>
  watchRequest('/api/devtools/browsers/remove', { method: 'POST', body: { id } });
// The one live-view event stream of every browser this tab shows: `hello` (its id), then frame,
// status, target and tabs messages tagged with a browser's id. Closing the source ends all of them.
export const openDevtoolsStream = () => new EventSource('/api/devtools/stream');
// Which browsers the stream carries, each at a quality ('tile' or 'full').
export const subscribeDevtoolsStream = (stream, id, quality) =>
  watchRequest('/api/devtools/stream/subscribe', { method: 'POST', body: { stream, id, quality } });
export const unsubscribeDevtoolsStream = (stream, id) =>
  watchRequest('/api/devtools/stream/unsubscribe', { method: 'POST', body: { stream, id } });
// `targetId` is the tab the viewer was looking at: the server refuses input once it has changed.
export const sendDevtoolsInput = (id, event, targetId) =>
  watchRequest('/api/devtools/browsers/input', { method: 'POST', body: { id, event, targetId } });
// A tab the live view should show (it is brought to the front too); null follows the newest.
export const selectDevtoolsTab = (id, targetId) =>
  watchRequest('/api/devtools/browsers/tab', { method: 'POST', body: { id, targetId } });

export const getSlackWatch = () => watchRequest('/api/slack/watch');
export const getSlackWatchSessions = () => watchRequest('/api/slack/watch/sessions');

export const addSlackWatchLinks = (links) =>
  watchRequest('/api/slack/watch/links', { method: 'POST', body: { links } });

export const removeSlackWatchLink = (link) =>
  watchRequest('/api/slack/watch/remove', { method: 'POST', body: { link } });

export const attachSlackWatchSession = (link, sessionId) =>
  watchRequest('/api/slack/watch/attach', { method: 'POST', body: { link, sessionId } });

export const detachSlackWatchSession = (link, sessionId) =>
  watchRequest('/api/slack/watch/detach', { method: 'POST', body: { link, sessionId } });

export const saveSlackWatchSettings = ({ intervalSeconds, noticeTemplate }) =>
  watchRequest('/api/slack/watch/settings', {
    method: 'PUT',
    body: { intervalSeconds, noticeTemplate },
  });

export const pauseSlackWatch = () => watchRequest('/api/slack/watch/pause', { method: 'POST' });

export const resumeSlackWatch = () => watchRequest('/api/slack/watch/resume', { method: 'POST' });

export const checkSlackWatchNow = () => watchRequest('/api/slack/watch/check', { method: 'POST' });

// The Claude launcher wrappers resolve the same way, through the same helper: a refusal keeps its
// code and reasons for the dialog to word, and an unreachable server is `ok: false, status: 0`.
// `surface` names the reader in the query string (`?surface=bot-bar`), which the server ignores; it
// lets a request log, and a spec counting the board's own reads, tell the bot bar's poll apart.
export const getClaudeTickets = (surface) =>
  watchRequest(`/api/claude/tickets${surface ? `?surface=${encodeURIComponent(surface)}` : ''}`);

// The Chat screen: `send` without a session starts a standalone chat (the reply names it); `stop`
// ends the turn in flight. The stream is one chat's server-sent events (see ui/chat-stream.js).
export const sendChat = (message, session) =>
  watchRequest('/api/claude/chat/send', { method: 'POST', body: { message, session } });
export const stopChat = (session) =>
  watchRequest('/api/claude/chat/stop', { method: 'POST', body: { session } });
export const openChatStream = (session) =>
  new EventSource(`/api/claude/chat/stream?session=${encodeURIComponent(session)}`);

// Which of `keys` are in a sprint Jira calls active (the bot bar's filter) and their status names.
// Resolves like the other watch calls: `ok`, `available` (false when Jira could not say), `keys` and
// `statuses` (a ticket key -> Jira status name object, only for the tickets Jira reported).
export const getActiveSprintTickets = (keys) =>
  watchRequest(`/api/active-sprint-tickets?keys=${encodeURIComponent(keys.join(','))}`);

// `pr` names the spec PR a spec-review launch reviews, `browserId` the DevTools browser an e2e check
// attaches to; no other phase sends either.
export const launchClaude = (key, phase, { pr, browserId } = {}) =>
  watchRequest('/api/claude/launch', {
    method: 'POST',
    body: {
      key,
      phase,
      ...(pr !== undefined && { pr }),
      ...(browserId !== undefined && { browserId }),
    },
  });

// `resend` asks for the saved answers to go to the session again even when nothing changed.
export const answerClaude = (key, answers, { resend = false } = {}) =>
  watchRequest('/api/claude/answers', {
    method: 'POST',
    body: { key, answers, ...(resend && { resend: true }) },
  });

export const approveClaude = (key) =>
  watchRequest('/api/claude/approve', { method: 'POST', body: { key } });

// Asks the ticket's review session to review its linked PRs again.
export const rereviewClaude = (key) =>
  watchRequest('/api/claude/rereview', { method: 'POST', body: { key } });

// The prompt files behind the launcher: all three listed, and one saved or reset by name. A save
// or a reset answers with the prompt's new entry.
export const getClaudePrompts = () => watchRequest('/api/claude/prompts');

export const saveClaudePrompt = (name, text) =>
  watchRequest(`/api/claude/prompts/${name}`, { method: 'PUT', body: { text } });

export const resetClaudePrompt = (name) =>
  watchRequest(`/api/claude/prompts/${name}`, { method: 'DELETE' });

// The Markdown a ticket's Claude sessions left (plan, checklist, spec, groom notes), read-only:
// the list of files, and one file's text by name. Refusals keep their code for the viewer to word.
export const getClaudeArtifacts = (key) =>
  watchRequest(`/api/claude/artifacts?key=${encodeURIComponent(key)}`);

export const getClaudeArtifact = (key, name) =>
  watchRequest(
    `/api/claude/artifact?key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`,
  );

export function subscribeServices(onSnapshot, onConnection = () => {}) {
  const source = new EventSource('/api/events');
  source.addEventListener('setup-required', () => {
    source.close();
    notifySetupRequired();
  });
  source.onmessage = (event) => {
    let list;
    try {
      list = JSON.parse(event.data);
    } catch {
      onConnection('reconnecting');
      return;
    }
    if (!Array.isArray(list)) {
      onConnection('reconnecting');
      return;
    }
    onSnapshot(list);
  };
  source.onopen = () => onConnection('connected');
  source.onerror = () => onConnection('reconnecting');
  return source;
}
