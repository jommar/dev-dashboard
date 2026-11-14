import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listenHttp, requestRaw } from './http-test-fixture.mjs';
import { createHttpHandler } from '../backend/http-app.mjs';
import { Manager } from '../backend/manager.mjs';
import { settingsFixture, accept } from './settings-fixture.mjs';

const SERVICES = [
  {
    id: 'be',
    label: 'Backend',
    dir: 'Portage-backend',
    command: ['npm', 'run', 'dev'],
    port: null,
  },
  {
    id: 'queue',
    label: 'Queue',
    dir: 'Portage-backend',
    command: ['npm', 'run', 'queue'],
    port: null,
  },
  {
    id: 'fe',
    label: 'Frontend',
    dir: 'Portage-frontend',
    command: ['npm', 'run', 'dev'],
    port: null,
  },
];

// `manager` is the manager itself, or a function of the settings fixture that builds it.
async function endpoint(t, { manager, listWorktrees }) {
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('route tests must never contact an upstream'),
  );
  const fixture = settingsFixture(t);
  fixture.configuration.local.services = SERVICES;
  const settings = await fixture.store();
  await accept(fixture, settings);
  const handler = createHttpHandler({
    settings,
    manager: typeof manager === 'function' ? manager(fixture) : manager,
    integrations: { listWorktrees },
  });
  const { origin } = await listenHttp(t, handler);
  const request = async (pathname, method = 'GET', body) => {
    const { status, text } = await requestRaw(origin, pathname, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status, json: JSON.parse(text) };
  };
  return { fixture, request, origin };
}

// A manager that records the checkout calls the routes make and answers the group lookup.
function recordingManager(main) {
  const calls = [];
  return {
    calls,
    list: () => [],
    applySettings() {},
    withSettingsLock: (operation) => operation(),
    checkoutGroup: (dir) => (dir === 'Portage-backend' ? { main, ids: ['be', 'queue'] } : null),
    switchCheckoutUnlocked: async (...args) => {
      calls.push(args);
      return { checkout: args[1], checkoutLabel: 'x', restarted: [] };
    },
  };
}

function recordingListing(worktrees) {
  const calls = [];
  const listWorktrees = async (...args) => {
    calls.push(args);
    if (worktrees instanceof Error) throw worktrees;
    return worktrees;
  };
  return { calls, listWorktrees };
}

const MAIN = '/r/Portage-backend';
const WORKTREE = '/r/.wt/x';
const LISTING = [
  { path: MAIN, label: 'master', isMain: true },
  { path: WORKTREE, label: 'x', isMain: false },
];
const unavailable = () =>
  Object.assign(new Error('git worktree failed'), { code: 'WORKTREES_UNAVAILABLE' });

test('checkout 3: GET lists the repo worktrees from its main checkout', async (t) => {
  const manager = recordingManager(MAIN);
  const listing = recordingListing(LISTING);
  const { request } = await endpoint(t, { manager, listWorktrees: listing.listWorktrees });
  const response = await request('/api/repos/Portage-backend/worktrees');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { dir: 'Portage-backend', worktrees: LISTING });
  assert.equal(listing.calls.length, 1);
  assert.equal(listing.calls[0][0], MAIN);
});

test('checkout 3: an unknown or traversal dir is 404 UNKNOWN_REPO and git never runs', async (t) => {
  const manager = recordingManager(MAIN);
  const listing = recordingListing(LISTING);
  const { request } = await endpoint(t, { manager, listWorktrees: listing.listWorktrees });
  for (const dir of ['..%2F..', 'nope']) {
    const response = await request(`/api/repos/${dir}/worktrees`);
    assert.equal(response.status, 404, dir);
    assert.equal(response.json.code, 'UNKNOWN_REPO', dir);
  }
  assert.equal(listing.calls.length, 0);
});

test('checkout 4: an unlisted, malformed or traversal pick is 400 INVALID_CHECKOUT with no switch', async (t) => {
  const manager = recordingManager(MAIN);
  const listing = recordingListing(LISTING);
  const { request } = await endpoint(t, { manager, listWorktrees: listing.listWorktrees });
  for (const body of [
    { path: '/tmp' },
    { path: `${WORKTREE}/../y` },
    { path: '/r/.wt' },
    { path: 5 },
    { path: WORKTREE, restart: 'yes' },
  ]) {
    const response = await request('/api/repos/Portage-backend/checkout', 'PUT', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.json.code, 'INVALID_CHECKOUT', JSON.stringify(body));
  }
  assert.equal(manager.calls.length, 0);
});

