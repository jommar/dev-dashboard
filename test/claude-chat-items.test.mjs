// claude-chat-items.test.mjs — the pure mapping of the CLI's stream-json lines (`liveMessages`) and
// of a session's transcript (`historyItems`) to the chat's events and items (02-spec.md, "Events"
// and "Mapping from the CLI"). No process, no file, no timer.
//
// Interface assumed by these tests (the spec fixes the events, not the function shapes):
//   liveMessages(line, turn) -> [{ event, data }]  one stdout line (text) to the events it becomes;
//     `turn` is one mutable object kept for the turn: the tool items sent so far, and, once the
//     `result` line is mapped, the outcome fields `outcome`, `reason`, `error`, `denials`, `costUsd`.
//   historyItems(text) -> { items, truncated }     the transcript's text to the items of its
//     newest branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantTextLine,
  initLine,
  jsonl,
  resultLine,
  tAssistant,
  tText,
  tToolResult,
  tToolUse,
  tUser,
  textDeltaLine,
  thinkingLine,
  toolResultLine,
  toolUseLine,
} from './claude-chat-fixture.mjs';

const { liveMessages, historyItems } = await import('../backend/claude-chat-items.mjs');
const map = (value, turn) =>
  liveMessages(typeof value === 'string' ? value : JSON.stringify(value), turn);

test('scenario 8: a text delta becomes one delta event', () => {
  assert.deepEqual(map(textDeltaLine('Hel'), {}), [{ event: 'delta', data: { text: 'Hel' } }]);
});

test('scenario 8: an assistant text block becomes an assistant item with the line uuid as its id', () => {
  assert.deepEqual(map(assistantTextLine('u-1', '**hi**'), {}), [
    { event: 'item', data: { item: { id: 'u-1', kind: 'assistant', text: '**hi**' } } },
  ]);
});

test('scenario 8: a tool use is a tool item with no result, and its result comes as the same item again', () => {
  const turn = {};
  const input = { file_path: '/work/a.txt' };
  const [started] = map(toolUseLine('u-2', 'toolu_1', 'Read', input), turn);
  assert.equal(started.event, 'item');
  const item = started.data.item;
  assert.deepEqual(
    [item.id, item.kind, item.name, item.result, item.truncated],
    ['toolu_1', 'tool', 'Read', null, false],
  );
  assert.deepEqual(JSON.parse(item.input), input, 'the input is JSON text');

  const [finished] = map(toolResultLine('toolu_1', 'file text', true), turn);
  assert.equal(finished.event, 'item');
  assert.deepEqual(finished.data.item, {
    ...item,
    result: { text: 'file text', isError: true },
  });

  const [ok] = map(toolResultLine('toolu_1', 'fine', false), turn);
  assert.deepEqual(ok.data.item.result, { text: 'fine', isError: false });
});

test('scenario 8: a result that is not text reads [non-text result]', () => {
  const turn = {};
  map(toolUseLine('u-3', 'toolu_2', 'Screenshot', {}), turn);
  const [finished] = map(toolResultLine('toolu_2', [{ type: 'image', source: {} }], false), turn);
  assert.equal(finished.data.item.result.text, '[non-text result]');
});

test('scenario 8: subagent traffic, init, thinking, unknown types and non-JSON lines become nothing', () => {
  const turn = {};
  const lines = [
    textDeltaLine('x', { parent_tool_use_id: 'toolu_9' }),
    assistantTextLine('u-4', 'sub', { parent_tool_use_id: 'toolu_9' }),
    toolUseLine('u-5', 'toolu_8', 'Read', {}, { parent_tool_use_id: 'toolu_9' }),
    toolResultLine('toolu_8', 'r', false, { parent_tool_use_id: 'toolu_9' }),
    initLine('0a1b2c3d-1111-4111-8111-111111111111'),
    thinkingLine('u-6'),
    { type: 'rate_limit_event' },
    { type: 'system', subtype: 'status', status: 'requesting' },
    'this is not json',
    '',
  ];
  for (const line of lines) assert.deepEqual(map(line, turn), [], JSON.stringify(line));
});

test('scenario 8: a result line sends nothing and is remembered as the turn outcome, with its denials and cost', () => {
  const turn = {};
  const messages = map(resultLine({ denials: ['Write'], cost: 0.31 }), turn);
  assert.deepEqual(messages, []);
  assert.equal(turn.outcome, 'completed');
  assert.deepEqual(turn.denials, ['Write']);
  assert.equal(turn.costUsd, 0.31);
  assert.equal(turn.reason ?? null, null);
  assert.equal(turn.error ?? null, null);
});

test('scenario 8: an aborted result is stopped; an error result is failed with the CLI text, cut to 2000 characters', () => {
  const stopped = {};
  map(resultLine({ isError: true, result: null, terminal: 'aborted_tools' }), stopped);
  assert.equal(stopped.outcome, 'stopped');

  const failed = {};
  map(
    resultLine({ isError: true, result: `API Error: 403 ${'x'.repeat(5000)}`, terminal: 'x' }),
    failed,
  );
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.reason, 'api_error');
  assert.match(failed.error, /^API Error: 403 /);
  assert.ok(failed.error.length <= 2000, 'the error text is cut');
});

