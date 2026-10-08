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

export async function control(id, action) {
  if (pendingControls.has(id)) throw new Error('A command is already pending for this service');
  pendingControls.add(id);
  for (const listener of controlListeners) listener(id, true);
  try {
    const res = await fetch(`/api/services/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
    });
    await checkResponse(res);
    return res;
  } finally {
    pendingControls.delete(id);
    for (const listener of controlListeners) listener(id, false);
  }
}

export async function getPrs() {
  const res = await fetch('/api/prs');
  if (res.status === 401) return null;
  await checkResponse(res);
  return res.json();
}

export async function getMyTickets(includeDone = false) {
  const res = await fetch(`/api/my-tickets${includeDone ? '?includeDone=1' : ''}`);
  if (res.status === 401) return null;
  await checkResponse(res);
  return res.json();
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