test('checkout 5: git failure is 502 WORKTREES_UNAVAILABLE on GET and PUT, and nothing switches', async (t) => {
  const manager = recordingManager(MAIN);
  const listing = recordingListing(unavailable());
  const { request } = await endpoint(t, { manager, listWorktrees: listing.listWorktrees });
  const get = await request('/api/repos/Portage-backend/worktrees');
  assert.equal(get.status, 502);
  assert.equal(get.json.code, 'WORKTREES_UNAVAILABLE');
  const put = await request('/api/repos/Portage-backend/checkout', 'PUT', { path: WORKTREE });
  assert.equal(put.status, 502);
  assert.equal(put.json.code, 'WORKTREES_UNAVAILABLE');
  assert.equal(manager.calls.length, 0);
});

test('checkout 6: a pick persists for a new Manager and picking main removes it', async (t) => {
  const { createCheckoutStore } = await import('../backend/checkouts.mjs');
  let home;
  let root;
  const worktree = () => path.join(home, '.worktrees', 'Portage-backend', 'x');
  const local = () => ({ root, services: SERVICES });
  const build = (fixture) => {
    ({ home, root } = fixture);
    fs.mkdirSync(worktree(), { recursive: true });
    return new Manager({
      local: local(),
      logsDir: path.join(home, 'logs'),
      checkouts: createCheckoutStore({ home }),
    });
  };
  const listing = {
    listWorktrees: async () => [
      { path: path.join(root, 'Portage-backend'), label: 'master', isMain: true },
      { path: worktree(), label: 'feature-x', isMain: false },
    ],
  };
  const { request } = await endpoint(t, { manager: build, listWorktrees: listing.listWorktrees });
  const main = path.join(root, 'Portage-backend');
  const file = path.join(home, '.config', 'dev-dashboard', 'checkouts.json');

  const picked = await request('/api/repos/Portage-backend/checkout', 'PUT', { path: worktree() });
  assert.equal(picked.status, 200);
  assert.deepEqual(picked.json, {
    ok: true,
    dir: 'Portage-backend',
    checkout: worktree(),
    checkoutLabel: 'x',
    restarted: [],
  });
  const services = (await request('/api/services')).json.services;
  const byId = Object.fromEntries(services.map((service) => [service.id, service]));
  assert.equal(byId.be.checkout, worktree());
  assert.equal(byId.queue.checkout, worktree());
  assert.equal(byId.fe.checkout, path.join(root, 'Portage-frontend'));
  const reborn = new Manager({
    local: local(),
    logsDir: path.join(home, 'logs'),
    checkouts: createCheckoutStore({ home }),
  });
  assert.equal(reborn.list().find(({ id }) => id === 'be').checkout, worktree());

  const back = await request('/api/repos/Portage-backend/checkout', 'PUT', { path: main });
  assert.equal(back.status, 200);
  assert.equal(back.json.checkout, main);
  assert.equal(back.json.checkoutLabel, null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).checkouts[main], undefined);
  assert.equal(createCheckoutStore({ home }).get(main), undefined);
});

// ---- GET /api/repos/checkout-matches?key= : which worktree of each repo belongs to a ticket ----

const SNAPSHOTS = [
  { id: 'be', dir: 'Portage-backend' },
  { id: 'queue', dir: 'Portage-backend' },
  { id: 'fe', dir: 'Portage-frontend' },
];
const MAINS = {
  'Portage-backend': '/r/Portage-backend',
  'Portage-frontend': '/r/Portage-frontend',
};

// A manager that lists the three services and answers each group lookup; it records every switch.
function groupedManager() {
  const calls = [];
  return {
    calls,
    list: () => SNAPSHOTS,
    applySettings() {},
    withSettingsLock: (operation) => operation(),
    checkoutGroup: (dir) =>
      MAINS[dir]
        ? { main: MAINS[dir], ids: SNAPSHOTS.filter((s) => s.dir === dir).map((s) => s.id) }
        : null,
    switchCheckoutUnlocked: async (...args) => {
      calls.push(args);
      return { checkout: args[1], checkoutLabel: 'x', restarted: [] };
    },
  };
}