test('scenario 8: a tool input and a tool result over 8192 characters are cut and marked truncated', () => {
  const turn = {};
  const big = 'a'.repeat(20_000);
  const [started] = map(toolUseLine('u-7', 'toolu_3', 'Write', { content: big }), turn);
  assert.ok(started.data.item.input.length <= 8192);
  assert.equal(started.data.item.truncated, true);
  const [finished] = map(toolResultLine('toolu_3', big, false), turn);
  assert.ok(finished.data.item.result.text.length <= 8192);
  assert.equal(finished.data.item.truncated, true);

  const [small] = map(toolUseLine('u-8', 'toolu_4', 'Read', { file_path: '/a' }), {});
  assert.equal(small.data.item.truncated, false);
});

// ---- history ----

const treeText = (lines) => jsonl(lines);
const texts = ({ items }) => items.map((item) => item.text ?? item.name);

test('scenario 7: history is the newest branch only, in order, from the root', () => {
  const text = treeText([
    tUser('u1', null, 'first question'),
    tAssistant('a1', 'u1', [tText('first answer')]),
    // an older branch, abandoned by a later resume
    tUser('u2', 'a1', 'old branch question'),
    tAssistant('a2', 'u2', [tText('old branch answer')]),
    // the newest branch forks from a1
    tUser('u3', 'a1', 'new branch question'),
    tAssistant('a3', 'u3', [tText('new branch answer')]),
  ]);
  const result = historyItems(text);
  assert.deepEqual(texts(result), [
    'first question',
    'first answer',
    'new branch question',
    'new branch answer',
  ]);
  assert.deepEqual(
    result.items.map((item) => item.kind),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.equal(result.truncated, false);
});

test('scenario 7: a synthetic assistant line, a meta user line, a sidechain tail and lines with no uuid are not items', () => {
  const text = treeText([
    { type: 'session-owner', sessionId: 'x' },
    tUser('u1', null, 'question'),
    tUser('m1', 'u1', '<local-command-caveat>', { isMeta: true }),
    tAssistant('a1', 'm1', [tText('No response requested.')], {
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [tText('No response requested.')],
      },
    }),
    tAssistant('a2', 'a1', [tText('real answer')]),
    // a later sidechain line must not become the start of the walk
    tAssistant('s1', 'a2', [tText('subagent chatter')], { isSidechain: true }),
    { type: 'cost-state', total: 1 },
  ]);
  assert.deepEqual(texts(historyItems(`${text}not json at all\n`)), ['question', 'real answer']);
});

test('scenario 7: a tool call and its result are one tool item, with the result inside it', () => {
  const text = treeText([
    tUser('u1', null, 'read it'),
    tAssistant('a1', 'u1', [tToolUse('toolu_1', 'Read', { file_path: '/work/a.txt' })]),
    tToolResult('r1', 'a1', 'toolu_1', 'file text', false),
    tAssistant('a2', 'r1', [tText('it says file text')]),
    tUser('u2', 'a2', 'try again'),
    tAssistant('a3', 'u2', [tToolUse('toolu_2', 'Write', { file_path: '/work/b.txt' })]),
    tToolResult('r2', 'a3', 'toolu_2', 'denied', true),
  ]);
  const { items } = historyItems(text);
  const tools = items.filter((item) => item.kind === 'tool');
  assert.equal(tools.length, 2, 'the tool_result lines add no item of their own');
  assert.deepEqual(
    [tools[0].id, tools[0].name, tools[0].result],
    ['toolu_1', 'Read', { text: 'file text', isError: false }],
  );
  assert.deepEqual(JSON.parse(tools[0].input), { file_path: '/work/a.txt' });
  assert.deepEqual(tools[1].result, { text: 'denied', isError: true });
  assert.deepEqual(
    items.map((item) => item.kind),
    ['user', 'tool', 'assistant', 'user', 'tool'],
  );
});

test('scenario 7: more than 300 items keep the newest 300 and say truncated; a tool input is cut at 8192', () => {
  const lines = [];
  let parent = null;
  for (let index = 0; index < 200; index += 1) {
    lines.push(tUser(`u${index}`, parent, `question ${index}`));
    lines.push(tAssistant(`a${index}`, `u${index}`, [tText(`answer ${index}`)]));
    parent = `a${index}`;
  }
  const cut = historyItems(treeText(lines));
  assert.equal(cut.items.length, 300);
  assert.equal(cut.truncated, true);
  assert.equal(cut.items.at(-1).text, 'answer 199', 'the newest items stay');
  assert.equal(cut.items[0].text, 'question 50', 'the oldest 100 go');

  const big = historyItems(
    treeText([
      tUser('u1', null, 'go'),
      tAssistant('a1', 'u1', [tToolUse('toolu_1', 'Write', { content: 'b'.repeat(20_000) })]),
    ]),
  );
  const tool = big.items.find((item) => item.kind === 'tool');
  assert.ok(tool.input.length <= 8192);
  assert.equal(tool.truncated, true);
});

test('scenario 7: an empty or unusable transcript has no items', () => {
  assert.deepEqual(historyItems(''), { items: [], truncated: false });
  assert.deepEqual(historyItems('{"type":"cost-state"}\n[1,2]\nnope\n'), {
    items: [],
    truncated: false,
  });
});
