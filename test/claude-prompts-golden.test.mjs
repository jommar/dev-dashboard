// claude-prompts-golden.test.mjs — the one prompt source for every harness. The built-in prompts are
// one shared set: the few words that name a harness's own mechanism are placeholders ({SKILL},
// {ASK_TOOL}) filled from the active adapter's `prompt` data. Rendered for Claude Code they are
// byte-identical to what they were before the placeholders existed (`claude-prompts-golden.json`,
// captured from that output); a harness's own words come from its adapter, never from the prompt module.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFakeHarness } from './harness-fake.mjs';

const GOLDEN = JSON.parse(
  fs.readFileSync(new URL('./claude-prompts-golden.json', import.meta.url), 'utf8'),
);
const VALUES = {
  KEY: 'TAP-1234',
  SLUG: 'tap-1234',
  STATUS_FILE: '/state/TAP-1234/status.json',
  QUESTION_IDS: 'q1, q2',
  CHANGE: 'changed answers',
  PR: 321,
  PORT: 9301,
};

async function modules() {
  const prompts = await import('../backend/claude-prompts.mjs');
  const { defaultHarness } = await import('../backend/harness/index.mjs');
  return { ...prompts, claudeCode: defaultHarness() };
}

const render = (prompts, harness, template) =>
  prompts.fillTemplate(template, { ...prompts.harnessValues(harness), ...VALUES });

test('golden: every built-in prompt rendered for Claude Code equals its captured text', async () => {
  const prompts = await modules();

  assert.deepEqual(Object.keys(GOLDEN), prompts.PROMPT_NAMES, 'one golden text per prompt name');
  for (const name of prompts.PROMPT_NAMES)
    assert.equal(
      render(prompts, prompts.claudeCode, prompts.PROMPT_TEMPLATES[name]),
      GOLDEN[name],
      `${name} is byte-identical`,
    );
});

test('harness words: the built-ins hold only the two placeholders where Claude Code names its own mechanism', async () => {
  const prompts = await modules();
  const all = Object.values(prompts.PROMPT_TEMPLATES).join('\n');

  assert.deepEqual(prompts.harnessValues(prompts.claudeCode), {
    SKILL: 'skill',
    ASK_TOOL: 'a question tool',
  });
  assert.match(all, /\{SKILL\}/);
  assert.match(all, /\{ASK_TOOL\}/);
  assert.doesNotMatch(all, /a question tool/, 'no literal harness word is left in a built-in');
  assert.doesNotMatch(all, /`[a-z0-9-]+` skill/, 'a named skill is introduced by {SKILL}');
});

test('harness words: another adapter fills them with its own words and nothing else changes', async () => {
  const prompts = await modules();
  const { harness } = await createFakeHarness();
  const words = prompts.harnessValues(harness);

  assert.notDeepEqual(words, prompts.harnessValues(prompts.claudeCode), 'the fake has its own');
  for (const name of prompts.PROMPT_NAMES) {
    const text = render(prompts, harness, prompts.PROMPT_TEMPLATES[name]);
    assert.doesNotMatch(text, /\{(SKILL|ASK_TOOL)\}/, `${name}: every placeholder is filled`);
    if (!/\{(SKILL|ASK_TOOL)\}/.test(prompts.PROMPT_TEMPLATES[name])) continue;
    assert.notEqual(text, GOLDEN[name], `${name}: shows the adapter's words`);
    assert.equal(
      text.replaceAll(words.ASK_TOOL, 'a question tool').replaceAll(words.SKILL, 'skill'),
      GOLDEN[name],
      `${name}: differs from Claude Code's text only by the adapter's words`,
    );
  }
});

test('old overrides: a file with no harness placeholder, or with an unknown one, renders as it always did', async () => {
  const prompts = await modules();
  const old =
    'Use the `orchestrator` skill on {KEY}; ask with a question tool, or {NOPE}. {STATUS_FILE}';

  assert.equal(
    render(prompts, prompts.claudeCode, old),
    'Use the `orchestrator` skill on TAP-1234; ask with a question tool, or {NOPE}. /state/TAP-1234/status.json',
  );
  const { harness } = await createFakeHarness();
  assert.equal(render(prompts, harness, old), render(prompts, prompts.claudeCode, old));
});

test('old overrides: a value that holds a dollar sign is never a replacement pattern', async () => {
  const prompts = await modules();

  assert.equal(prompts.fillTemplate('{KEY} {SLUG}', { KEY: "$& $'", SLUG: '$1' }), "$& $' $1");
});
