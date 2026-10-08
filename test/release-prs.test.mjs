import test from 'node:test';
import assert from 'node:assert/strict';

async function model(...names) {
  const mod = await import('../backend/release-model.mjs');
  for (const name of names)
    assert.equal(typeof mod[name], 'function', `release-model.mjs must export ${name}`);
  return mod;
}

const rawPr = ({ number, repo, title, status, base = 'ops/development', head, url }) => ({
  id: `#${number}`,
  name: title,
  status,
  url: url === undefined ? `https://github.com/${repo}/pull/${number}` : url,
  repositoryName: repo,
  repositoryUrl: `https://github.com/${repo}`,
  source: { branch: head },
  destination: { branch: base },
  lastUpdate: '2026-10-05T15:58:37.000Z',
  author: { name: 'User ' },
  commentCount: 0,
});

const tracker = 'TransActComm/TravelTracker';
const frontend = 'TransActComm/Portage-frontend';

test('PRs naming the ticket in a bracketed title, a prefixed title or the source branch are owned', async () => {
  const { ownsPr } = await model('ownsPr');
  const bracketed = rawPr({
    number: 2075,
    repo: tracker,
    title: '[DEMO-1058] Fix the mileage rate',
    status: 'MERGED',
    head: 'feature/rate',
  });
  const prefixed = rawPr({
    number: 535,
    repo: frontend,
    title: 'DEMO-1058: mileage rate in the form',
    status: 'MERGED',
    head: 'feature/rate-ui',
  });
  const branchOnly = rawPr({
    number: 451,
    repo: 'TransActComm/Portage-backend',
    title: 'Mileage rate fix',
    status: 'OPEN',
    head: 'DEMO-1058/mileage-rate-fix',
  });
  for (const pr of [bracketed, prefixed, branchOnly])
    assert.equal(ownsPr('DEMO-1058', pr), true, pr.name);
});

test('the ticket key is matched case-insensitively', async () => {
  const { ownsPr } = await model('ownsPr');
  const lowerCase = rawPr({
    number: 77,
    repo: tracker,
    title: 'demo-1058 mileage rate',
    status: 'OPEN',
    head: 'feature/rate',
  });
  assert.equal(ownsPr('DEMO-1058', lowerCase), true);
});

test('release promotion PRs are not owned', async () => {
  const { ownsPr } = await model('ownsPr');
  const devToQa = rawPr({
    number: 2060,
    repo: tracker,
    title: '[MERGE] DEV → QA',
    status: 'MERGED',
    base: 'ops/qa',
    head: 'ops/development',
  });
  const qaToUat = rawPr({
    number: 2061,
    repo: tracker,
    title: '[MERGE] QA → UAT',
    status: 'DECLINED',
    base: 'ops/uat',
    head: 'ops/qa',
  });
  assert.equal(ownsPr('DEMO-1058', devToQa), false);
  assert.equal(ownsPr('DEMO-1058', qaToUat), false);
});

test('a PR for another ticket that only mentions 1058 in its branch is not owned', async () => {
  const { ownsPr } = await model('ownsPr');
  const foreign = rawPr({
    number: 2079,
    repo: tracker,
    title: '[DEMO-1748] Estimator on the shared rate',
    status: 'OPEN',
    head: 'DEMO-1748-estimator-on-1058',
  });
  assert.equal(ownsPr('DEMO-1058', foreign), false);
});

test('a longer key that contains the digits, or a key with an extra prefix, is not owned', async () => {
  const { ownsPr } = await model('ownsPr');
  const longerNumber = rawPr({
    number: 90,
    repo: tracker,
    title: '[DEMO-10580] Unrelated work',
    status: 'OPEN',
    head: 'DEMO-10580/unrelated',
  });
  const prefixedKey = rawPr({
    number: 91,
    repo: tracker,
    title: '[ADEMO-1058] Other project',
    status: 'OPEN',
    head: 'ADEMO-1058/other',
  });
  assert.equal(ownsPr('DEMO-1058', longerNumber), false);
  assert.equal(ownsPr('DEMO-1058', prefixedKey), false);
});

