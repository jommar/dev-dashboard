import fsDefault from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageTokenFile } from './credentials.mjs';

const MAP_VERSION = 1;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireSessionId(sessionId) {
  if (!isSessionId(sessionId)) throw failure('INVALID_SESSION', 'Invalid session id');
}

const isText = (value) => typeof value === 'string' && value !== '';
const textOrNull = (value) => (typeof value === 'string' ? value : null);

// A stored entry is trusted only as far as its shape: session ids become file names.
function readEntry(raw) {
  if (!raw || ![raw.key, raw.link, raw.channelId, raw.threadTs].every(isText)) return null;
  const sessionIds = Array.isArray(raw.sessionIds) ? raw.sessionIds.filter(isSessionId) : [];
  return {
    key: raw.key,
    link: raw.link,
    channelId: raw.channelId,
    threadTs: raw.threadTs,
    addedAt: textOrNull(raw.addedAt),
    baselineAt: textOrNull(raw.baselineAt),
    lastNotifiedTs: textOrNull(raw.lastNotifiedTs),
    sessionIds: [...new Set(sessionIds)],
  };
}

function sessionsOf(links) {
  return new Set(Object.values(links).flatMap((entry) => entry.sessionIds));
}

function findLink(links, key) {
  return Object.hasOwn(links, key) ? links[key] : undefined;
}

export function createSlackWatchStore({
  home = os.homedir(),
  fs = fsDefault,
  now = () => Date.now(),
} = {}) {
  const watchDirectory = path.join(home, '.config/dev-dashboard/slack-watch');
  const mapFile = path.join(watchDirectory, 'map.json');
  const inboxDirectory = path.join(watchDirectory, 'inbox');
  const timestamp = () => new Date(now()).toISOString();

  function loadMap() {
    const links = {};
    try {
      const stored = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      if (stored?.version !== MAP_VERSION || !stored.links || typeof stored.links !== 'object')
        return { version: MAP_VERSION, links };
      for (const entry of Object.values(stored.links).map(readEntry))
        if (entry) links[entry.key] = entry;
    } catch {}
    return { version: MAP_VERSION, links };
  }

  let state = loadMap();
  let queue = Promise.resolve();

  function serialize(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }

  function inboxPath(sessionId) {
    requireSessionId(sessionId);
    return path.join(inboxDirectory, `${sessionId}.log`);
  }

  function createInbox(sessionId) {
    const file = inboxPath(sessionId);
    fs.mkdirSync(inboxDirectory, { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(file, 'a', 0o600));
  }

  function removeInbox(sessionId) {
    fs.rmSync(inboxPath(sessionId), { force: true });
  }

  function persist(next) {
    const temporary = stageTokenFile(mapFile, JSON.stringify(next, null, 2) + '\n', fs);
    try {
      fs.renameSync(temporary, mapFile);
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {}
      throw error;
    }
    state = next;
  }

  // Runs `edit` on a copy of the map; when it reports a change the copy is written, then the
  // inboxes follow the sessions that gained or lost their last link. A failed write changes nothing.
  function change(edit) {
    return serialize(() => {
      const next = structuredClone(state);
      if (!edit(next.links)) return false;
      const before = sessionsOf(state.links);
      const after = sessionsOf(next.links);
      const gained = [...after].filter((sessionId) => !before.has(sessionId));
      const lost = [...before].filter((sessionId) => !after.has(sessionId));
      gained.forEach(createInbox);
      try {
        persist(next);
      } catch (error) {
        gained.forEach(removeInbox);
        throw error;
      }
      lost.forEach(removeInbox);
      return true;
    });
  }

  function snapshot() {
    return structuredClone(state);
  }

  async function addLink({ key, link, channelId, threadTs }) {
    const added = await change((links) => {
      if (findLink(links, key)) return false;
      links[key] = {
        key,
        link,
        channelId,
        threadTs,
        addedAt: timestamp(),
        baselineAt: null,
        lastNotifiedTs: null,
        sessionIds: [],
      };
      return true;
    });
    return { added };
  }

  async function removeLink(key) {
    const removed = await change((links) => {
      if (!findLink(links, key)) return false;
      delete links[key];
      return true;
    });
    return { removed };
  }

  async function attach(key, sessionId) {
    const inbox = inboxPath(sessionId);
    const changed = await change((links) => {
      const entry = findLink(links, key);
      if (!entry) throw failure('UNKNOWN_LINK', 'Unknown link');
      if (entry.sessionIds.includes(sessionId)) return false;
      if (entry.sessionIds.length === 0) {
        entry.baselineAt = timestamp();
        entry.lastNotifiedTs = null;
      }
      entry.sessionIds.push(sessionId);
      return true;
    });
    return { changed, inbox };
  }

  async function detach(key, sessionId) {
    requireSessionId(sessionId);
    await change((links) => {
      const entry = findLink(links, key);
      if (!entry?.sessionIds.includes(sessionId)) return false;
      entry.sessionIds = entry.sessionIds.filter((id) => id !== sessionId);
      return true;
    });
  }

  async function setLastNotifiedTs(key, ts) {
    await change((links) => {
      const entry = findLink(links, key);
      if (!entry || entry.lastNotifiedTs === ts) return false;
      entry.lastNotifiedTs = ts;
      return true;
    });
  }

  async function removeSession(sessionId) {
    requireSessionId(sessionId);
    await change((links) => {
      const holders = Object.values(links).filter((entry) => entry.sessionIds.includes(sessionId));
      for (const entry of holders)
        entry.sessionIds = entry.sessionIds.filter((id) => id !== sessionId);
      return holders.length > 0;
    });
    removeInbox(sessionId);
  }

  async function append(sessionId, line) {
    const file = inboxPath(sessionId);
    await serialize(() => fs.appendFileSync(file, `${line}\n`, { mode: 0o600 }));
  }

  return {
    snapshot,
    addLink,
    removeLink,
    attach,
    detach,
    setLastNotifiedTs,
    removeSession,
    inboxPath,
    append,
  };
}
