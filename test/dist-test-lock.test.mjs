import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireDistTestLock } from './dist-test-lock.mjs';

test('dist fixture lock serializes concurrent processes and keeps the lock inode stable', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-dashboard-lock-test-'));
  const filename = path.join(directory, 'dist-test.lock');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const exitedProcess = spawn(process.execPath, ['-e', '']);
  const stalePidMarker = String(exitedProcess.pid);
  await once(exitedProcess, 'close');
  await fs.writeFile(filename, stalePidMarker);
  const initialStat = await fs.stat(filename);

  let active = 0;
  let maximumActive = 0;
  const contenders = Array.from({ length: 8 }, async () => {
    const release = await acquireDistTestLock(filename);
    try {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(active, 1, 'only one process may mutate dist fixtures at a time');
      active -= 1;
    } finally {
      await release();
    }
  });

  await Promise.all(contenders);
  assert.equal(maximumActive, 1);
  const finalStat = await fs.stat(filename);
  assert.equal(
    `${finalStat.dev}:${finalStat.ino}`,
    `${initialStat.dev}:${initialStat.ino}`,
    'contending processes must not unlink or replace the kernel-locked inode',
  );
  assert.equal(
    await fs.readFile(filename, 'utf8'),
    stalePidMarker,
    'lock acquisition must not depend on or reclaim stale PID contents',
  );
});
