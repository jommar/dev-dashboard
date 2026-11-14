// server-process.test.mjs — what the dashboard process does with a failure nobody planned for: a
// startup or listen failure names its cause in one `[server]` line, an unhandled rejection is logged
// and ignored, an uncaught exception is logged, stops the services and exits 1. The "process" here is
// an EventEmitter, so a test never touches the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const server = await import('../backend/server.mjs');

const parse = (line) => JSON.parse(line.slice(line.indexOf('{')));

function harness({ shutdown } = {}) {
  const proc = new EventEmitter();
  const lines = [];
  const exits = [];
  let shutdowns = 0;
  const uninstall = server.installProcessHandlers({
    proc,
    log: (line) => lines.push(line),
    shutdown:
      shutdown ??
      (async () => {
        shutdowns += 1;
      }),
    exit: (code) => exits.push(code),
  });
  return { proc, lines, exits, uninstall, shutdowns: () => shutdowns };
}

test('server start: a listen failure and a startup failure each log one [server] line with code and name', () => {
  const lines = [];
  const proc = {};
  const listen = Object.assign(new Error('listen EADDRINUSE: address already in use :::4000'), {
    code: 'EADDRINUSE',
  });
  server.reportListenError(listen, { log: (line) => lines.push(line), proc });
  const startup = Object.assign(new Error('ENOENT: no such file, open /home/x/settings.json'), {
    code: 'ENOENT',
  });
  server.reportStartupFailure(startup, { log: (line) => lines.push(line), proc });

  assert.equal(proc.exitCode, 1);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[server\] /);
  assert.deepEqual(
    [parse(lines[0]).step, parse(lines[0]).code, parse(lines[0]).name],
    ['listen', 'EADDRINUSE', 'Error'],
  );
  assert.deepEqual(
    [parse(lines[1]).step, parse(lines[1]).code, parse(lines[1]).name],
    ['startup', 'ENOENT', 'Error'],
  );
  for (const line of lines) assert.ok(!line.includes(' at '), 'never the stack');
});

test('server start: a failure with no code or message still logs and keeps the exit code', () => {
  const lines = [];
  const proc = {};
  server.reportStartupFailure(undefined, { log: (line) => lines.push(line), proc });
  assert.equal(proc.exitCode, 1);
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() =>
    server.reportListenError(new Error('x'), {
      log: () => {
        throw new Error('broken log');
      },
      proc,
    }),
  );
});

test('unhandledRejection logs one [process] line and continues', async () => {
  const h = harness();
  h.proc.emit(
    'unhandledRejection',
    Object.assign(new Error('late failure ghp_abc123'), { code: 'E_X' }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.lines.length, 1);
  const fields = parse(h.lines[0]);
  assert.match(h.lines[0], /^\[process\] /);
  assert.deepEqual(
    [fields.event, fields.name, fields.code],
    ['unhandledRejection', 'Error', 'E_X'],
  );
  assert.ok(!h.lines[0].includes('ghp_abc123'));
  assert.equal(h.shutdowns(), 0);
  assert.deepEqual(h.exits, []);
});

test('unhandledRejection with a non-error reason logs without throwing', () => {
  const h = harness();
  assert.doesNotThrow(() => h.proc.emit('unhandledRejection', 'just a string'));
  assert.doesNotThrow(() => h.proc.emit('unhandledRejection', undefined));
  assert.equal(h.lines.length, 2);
});

test('unhandledRejection: a SyntaxError quotes its input, so no message is logged', () => {
  const h = harness();
  h.proc.emit('unhandledRejection', new SyntaxError('Unexpected token, "BODYSECRET" is not JSON'));
  assert.equal(h.lines.length, 1);
  assert.ok(!h.lines[0].includes('BODYSECRET'));
  assert.equal(parse(h.lines[0]).name, 'SyntaxError');
  assert.ok(!('message' in parse(h.lines[0])));
});

test('uncaughtException logs, shuts down once, then exits 1; a second one exits at once', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let shutdowns = 0;
  const h = harness({
    shutdown: async () => {
      shutdowns += 1;
      await gate;
    },
  });

  h.proc.emit('uncaughtException', new Error('first'));
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /^\[process\] /);
  assert.equal(parse(h.lines[0]).event, 'uncaughtException');
  assert.equal(shutdowns, 1);
  assert.deepEqual(h.exits, [], 'not before the shutdown ends');

  h.proc.emit('uncaughtException', new Error('second'));
  assert.deepEqual(h.exits, [1], 'a second exception during shutdown exits at once');
  assert.equal(shutdowns, 1, 'without a second shutdown');

  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.exits, [1, 1], 'the first shutdown still ends with exit 1');
});

test('uncaughtException exits 1 even when the shutdown itself throws', async () => {
  const h = harness({
    shutdown: async () => {
      throw new Error('shutdown broke');
    },
  });
  h.proc.emit('uncaughtException', new Error('first'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.exits, [1]);
});

test('the returned function removes both handlers', () => {
  const h = harness();
  assert.equal(h.proc.listenerCount('unhandledRejection'), 1);
  assert.equal(h.proc.listenerCount('uncaughtException'), 1);
  h.uninstall();
  assert.equal(h.proc.listenerCount('unhandledRejection'), 0);
  assert.equal(h.proc.listenerCount('uncaughtException'), 0);
});

test('importing server.mjs installs nothing on the real process', async () => {
  const before = [
    process.listenerCount('unhandledRejection'),
    process.listenerCount('uncaughtException'),
  ];
  await import(`../backend/server.mjs?fresh=${Date.now()}`);
  assert.deepEqual(
    [process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException')],
    before,
  );
});
