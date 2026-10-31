import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { settingsFixture, accept, assertNoSecrets, errorCode } from './settings-fixture.mjs';

const defaultSection = {
  intervalSeconds: 180,
  noticeTemplate: "There's a new message on {link}",
  paused: false,
};
const customSection = { intervalSeconds: 60, noticeTemplate: 'Ping {link}', paused: true };
const recordKeysLeftAlone = ['revision', 'validation', 'github', 'jira', 'local', 'minPrApprover'];

const readSettingsFile = (fixture) => fs.readFileSync(fixture.paths.settings, 'utf8');
const persistedSection = (fixture) => JSON.parse(readSettingsFile(fixture)).slackWatch;
const serializedRecordKeys = (text) => {
  const record = JSON.parse(text);
  return recordKeysLeftAlone.map((key) => JSON.stringify(record[key]));
};
const tokenFileState = (fixture) =>
  [fixture.paths.githubToken, fixture.paths.jiraToken].map((file) => ({
    contents: fs.readFileSync(file, 'utf8'),
    inode: fs.statSync(file).ino,
    modifiedAt: fs.statSync(file).mtimeMs,
  }));
const withoutSlackWatch = (publicSettings) => {
  const copy = structuredClone(publicSettings);
  delete copy.slackWatch;
  return copy;
};

async function acceptedStore(t) {
  const fixture = settingsFixture(t);
  const store = await fixture.store();
  await accept(fixture, store);
  return { fixture, store };
}

async function customizedStore(t) {
  const { fixture, store } = await acceptedStore(t);
  await store.saveSlackWatch(customSection);
  return { fixture, store };
}

const rejectsWithField = (field) => (error) =>
  error?.code === 'INVALID_SETTINGS' &&
  Array.isArray(error.errors) &&
  error.errors.some((entry) => entry.field === field);

async function assertRejectedAndUnchanged({ fixture, store }, patch, field) {
  const fileBefore = readSettingsFile(fixture);
  const sectionBefore = store.getPublicSettings().slackWatch;
  await assert.rejects(async () => store.saveSlackWatch(patch), rejectsWithField(field));
  assert.equal(readSettingsFile(fixture), fileBefore, 'the settings file bytes stay the same');
  assert.deepEqual(store.getPublicSettings().slackWatch, sectionBefore);
}

test('slack watch settings serve the defaults for a record with no section', async (t) => {
  const { store } = await acceptedStore(t);
  assert.deepEqual(store.getPublicSettings().slackWatch, defaultSection);
});

test('slack watch settings serve the defaults when settings.json predates the section', async (t) => {
  const fixture = settingsFixture(t);
  fixture.write(
    fixture.paths.settings,
    JSON.stringify({
      schemaVersion: 1,
      revision: 3,
      origin: 'fresh',
      ...fixture.configuration,
      validation: {},
    }),
  );
  const store = await fixture.store();
  await store.initialize();
  assert.equal(store.getPublicSettings().revision, 3, 'the older record was loaded');
  assert.deepEqual(store.getPublicSettings().slackWatch, defaultSection);
});

test('slack watch settings saved with valid values persist atomically and leave the rest of the record untouched', async (t) => {
  const { fixture, store } = await acceptedStore(t);
  const fileBefore = readSettingsFile(fixture);
  const tokensBefore = tokenFileState(fixture);
  const setupBefore = store.getSetupStatus();
  const publicBefore = withoutSlackWatch(store.getPublicSettings());
  const notifications = [];
  store.subscribe((status) => notifications.push(status));
  const lifecycleCalls = [];
  store.bindLifecycle({
    check: () => lifecycleCalls.push('check'),
    apply: () => lifecycleCalls.push('apply'),
  });

  const stored = await store.saveSlackWatch(customSection);

  assert.deepEqual(stored, customSection);
  assert.deepEqual(store.getPublicSettings().slackWatch, customSection);
  assert.deepEqual(persistedSection(fixture), customSection);
  assert.equal(fs.statSync(fixture.paths.settings).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(path.dirname(fixture.paths.settings)),
    ['settings.json'],
    'no staged temporary file is left behind',
  );
  assert.deepEqual(
    serializedRecordKeys(readSettingsFile(fixture)),
    serializedRecordKeys(fileBefore),
    'revision, validation, github, jira, local and minPrApprover are byte-for-byte unchanged',
  );
  assert.deepEqual(tokenFileState(fixture), tokensBefore);
  assert.deepEqual(withoutSlackWatch(store.getPublicSettings()), publicBefore);
  assert.deepEqual(store.getSetupStatus(), setupBefore);
  assert.equal(notifications.length, 0, 'a watch change is not a setup change');
  assert.deepEqual(lifecycleCalls, [], 'services are never reconciled by a watch change');
  assertNoSecrets(persistedSection(fixture));
  assertNoSecrets(readSettingsFile(fixture));
  assertNoSecrets(store.getPublicSettings());
});

