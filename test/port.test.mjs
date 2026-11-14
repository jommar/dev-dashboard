import test from 'node:test';
import assert from 'node:assert/strict';
import { freePort } from '../backend/port.mjs';

const fakeLsof = (stdout, calls) => (cmd, args, cb) => {
  calls.push([cmd, args]);
  cb(null, stdout);
};

test('freePort asks lsof for listeners only, so connected clients are never killed', async () => {
  const calls = [];
  await freePort(4321, { run: fakeLsof('', calls), settleMs: 0 });
  assert.deepEqual(calls, [['lsof', ['-ti', 'tcp:4321', '-sTCP:LISTEN']]]);
});

test('freePort never signals its own process', (t) => {
  const kill = t.mock.method(process, 'kill', () => true);
  t.mock.method(console, 'log', () => {});
  const other = process.pid + 1;
  return freePort(4321, {
    run: fakeLsof(`${process.pid}\n${other}\n`, []),
    settleMs: 0,
  }).then((freed) => {
    assert.equal(freed, true);
    assert.deepEqual(
      kill.mock.calls.map((call) => call.arguments),
      [[other, 'SIGTERM']],
    );
  });
});

test('freePort does nothing when this process is the only listener', async (t) => {
  const kill = t.mock.method(process, 'kill', () => true);
  const freed = await freePort(4321, { run: fakeLsof(`${process.pid}\n`, []), settleMs: 0 });
  assert.equal(freed, false);
  assert.equal(kill.mock.callCount(), 0);
});