test('a PR titled with two keys is owned by each of them', async () => {
  const { ownsPr } = await model('ownsPr');
  const shared = rawPr({
    number: 300,
    repo: tracker,
    title: '[DEMO-475][DEMO-476] Shared refactor',
    status: 'MERGED',
    head: 'feature/shared',
  });
  assert.equal(ownsPr('DEMO-476', shared), true);
  assert.equal(ownsPr('DEMO-475', shared), true);
  assert.equal(ownsPr('DEMO-47', shared), false);
});

test('a dev-status PR normalizes to repo, number, title, url, state, base, head and update time', async () => {
  const { normalizeDevStatusPr } = await model('normalizeDevStatusPr');
  const normalized = normalizeDevStatusPr(
    rawPr({
      number: 535,
      repo: frontend,
      title: 'DEMO-1058: mileage rate in the form',
      status: 'MERGED',
      head: 'DEMO-1058/mileage-rate-fix',
    }),
  );
  assert.equal(normalized.repo, 'TransActComm/Portage-frontend');
  assert.equal(normalized.number, 535);
  assert.equal(normalized.title, 'DEMO-1058: mileage rate in the form');
  assert.equal(normalized.url, 'https://github.com/TransActComm/Portage-frontend/pull/535');
  assert.equal(normalized.state, 'merged');
  assert.equal(normalized.base, 'ops/development');
  assert.equal(normalized.head, 'DEMO-1058/mileage-rate-fix');
  assert.equal(normalized.updatedAt, '2026-10-05T15:58:37.000Z');
});

test('OPEN, MERGED and DECLINED map to open, merged and declined; anything else is unknown', async () => {
  const { normalizeDevStatusPr } = await model('normalizeDevStatusPr');
  const stateOf = (status) =>
    normalizeDevStatusPr(
      rawPr({
        number: 1,
        repo: tracker,
        title: '[DEMO-1058] x',
        status,
        head: 'DEMO-1058/x',
      }),
    ).state;
  assert.equal(stateOf('OPEN'), 'open');
  assert.equal(stateOf('MERGED'), 'merged');
  assert.equal(stateOf('DECLINED'), 'declined');
  assert.equal(stateOf('SUPERSEDED'), 'unknown');
  assert.equal(stateOf(undefined), 'unknown');
});

test('a URL that is not a GitHub pull request link becomes null', async () => {
  const { normalizeDevStatusPr } = await model('normalizeDevStatusPr');
  const urls = [
    'https://evil.example/TransActComm/TravelTracker/pull/2075',
    'javascript:alert(1)',
    'http://github.com/TransActComm/TravelTracker/pull/2075',
    'https://github.com/TransActComm/TravelTracker/issues/2075',
    '',
    undefined,
  ];
  for (const url of urls) {
    const normalized = normalizeDevStatusPr({
      ...rawPr({
        number: 2075,
        repo: tracker,
        title: '[DEMO-1058] x',
        status: 'OPEN',
        head: 'DEMO-1058/x',
      }),
      url,
    });
    assert.equal(normalized.url, null, JSON.stringify(url));
    assert.equal(normalized.title, '[DEMO-1058] x');
  }
});

test('a project key with an underscore owns its PRs by title or branch and still rejects longer or prefixed keys', async () => {
  const { ownsPr } = await model('ownsPr');
  assert.equal(ownsPr('MY_PROJ-12', { name: '[MY_PROJ-12] x' }), true);
  assert.equal(
    ownsPr('MY_PROJ-12', {
      name: 'Rename the column',
      source: { branch: 'MY_PROJ-12/rename-column' },
    }),
    true,
  );
  assert.equal(
    ownsPr('MY_PROJ-12', { name: '[MY_PROJ-120] x', source: { branch: 'MY_PROJ-120/x' } }),
    false,
  );
  assert.equal(
    ownsPr('MY_PROJ-12', { name: '[XMY_PROJ-12] x', source: { branch: 'XMY_PROJ-12/x' } }),
    false,
  );
});