// Each repo's listing by its main checkout; an Error value makes that repo's listing fail.
function perRepoListing(byMain) {
  const calls = [];
  const listWorktrees = async (main) => {
    calls.push(main);
    const listing = byMain[main];
    if (listing instanceof Error) throw listing;
    return listing;
  };
  return { calls, listWorktrees };
}

const listingOf = (main, ...labels) => [
  { path: main, label: 'master', isMain: true },
  ...labels.map((label) => ({ path: `/r/.wt/${label}`, label, isMain: false })),
];

test('checkout-matches: reports each repo, one match, none, and switches nothing', async (t) => {
  const manager = groupedManager();
  const listing = perRepoListing({
    [MAINS['Portage-backend']]: listingOf(MAINS['Portage-backend'], 'tap-14-x', 'tap-9-y'),
    [MAINS['Portage-frontend']]: listingOf(MAINS['Portage-frontend'], 'tap-9-y'),
  });
  const { request } = await endpoint(t, { manager, listWorktrees: listing.listWorktrees });

  const response = await request('/api/repos/checkout-matches?key=TAP-14');

  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    key: 'TAP-14',
    repos: [
      {
        dir: 'Portage-backend',
        ids: ['be', 'queue'],
        status: 'match',
        path: '/r/.wt/tap-14-x',
        label: 'tap-14-x',
      },
      { dir: 'Portage-frontend', ids: ['fe'], status: 'none' },
    ],
  });
  assert.deepEqual(listing.calls.sort(), Object.values(MAINS).sort(), 'one listing per repo');
  assert.deepEqual(manager.calls, [], 'no checkout changed');
});

test('checkout-matches: an ambiguous repo names its candidates and chooses no path', async (t) => {
  const manager = groupedManager();
  const listing = perRepoListing({
    [MAINS['Portage-backend']]: listingOf(MAINS['Portage-backend'], 'tap-14-b', 'tap-14-a'),
    [MAINS['Portage-frontend']]: listingOf(MAINS['Portage-frontend']),
  });
  const { request } = await endpoint(t, { manager, listWorktrees: listing.listWorktrees });

  const { json } = await request('/api/repos/checkout-matches?key=TAP-14');

  assert.deepEqual(json.repos[0], {
    dir: 'Portage-backend',
    ids: ['be', 'queue'],
    status: 'ambiguous',
    candidates: ['tap-14-a', 'tap-14-b'],
  });
});

test('checkout-matches rejects: a bad key is 400, cross-site is 403, one failing repo is unavailable', async (t) => {
  const manager = groupedManager();
  const listing = perRepoListing({
    [MAINS['Portage-backend']]: unavailable(),
    [MAINS['Portage-frontend']]: listingOf(MAINS['Portage-frontend'], 'tap-14-fe'),
  });
  const { request, origin } = await endpoint(t, { manager, listWorktrees: listing.listWorktrees });

  for (const query of ['', '?key=x', '?key=tap-14', '?key=TAP-14%2F..', '?key=TAP-14&key=x']) {
    const bad = await request(`/api/repos/checkout-matches${query}`);
    assert.equal(bad.status, 400, query);
    assert.equal(bad.json.code, 'INVALID_TICKET', query);
  }
  assert.equal(listing.calls.length, 0, 'git never ran for a bad key');

  for (const site of ['cross-site', 'same-site']) {
    const { status } = await requestRaw(origin, '/api/repos/checkout-matches?key=TAP-14', {
      headers: { 'sec-fetch-site': site },
    });
    assert.equal(status, 403, site);
  }
  assert.equal(listing.calls.length, 0, 'git never ran for a cross-site request');

  const response = await request('/api/repos/checkout-matches?key=TAP-14');
  assert.equal(response.status, 200, 'one failing repo does not fail the answer');
  assert.deepEqual(response.json.repos, [
    { dir: 'Portage-backend', ids: ['be', 'queue'], status: 'unavailable' },
    {
      dir: 'Portage-frontend',
      ids: ['fe'],
      status: 'match',
      path: '/r/.wt/tap-14-fe',
      label: 'tap-14-fe',
    },
  ]);
});
