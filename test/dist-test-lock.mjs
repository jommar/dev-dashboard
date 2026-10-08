import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const lockPath = path.join(os.tmpdir(), 'dev-dashboard-dist-test.lock');
const lockProcess = `process.stdout.write('LOCKED\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`;

export async function acquireDistTestLock(filename = lockPath) {
  const child = spawn('flock', ['--exclusive', filename, process.execPath, '-e', lockProcess], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('\n')) resolve();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (!output.includes('\n'))
        reject(new Error(`dist test lock exited before acquisition (code ${code})`));
    });
  });
  await ready;

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    child.stdin.end();
    await once(child, 'close');
  };
}
