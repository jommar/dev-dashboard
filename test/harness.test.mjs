import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { DEFAULT_HARNESS, can, harnessFrom, say } from '../ui/harness.js';

// The UI's harness wording. Metadata arrives from GET /api/config as `harness`; this pure module
// validates it and fills tokens ({name}, {label}, {command}, {A}) in wording tables. Absent or
// invalid metadata means Claude Code, so every pinned string stays as it is today.
const AIDER = {
  id: 'aider',
  label: 'Aider',
  name: 'Aider',
  command: 'aider',
  capabilities: { chat: false, usage: false },
};

test('DEFAULT_HARNESS is the frozen Claude Code metadata', () => {
  assert.deepEqual(DEFAULT_HARNESS, {
    id: 'claude-code',
    label: 'Claude Code',
    name: 'Claude',
    command: 'claude',
    capabilities: { chat: true, usage: true },
  });
  assert.ok(Object.isFrozen(DEFAULT_HARNESS));
});

// Every tokenized string of the UI inventory (table A), as [template, old literal]. The default
// harness must reproduce the literal byte for byte.
const GOLDEN = [
  [
    '{name} does not trust ~/pathwise yet. Run {command} there once and accept the trust prompt.',
    'Claude does not trust ~/pathwise yet. Run claude there once and accept the trust prompt.',
  ],
  [
    '{name} took too long to start. Check Go to session before launching again.',
    'Claude took too long to start. Check Go to session before launching again.',
  ],
  [
    '{name} took too long to start. Check the review session before launching again.',
    'Claude took too long to start. Check the review session before launching again.',
  ],
  [
    'Could not start {name}. Is the {command} command installed?',
    'Could not start Claude. Is the claude command installed?',
  ],
  ['{name} status is unavailable.', 'Claude status is unavailable.'],
  [
    '{A} {name} session is already running for this ticket.',
    'A Claude session is already running for this ticket.',
  ],
  ['The {name} session could not be found.', 'The Claude session could not be found.'],
  ['The {name} session is still running.', 'The Claude session is still running.'],
  [
    '{name} review status is unavailable. Check the session before launching again.',
    'Claude review status is unavailable. Check the session before launching again.',
  ],
  ['The {name} review session is still running.', 'The Claude review session is still running.'],
  [
    'The {name} review session could not be resumed.',
    'The Claude review session could not be resumed.',
  ],
  ['The {name} session could not be resumed.', 'The Claude session could not be resumed.'],
  [
    '{name} has not marked the plan done. Check the session before implementing.',
    'Claude has not marked the plan done. Check the session before implementing.',
  ],
  ['Approval sent. {name} is checking the plan.', 'Approval sent. Claude is checking the plan.'],
  [
    'Continue sent. {name} is picking up where it stopped.',
    'Continue sent. Claude is picking up where it stopped.',
  ],
  ['Answers sent. {name} is updating the plan.', 'Answers sent. Claude is updating the plan.'],
  ['The {name} request failed.', 'The Claude request failed.'],
  [
    '{name} review status is unavailable. Try again when status is available.',
    'Claude review status is unavailable. Try again when status is available.',
  ],
  [
    '{A} {name} review session is already running for this ticket.',
    'A Claude review session is already running for this ticket.',
  ],
  [
    'The {name} review session could not be found.',
    'The Claude review session could not be found.',
  ],
  [
    'Re-review requested. {name} is checking the linked PRs.',
    'Re-review requested. Claude is checking the linked PRs.',
  ],
  ['The {name} review request failed.', 'The Claude review request failed.'],
  ['The {name} re-review request failed.', 'The Claude re-review request failed.'],
  ['{name} code review for ABC-1', 'Claude code review for ABC-1'],
  ['{name} spec review for ABC-1', 'Claude spec review for ABC-1'],
  ['{name} is working', 'Claude is working'],
  ['{name} replied', 'Claude replied'],
  ['{name} could not be started.', 'Claude could not be started.'],
  ['{name} returned an error.', 'Claude returned an error.'],
  ['{name} stopped unexpectedly.', 'Claude stopped unexpectedly.'],
  ['Stopped before {name} finished.', 'Stopped before Claude finished.'],
  [
    '{name} is replying. Stop the turn to write again.',
    'Claude is replying. Stop the turn to write again.',
  ],
  [
    'Send a message to start a new {name} session. It has no ticket.',
    'Send a message to start a new Claude session. It has no ticket.',
  ],
  ['Message {name}', 'Message Claude'],
  [
    'Talk to {A} {name} session, with or without a ticket.',
    'Talk to a Claude session, with or without a ticket.',
  ],
  ['{name}', 'Claude'],
  ['{name} sessions, 3, 1 need you', 'Claude sessions, 3, 1 need you'],
  ['{name} sessions', 'Claude sessions'],
  [
    'No {name} sessions for tickets in an active sprint.',
    'No Claude sessions for tickets in an active sprint.',
  ],
  ['The {name} dialog', 'The Claude dialog'],
  ['{name} session', 'Claude session'],
  ['{name} session to attach', 'Claude session to attach'],
  [
    '{name} sessions are unavailable, so nothing can be attached to this thread right now.',
    'Claude sessions are unavailable, so nothing can be attached to this thread right now.',
  ],
  ['{name} session attached', 'Claude session attached'],
  ['2 {name} sessions attached', '2 Claude sessions attached'],
  [
    'attach the {label} sessions to wake when a thread gets a new message.',
    'attach the Claude Code sessions to wake when a thread gets a new message.',
  ],
  [
    'Watching is off because the {name} home directory cannot be read. Make it readable, then try again.',
    'Watching is off because the Claude home directory cannot be read. Make it readable, then try again.',
  ],
  ['{name} grooming: done', 'Claude grooming: done'],
  ['This action is not available with {label}.', 'This action is not available with Claude Code.'],
  ['Chat is not available with {label}.', 'Chat is not available with Claude Code.'],
];

