// claude-usage.test.mjs — the transcript token tally: dedupe by message id, incremental reads by byte
// offset, open lines and open messages, rebuilds, subagents and unreadable files, the per-request
// budget, and the guards (metadata only, bounded cache). Real temp files; an io spy counts bytes read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageReader } from '../backend/claude-usage.mjs';

const SENTINEL = 'SENTINEL-TEXT-DO-NOT-KEEP-4417';

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const usage = (input, output, cacheRead = 0, cacheCreation = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreation,
});
const line = (id, numbers, { model = 'claude-sonnet-5-5', text = 'hi' } = {}) =>
  JSON.stringify({
    type: 'assistant',
    message: { id, model, role: 'assistant', content: [{ type: 'text', text }], usage: numbers },
  });
const userLine = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const M1 = usage(10, 5, 100, 20);
const M2 = usage(1, 1, 0, 0);
const write = (file, lines) => fs.writeFileSync(file, `${lines.join('\n')}\n`);
const append = (file, lines) => fs.appendFileSync(file, `${lines.join('\n')}\n`);

// The default file io with every read recorded.
function spyIo() {
  const reads = [];
  return {
    reads,
    bytes: () => reads.reduce((sum, length) => sum + length, 0),
    io: {
      stat: fs.promises.stat,
      read: async (file, offset, length) => {
        const handle = await fs.promises.open(file, 'r');
        try {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          reads.push(bytesRead);
          return buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      },
    },
  };
}

test('dedupes by message id: the lines of one message count once', async (t) => {
  const file = path.join(folder(t), 'a.jsonl');
  write(file, [
    line('m1', M1),
    userLine('between'),
    line('m1', M1),
    line('m1', M1),
    line('m2', M2, { model: 'claude-haiku-4-5' }),
  ]);

  const result = await createUsageReader().tally([file]);

  assert.deepEqual(result.tokens, { input: 11, output: 6, cacheRead: 100, cacheCreation: 20 });
  assert.equal(result.messages, 2);
  assert.deepEqual(result.models, { 'claude-sonnet-5-5': 1, 'claude-haiku-4-5': 1 });
  assert.equal(result.complete, true);
});

test('incremental: a second read takes only the appended bytes and matches a fresh full read', async (t) => {
  const file = path.join(folder(t), 'a.jsonl');
  write(file, [line('m1', M1), line('m2', M2)]);
  const spy = spyIo();
  const reader = createUsageReader({ io: spy.io });
  await reader.tally([file]);
  const first = spy.bytes();
  assert.equal(first, fs.statSync(file).size);

  const before = fs.statSync(file).size;
  append(file, [line('m3', usage(2, 2)), line('m4', usage(3, 3))]);
  const second = await reader.tally([file]);

  assert.equal(spy.bytes() - first, fs.statSync(file).size - before, 'only the new bytes');
  assert.deepEqual(second, await createUsageReader().tally([file]));
  assert.equal(second.messages, 4);
});

test('open line: a half line counts when it is completed, not before', async (t) => {
  const file = path.join(folder(t), 'a.jsonl');
  const whole = line('m2', M2);
  fs.writeFileSync(file, `${line('m1', M1)}\n${whole.slice(0, 40)}`);
  const reader = createUsageReader();

  const half = await reader.tally([file]);
  assert.equal(half.messages, 1);
  assert.equal(half.complete, true, 'the file was read to its end');

  fs.appendFileSync(file, `${whole.slice(40)}\n`);
  const done = await reader.tally([file]);
  assert.equal(done.messages, 2);
  assert.deepEqual(done.tokens, { input: 11, output: 6, cacheRead: 100, cacheCreation: 20 });
});

test('open message: a read ending on id m1 then more m1 lines counts m1 once', async (t) => {
  const file = path.join(folder(t), 'a.jsonl');
  write(file, [line('m1', M1), line('m1', M1)]);
  const reader = createUsageReader();
  const early = await reader.tally([file]);
  assert.equal(early.messages, 1, 'the open message is part of the answer');

  append(file, [line('m1', M1), line('m2', M2)]);
  const late = await reader.tally([file]);

  assert.equal(late.messages, 2);
  assert.deepEqual(late.tokens, { input: 11, output: 6, cacheRead: 100, cacheCreation: 20 });
});

test('rebuilds: a shrunk file or a new inode restarts the tally from byte 0', async (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'a.jsonl');
  write(file, [line('m1', M1), line('m2', M2), line('m3', M2)]);
  const reader = createUsageReader();
  assert.equal((await reader.tally([file])).messages, 3);

  write(file, [line('x1', usage(7, 7))]);
  const shrunk = await reader.tally([file]);
  assert.equal(shrunk.messages, 1);
  assert.deepEqual(shrunk.tokens, { input: 7, output: 7, cacheRead: 0, cacheCreation: 0 });

  // A replacement file that is larger than the old offset, so only the inode says it changed.
  const other = path.join(dir, 'b.jsonl');
  write(other, [line('y1', usage(1, 1)), line('y2', usage(1, 1)), line('y3', usage(1, 1))]);
  fs.renameSync(other, file);
  const replaced = await reader.tally([file]);
  assert.equal(replaced.messages, 3);
  assert.equal(replaced.tokens.input, 3);
});