test('slack watch settings survive a restart', async (t) => {
  const { fixture } = await customizedStore(t);
  const restarted = await fixture.store();
  await restarted.initialize();
  assert.deepEqual(restarted.getPublicSettings().slackWatch, customSection);
});

test('slack watch settings accept the boundary values 30 and 3600 seconds and a 200-character template', async (t) => {
  const { fixture, store } = await acceptedStore(t);
  for (const patch of [
    { intervalSeconds: 30 },
    { intervalSeconds: 3600 },
    { noticeTemplate: '{link}'.padEnd(200, 'x') },
  ]) {
    const stored = await store.saveSlackWatch(patch);
    const [field, value] = Object.entries(patch)[0];
    assert.equal(stored[field], value);
    assert.equal(store.getPublicSettings().slackWatch[field], value);
    assert.equal(persistedSection(fixture)[field], value);
  }
});

test('slack watch settings accept a notice template without {link}', async (t) => {
  const { fixture, store } = await acceptedStore(t);
  const stored = await store.saveSlackWatch({ noticeTemplate: 'Something changed' });
  assert.equal(stored.noticeTemplate, 'Something changed');
  assert.equal(persistedSection(fixture).noticeTemplate, 'Something changed');
});

test('slack watch settings keep the stored values a partial patch does not mention', async (t) => {
  const { fixture, store } = await acceptedStore(t);
  await store.saveSlackWatch({ ...customSection, paused: false });
  const stored = await store.saveSlackWatch({ paused: true });
  assert.deepEqual(stored, customSection);
  assert.deepEqual(store.getPublicSettings().slackWatch, customSection);
  assert.deepEqual(persistedSection(fixture), customSection);

  const { store: untouched } = await acceptedStore(t);
  assert.deepEqual(await untouched.saveSlackWatch({ paused: true }), {
    ...defaultSection,
    paused: true,
  });
});

test('slack watch settings reject an interval outside 30 to 3600 or not a whole number of seconds', async (t) => {
  const context = await customizedStore(t);
  for (const patch of [
    { intervalSeconds: 29 },
    { intervalSeconds: 3601 },
    { intervalSeconds: 90.5 },
    { intervalSeconds: '90' },
    { intervalSeconds: 29, paused: false },
  ])
    await assertRejectedAndUnchanged(context, patch, 'slackWatch.intervalSeconds');
});

test('slack watch settings reject a multi-line or over-length notice template', async (t) => {
  const context = await customizedStore(t);
  for (const noticeTemplate of ['First line\nSecond line {link}', '{link}'.padEnd(201, 'x')])
    await assertRejectedAndUnchanged(context, { noticeTemplate }, 'slackWatch.noticeTemplate');
});

test('slack watch settings reject a paused flag that is not a boolean', async (t) => {
  const context = await customizedStore(t);
  for (const paused of ['yes', 1])
    await assertRejectedAndUnchanged(context, { paused }, 'slackWatch.paused');
});

test('slack watch settings cannot be saved over a malformed record and defaults are still served', async (t) => {
  const fixture = settingsFixture(t);
  fixture.write(fixture.paths.settings, '{malformed');
  const store = await fixture.store();
  await store.initialize();
  await assert.rejects(
    async () => store.saveSlackWatch(customSection),
    errorCode('PERSISTENCE_FAILED'),
  );
  assert.equal(readSettingsFile(fixture), '{malformed');
  assert.deepEqual(store.getPublicSettings().slackWatch, defaultSection);
});

test('slack watch settings cannot be saved before the store is initialized and defaults are still served', async (t) => {
  const fixture = settingsFixture(t);
  const store = await fixture.store();
  await assert.rejects(
    async () => store.saveSlackWatch(customSection),
    errorCode('PERSISTENCE_FAILED'),
  );
  assert.equal(fs.existsSync(fixture.paths.settings), false);
  assert.deepEqual(store.getPublicSettings().slackWatch, defaultSection);
});