test('golden: the default harness fills every tokenized string to its old literal', () => {
  for (const [template, literal] of GOLDEN) {
    assert.equal(say(template, DEFAULT_HARNESS), literal, template);
  }
});

// The templates above are copied by hand, so this ties them to the code: each one must appear
// verbatim in a ui-react source file. The ones that cannot are examples of a template with a
// dynamic part (a ticket key, a count), listed with the source text they stand for.
const UI_REACT = new URL('../ui-react/', import.meta.url);
const sourceFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(new URL(`${entry.name}/`, dir))
      : /\.jsx?$/.test(entry.name)
        ? [new URL(entry.name, dir)]
        : [],
  );

// Examples of a template built from a dynamic part in its source (a ticket key, a count, a phrase,
// the label in JSX), so they cannot appear verbatim.
const DYNAMIC = new Set([
  '{name} code review for ABC-1',
  '{name} spec review for ABC-1',
  '{name} sessions, 3, 1 need you',
  '2 {name} sessions attached',
  'attach the {label} sessions to wake when a thread gets a new message.',
  '{name} grooming: done',
]);

test('golden: every template appears verbatim in a ui-react source file', () => {
  const source = sourceFiles(UI_REACT)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const missing = GOLDEN.map(([template]) => template).filter(
    (template) => !source.includes(template) && !DYNAMIC.has(template),
  );
  assert.deepEqual(missing, []);
});

test('golden: say fills every occurrence of a token and leaves other text alone', () => {
  assert.equal(
    say('{name}/{name} {label} {command}', DEFAULT_HARNESS),
    'Claude/Claude Claude Code claude',
  );
  assert.equal(
    say('no tokens, ~/pathwise {braces}', DEFAULT_HARNESS),
    'no tokens, ~/pathwise {braces}',
  );
});

test('harnessFrom: valid metadata is kept as given', () => {
  assert.deepEqual(harnessFrom(AIDER), AIDER);
  assert.deepEqual(harnessFrom(DEFAULT_HARNESS), DEFAULT_HARNESS);
});

test('harnessFrom: missing or invalid metadata falls back to Claude Code and never throws', () => {
  const invalid = [
    undefined,
    null,
    42,
    'aider',
    [],
    {},
    { id: 'Bad Id' },
    { ...AIDER, id: 'Bad Id' },
    { ...AIDER, id: '' },
    { ...AIDER, label: 'x'.repeat(41) },
    { ...AIDER, name: 'x'.repeat(41) },
    { ...AIDER, command: 'x'.repeat(41) },
    { ...AIDER, label: 'Ai\u0007der' },
    { ...AIDER, name: 'Ai\nder' },
    { ...AIDER, label: 5 },
    { ...AIDER, capabilities: { chat: 'yes', usage: false } },
    { ...AIDER, capabilities: { chat: false, usage: 1 } },
    { ...AIDER, capabilities: { chat: false } },
    { ...AIDER, capabilities: null },
    { ...AIDER, capabilities: undefined },
  ];
  for (const raw of invalid) {
    assert.deepEqual(harnessFrom(raw), DEFAULT_HARNESS, JSON.stringify(raw));
  }
});

test('harnessFrom: a second harness fills the tokens, with the right article', () => {
  const aider = harnessFrom(AIDER);
  assert.equal(say('{A} {name}', aider), 'An Aider');
  assert.equal(say('{A} {name}', DEFAULT_HARNESS), 'A Claude');
  assert.equal(
    say('{A} {name} session is already running for this ticket.', aider),
    'An Aider session is already running for this ticket.',
  );
  assert.equal(say('Message {name} ({command})', aider), 'Message Aider (aider)');
});

test('harnessFrom: can reads the capability, false for an unknown one', () => {
  assert.equal(can(DEFAULT_HARNESS, 'chat'), true);
  assert.equal(can(DEFAULT_HARNESS, 'usage'), true);
  assert.equal(can(harnessFrom(AIDER), 'chat'), false);
  assert.equal(can(harnessFrom(AIDER), 'usage'), false);
  assert.equal(can(DEFAULT_HARNESS, 'nope'), false);
});

test('ui/harness.js stays within its 2048 byte budget', () => {
  assert.ok(statSync(new URL('../ui/harness.js', import.meta.url)).size <= 2048);
});