test('subagents: the readable files sum and an unreadable one makes the tally incomplete', async (t) => {
  const dir = folder(t);
  const main = path.join(dir, 'main.jsonl');
  const sub1 = path.join(dir, 'sub1.jsonl');
  const sub2 = path.join(dir, 'sub2.jsonl');
  write(main, [line('m1', M1)]);
  write(sub1, [line('s1', M2)]);
  write(sub2, [line('s2', M2)]);
  const reader = createUsageReader();

  const all = await reader.tally([main, sub1, sub2]);
  assert.equal(all.messages, 3);
  assert.equal(all.complete, true);

  fs.rmSync(sub2);
  const lost = await reader.tally([main, sub1, sub2]);
  assert.equal(lost.messages, 2);
  assert.equal(lost.tokens.input, 11);
  assert.equal(lost.complete, false);
});

test('budget: a request reads at most the budget and repeated calls end at the full tally', async (t) => {
  const file = path.join(folder(t), 'a.jsonl');
  const lines = Array.from({ length: 40 }, (_, index) => line(`m${index}`, usage(1, 1)));
  write(file, lines);
  const size = fs.statSync(file).size;
  const budgetBytes = Math.floor(size / 4);
  const spy = spyIo();
  const reader = createUsageReader({ io: spy.io, budgetBytes });

  let result = await reader.tally([file]);
  assert.ok(spy.bytes() <= budgetBytes, 'at most the budget was read');
  assert.equal(result.complete, false);
  assert.ok(result.messages < 40);

  for (let call = 0; call < 20 && !result.complete; call += 1) {
    const before = spy.bytes();
    result = await reader.tally([file]);
    assert.ok(spy.bytes() - before <= budgetBytes);
  }
  assert.equal(result.complete, true);
  assert.equal(result.messages, 40);
  assert.equal(result.tokens.input, 40);
});

test('budget: a line longer than a whole request is dropped and the tally goes on after it', async (t) => {
  const file = path.join(folder(t), 'a.jsonl');
  const huge = line('big', usage(500, 500), { text: 'x'.repeat(4000) });
  write(file, [line('m1', M2), huge, line('m2', M2)]);
  const reader = createUsageReader({ budgetBytes: 1000 });

  let result;
  for (let call = 0; call < 30; call += 1) {
    result = await reader.tally([file]);
    if (result.complete) break;
  }

  assert.equal(result.complete, true);
  assert.equal(result.messages, 2, 'the two ordinary messages count, the oversized one does not');
  assert.equal(result.tokens.input, 2);
});

