import test from 'node:test';
import assert from 'node:assert/strict';

async function model(...names) {
  const mod = await import('../backend/release-model.mjs');
  for (const name of names)
    assert.equal(typeof mod[name], 'function', `release-model.mjs must export ${name}`);
  return mod;
}

const isBadRequest = (error) => error?.statusHint === 400;
const query = (pairs) => new URLSearchParams(pairs);

const listedVersions = [
  {
    id: '18741',
    name: 'EZAT | Sprint 19.0 | 10/09/26',
    released: false,
    releaseDate: '2026-10-09',
    family: 'EZAT',
  },
  {
    id: '18838',
    name: 'EZAT | Sprint 20.0 | 10/23/26',
    released: false,
    releaseDate: '2026-10-23',
    family: 'EZAT',
  },
];

test('absent parameters parse to the defaults: no version, my tickets, no refresh', async () => {
  const { parseReleaseQuery } = await model('parseReleaseQuery');
  assert.deepEqual(parseReleaseQuery(query([])), { versionId: null, mine: true, refresh: false });
});

test('a digit version, scope=all and refresh=1 parse to a version id, everyone and a forced refresh', async () => {
  const { parseReleaseQuery } = await model('parseReleaseQuery');
  assert.deepEqual(
    parseReleaseQuery(
      query([
        ['version', '18741'],
        ['scope', 'all'],
        ['refresh', '1'],
      ]),
    ),
    { versionId: '18741', mine: false, refresh: true },
  );
  assert.deepEqual(parseReleaseQuery(query([['scope', 'mine']])), {
    versionId: null,
    mine: true,
    refresh: false,
  });
});

test('a version that is not plain digits is rejected with status hint 400', async () => {
  const { parseReleaseQuery } = await model('parseReleaseQuery');
  for (const version of [
    '18741 OR project = X',
    '"18741"',
    '',
    '-1',
    '0x1',
    'EZAT | Sprint 19.0 | 10/09/26',
    '1234567890123',
  ]) {
    assert.throws(
      () => parseReleaseQuery(query([['version', version]])),
      isBadRequest,
      JSON.stringify(version),
    );
  }
});

test('a scope other than mine or all is rejected with status hint 400', async () => {
  const { parseReleaseQuery } = await model('parseReleaseQuery');
  assert.throws(() => parseReleaseQuery(query([['scope', 'everyone']])), isBadRequest);
});

test('a version id found in the fetched list resolves to that version', async () => {
  const { resolveVersion } = await model('resolveVersion');
  const resolved = resolveVersion('18838', listedVersions);
  assert.equal(resolved.id, '18838');
  assert.equal(resolved.name, 'EZAT | Sprint 20.0 | 10/23/26');
});

test('digits absent from the fetched list, or injected JQL, are rejected with status hint 400', async () => {
  const { resolveVersion } = await model('resolveVersion');
  for (const input of ['99999', '18741 OR project = X']) {
    assert.throws(() => resolveVersion(input, listedVersions), isBadRequest, input);
  }
});

test('the JQL for my tickets is the version, the current user and a key ordering', async () => {
  const { buildReleaseTicketsJql } = await model('buildReleaseTicketsJql');
  assert.equal(
    buildReleaseTicketsJql({ versionId: '18741', mine: true }),
    'fixVersion = 18741 AND assignee = currentUser() ORDER BY key ASC',
  );
});

test('the JQL for all release tickets is the version and a key ordering', async () => {
  const { buildReleaseTicketsJql } = await model('buildReleaseTicketsJql');
  assert.equal(
    buildReleaseTicketsJql({ versionId: '18741', mine: false }),
    'fixVersion = 18741 ORDER BY key ASC',
  );
});

test('the JQL builder refuses a version id that is not digits', async () => {
  const { buildReleaseTicketsJql } = await model('buildReleaseTicketsJql');
  for (const versionId of ['18741 OR project = X', 'abc', '', '-1', ' 18741']) {
    assert.throws(
      () => buildReleaseTicketsJql({ versionId, mine: true }),
      undefined,
      JSON.stringify(versionId),
    );
  }
});
