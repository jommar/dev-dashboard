import test from 'node:test';
import assert from 'node:assert/strict';

async function model(...names) {
  const mod = await import('../backend/release-model.mjs');
  for (const name of names)
    assert.equal(typeof mod[name], 'function', `release-model.mjs must export ${name}`);
  return mod;
}

test('--version, --all and --json parse to a version id, everyone and JSON output', async () => {
  const { parseReleasesArgs } = await model('parseReleasesArgs');
  assert.deepEqual(parseReleasesArgs(['--version', '18741', '--all', '--json']), {
    version: '18741',
    all: true,
    json: true,
  });
});

test('without flags the CLI asks for the default version, my tickets and text output', async () => {
  const { parseReleasesArgs } = await model('parseReleasesArgs');
  assert.deepEqual(parseReleasesArgs([]), { version: null, all: false, json: false });
});

test('--version as the last argument is a usage error', async () => {
  const { parseReleasesArgs } = await model('parseReleasesArgs');
  assert.throws(() => parseReleasesArgs(['--all', '--version']), /usage/i);
});

test('--version followed by another flag is a usage error', async () => {
  const { parseReleasesArgs } = await model('parseReleasesArgs');
  assert.throws(() => parseReleasesArgs(['--version', '--all']), /usage/i);
  assert.throws(() => parseReleasesArgs(['--version', '--json']), /usage/i);
});

const pr = (repo, number, state, base, countsAsMerged = false) => ({
  repo,
  number,
  title: `Change ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  state,
  base,
  head: 'DEMO-1000/change',
  updatedAt: '2026-10-05T15:58:37.000Z',
  countsAsMerged,
});

const ticket = (key, mergeState, prs = [], extra = {}) => ({
  key,
  summary: `Summary of ${key}`,
  status: 'In Progress',
  issueType: 'Story',
  priority: 'High',
  assignee: 'QA Tester',
  updated: '2026-10-05T12:00:00.000+0000',
  mergeState,
  prsStatus: mergeState === 'unavailable' ? 'unavailable' : 'ok',
  prs,
  ...extra,
});

const releaseData = {
  versions: [
    {
      id: '18741',
      name: 'EZAT | Sprint 19.0 | 10/09/26',
      released: false,
      releaseDate: '2026-10-09',
      family: 'EZAT',
    },
  ],
  version: {
    id: '18741',
    name: 'EZAT | Sprint 19.0 | 10/09/26',
    released: false,
    releaseDate: '2026-10-09',
  },
  scope: 'mine',
  total: 5,
  truncated: false,
  updatedAt: '2026-10-08T12:00:00.000Z',
  tickets: [
    ticket('DEMO-300', 'merged', [
      pr('TransActComm/Portage-backend', 88, 'merged', 'ops/development', true),
    ]),
    ticket('DEMO-476', 'open', [pr('TransActComm/TravelTracker', 2076, 'open', 'ops/development')]),
    ticket('DEMO-1058', 'partial', [
      pr('TransActComm/Portage-frontend', 535, 'merged', 'ops/development', true),
      pr('TransActComm/Portage-backend', 451, 'declined', 'ops/qa'),
    ]),
    ticket('DEMO-1100', 'no-pr'),
    ticket('DEMO-1398', 'unavailable', [], { prsError: 'http' }),
  ],
};

test('the text lists tickets grouped open, partial, no-pr, unavailable, then merged', async () => {
  const { formatReleaseText } = await model('formatReleaseText');
  const text = formatReleaseText(releaseData);
  assert.equal(typeof text, 'string');
  const positions = ['DEMO-476', 'DEMO-1058', 'DEMO-1100', 'DEMO-1398', 'DEMO-300'].map((key) =>
    text.indexOf(key),
  );
  assert.ok(
    positions.every((position) => position >= 0),
    'every ticket is listed',
  );
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    'groups appear in the stated order',
  );
});

test('each ticket line carries its key and summary', async () => {
  const { formatReleaseText } = await model('formatReleaseText');
  const lines = formatReleaseText(releaseData).split('\n');
  const line = lines.find((candidate) => candidate.includes('DEMO-1058'));
  assert.ok(line.includes('Summary of DEMO-1058'));
});

test('each PR is one line with its number, repo, state and base', async () => {
  const { formatReleaseText } = await model('formatReleaseText');
  const lines = formatReleaseText(releaseData).split('\n');
  const frontendLines = lines.filter((line) => line.includes('Portage-frontend'));
  assert.equal(frontendLines.length, 1);
  for (const expected of ['535', 'TransActComm/Portage-frontend', 'merged', 'ops/development']) {
    assert.ok(frontendLines[0].includes(expected), `${expected} in ${frontendLines[0]}`);
  }
  const declinedLines = lines.filter(
    (line) => line.includes('Portage-backend') && line.includes('451'),
  );
  assert.equal(declinedLines.length, 1);
  for (const expected of ['TransActComm/Portage-backend', 'declined', 'ops/qa']) {
    assert.ok(declinedLines[0].includes(expected), `${expected} in ${declinedLines[0]}`);
  }
  const openLines = lines.filter((line) => line.includes('TravelTracker') && line.includes('2076'));
  assert.equal(openLines.length, 1);
  for (const expected of ['open', 'ops/development'])
    assert.ok(openLines[0].includes(expected), `${expected} in ${openLines[0]}`);
});