test('metadata only: the cache holds numbers and model ids, and nothing is logged', async (t) => {
  const file = path.join(folder(t), 'a.jsonl');
  write(file, [
    userLine(SENTINEL),
    line('m1', M1, { text: SENTINEL }),
    JSON.stringify({
      type: 'assistant',
      message: { id: 'm2', model: `${SENTINEL} with spaces`, usage: M2 },
    }),
  ]);
  const logged = [];
  const originals = ['log', 'warn', 'error', 'info', 'debug'].map((name) => [name, console[name]]);
  for (const [name] of originals) console[name] = (...args) => logged.push(args.join(' '));
  t.after(() => originals.forEach(([name, original]) => (console[name] = original)));

  const reader = createUsageReader();
  const result = await reader.tally([file]);

  assert.equal(result.messages, 2);
  assert.deepEqual(logged, []);
  assert.ok(
    !JSON.stringify(result).includes(SENTINEL),
    'text is never kept, nor a model name that is not an id',
  );
  assert.ok(!JSON.stringify(result).includes(file), 'no path in the answer');
  assert.equal(reader.cacheSize(), 1);

  // The cached state itself: numbers, flags and model ids, no text, no path.
  const kept = JSON.stringify(reader.inspect());
  assert.ok(!kept.includes(SENTINEL), 'no transcript text in the cache');
  assert.ok(!kept.includes(file), 'no path in the cache');
  assert.deepEqual(Object.keys(reader.inspect()[0]).sort(), [
    'ino',
    'messages',
    'models',
    'offset',
    'pending',
    'skipping',
    'tokens',
  ]);
  assert.deepEqual(Object.keys(reader.inspect()[0].pending).sort(), ['id', 'model', 'usage']);
});

test('bounded: after 300 distinct files the cache holds at most 256', async (t) => {
  const dir = folder(t);
  const reader = createUsageReader();
  const files = Array.from({ length: 300 }, (_, index) => path.join(dir, `f${index}.jsonl`));
  for (const file of files) write(file, [line('m1', M2)]);

  for (const file of files) await reader.tally([file]);

  assert.equal(reader.cacheSize(), 256);
});

test('one request shares one budget across its sessions, not one budget each', async (t) => {
  const dir = folder(t);
  const ids = ['a', 'b', 'c'];
  const lines = Array.from({ length: 40 }, (_, index) => line(`m${index}`, usage(1, 1)));
  for (const id of ids) write(path.join(dir, `${id}.jsonl`), lines);
  const size = fs.statSync(path.join(dir, 'a.jsonl')).size;
  const budgetBytes = Math.floor(size * 1.5);
  const spy = spyIo();
  const reader = createUsageReader({ io: spy.io, budgetBytes });
  const filesById = Object.fromEntries(ids.map((id) => [id, [path.join(dir, `${id}.jsonl`)]]));

  const first = await reader.tallyMany(filesById);

  assert.ok(spy.bytes() <= budgetBytes, 'the whole request read at most one budget');
  assert.equal(first.a.complete, true);
  assert.equal(first.c.complete, false);

  let result = first;
  for (let call = 0; call < 10 && ids.some((id) => !result[id].complete); call += 1) {
    const before = spy.bytes();
    result = await reader.tallyMany(filesById);
    assert.ok(spy.bytes() - before <= budgetBytes);
  }
  assert.deepEqual(
    ids.map((id) => result[id].messages),
    [40, 40, 40],
  );
});

test('more files than the cache holds: the extra are left out, the answer is incomplete, and a repeat re-reads nothing', async (t) => {
  const dir = folder(t);
  const files = Array.from({ length: 300 }, (_, index) => path.join(dir, `f${index}.jsonl`));
  for (const file of files) write(file, [line('m1', M2)]);
  const spy = spyIo();
  const reader = createUsageReader({ io: spy.io });

  const first = await reader.tally(files);
  const firstBytes = spy.bytes();
  const second = await reader.tally(files);

  assert.equal(first.complete, false);
  assert.equal(first.messages, 256);
  assert.deepEqual(second, first);
  assert.equal(spy.bytes(), firstBytes, 'the second call read no byte again');
  assert.equal(reader.cacheSize(), 256);
});

test('a missing file is an incomplete empty tally, not an error', async (t) => {
  const result = await createUsageReader().tally([path.join(folder(t), 'gone.jsonl')]);
  assert.deepEqual(result.tokens, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  assert.equal(result.messages, 0);
  assert.equal(result.complete, false);
});
