import test from 'node:test';
import assert from 'node:assert/strict';

async function model(...names) {
  const mod = await import('../backend/release-model.mjs');
  for (const name of names)
    assert.equal(typeof mod[name], 'function', `release-model.mjs must export ${name}`);
  return mod;
}

const jiraVersion = (id, name, { released = false, releaseDate, archived = false } = {}) => ({
  self: `https://jira.example.invalid/rest/api/3/version/${id}`,
  id,
  name,
  archived,
  released,
  projectId: 10000,
  ...(releaseDate ? { releaseDate } : {}),
});

const mixedVersions = [
  jiraVersion('18600', 'EZAT | Sprint 18.0 | 09/25/26', {
    released: true,
    releaseDate: '2026-09-25',
  }),
  jiraVersion('18838', 'EZAT | Sprint 20.0 | 10/23/26', { releaseDate: '2026-10-23' }),
  jiraVersion('18500', 'AS | Sprint 12.0 | 09/11/26', {
    released: true,
    releaseDate: '2026-09-11',
  }),
  jiraVersion('18741', 'EZAT | Sprint 19.0 | 10/09/26', { releaseDate: '2026-10-09' }),
  jiraVersion('18700', 'AS | Sprint 13.0 | 10/02/26', { releaseDate: '2026-10-02' }),
  jiraVersion('18900', '[EZAT] Hotfix train'),
  jiraVersion('18400', '[AS] Maintenance window', { released: true, releaseDate: '2026-08-01' }),
  jiraVersion('18300', 'Backlog grooming', { released: true, releaseDate: '2026-09-30' }),
  jiraVersion('18100', 'EZAT | Sprint 10.0 | 05/01/26', {
    releaseDate: '2026-05-01',
    archived: true,
  }),
  jiraVersion('18200', 'AS | Sprint 5.0 | 04/03/26', {
    released: true,
    releaseDate: '2026-04-03',
    archived: true,
  }),
];

test('unreleased versions come first by release date ascending with undated last, then released newest-first', async () => {
  const { orderVersions } = await model('orderVersions');
  const ids = orderVersions(mixedVersions).map((version) => version.id);
  assert.deepEqual(ids, ['18700', '18741', '18838', '18900', '18300', '18600', '18500', '18400']);
});

test('archived versions never appear', async () => {
  const { orderVersions } = await model('orderVersions');
  const ids = orderVersions(mixedVersions).map((version) => version.id);
  assert.equal(ids.includes('18100'), false);
  assert.equal(ids.includes('18200'), false);
});

test('each version carries exactly id, name, released, releaseDate and its family', async () => {
  const { orderVersions } = await model('orderVersions');
  const ordered = orderVersions(mixedVersions);
  assert.deepEqual(ordered[1], {
    id: '18741',
    name: 'EZAT | Sprint 19.0 | 10/09/26',
    released: false,
    releaseDate: '2026-10-09',
    family: 'EZAT',
  });
  assert.deepEqual(ordered[3], {
    id: '18900',
    name: '[EZAT] Hotfix train',
    released: false,
    releaseDate: null,
    family: 'EZAT',
  });
  assert.deepEqual(
    ordered.map((version) => [version.id, version.family]),
    [
      ['18700', 'AS'],
      ['18741', 'EZAT'],
      ['18838', 'EZAT'],
      ['18900', 'EZAT'],
      ['18300', 'Other'],
      ['18600', 'EZAT'],
      ['18500', 'AS'],
      ['18400', 'AS'],
    ],
  );
});

test('at most 20 released versions are kept, newest first, and unreleased versions are not part of that cap', async () => {
  const { orderVersions } = await model('orderVersions');
  const released = Array.from({ length: 25 }, (_, index) =>
    jiraVersion(String(1000 + index), `EZAT | Sprint ${index}.0`, {
      released: true,
      releaseDate: `2026-03-${String(index + 1).padStart(2, '0')}`,
    }),
  );
  const upcoming = jiraVersion('2000', 'EZAT | Sprint 30.0', { releaseDate: '2026-12-01' });
  const ids = orderVersions([...released, upcoming]).map((version) => version.id);
  const newestTwentyReleased = Array.from({ length: 20 }, (_, index) => String(1024 - index));
  assert.deepEqual(ids, ['2000', ...newestTwentyReleased]);
});

const entry = (id, family, released) => ({
  id,
  name: `${family} version ${id}`,
  released,
  releaseDate: null,
  family,
});

test('the default is the earliest unreleased EZAT version', async () => {
  const { defaultVersionId } = await model('defaultVersionId');
  const ordered = [
    entry('1', 'AS', false),
    entry('2', 'EZAT', false),
    entry('3', 'EZAT', false),
    entry('4', 'EZAT', true),
  ];
  assert.equal(defaultVersionId(ordered), '2');
});

test('without an unreleased EZAT version the default is the earliest unreleased version', async () => {
  const { defaultVersionId } = await model('defaultVersionId');
  const ordered = [entry('5', 'Other', false), entry('6', 'AS', false), entry('7', 'EZAT', true)];
  assert.equal(defaultVersionId(ordered), '5');
});

test('with only released versions the default is the newest released one', async () => {
  const { defaultVersionId } = await model('defaultVersionId');
  const ordered = [entry('8', 'EZAT', true), entry('9', 'AS', true)];
  assert.equal(defaultVersionId(ordered), '8');
});

test('with no versions the default is null', async () => {
  const { defaultVersionId } = await model('defaultVersionId');
  assert.equal(defaultVersionId([]), null);
});
