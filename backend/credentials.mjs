import fsDefault from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function credentialIdentity(value) {
  return createHash('sha256')
    .update(value || '')
    .digest('hex');
}

// A credential file (and every directory above it) must be a real file owned by
// this user's config tree — never a symlink, which could redirect the token
// somewhere unreadable by us and writable by someone else.
function checkAncestors(file, fs) {
  let directory = path.dirname(path.resolve(file));
  while (true) {
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Unsafe credential directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

// Read a `<service>/token` file. Missing is normal (`source: 'missing'`);
// anything unsafe resolves to an empty token with `unsafe: true` so callers can
// refuse to overwrite it.
export function readTokenFile(file, fs = fsDefault) {
  try {
    checkAncestors(file, fs);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe credential file');
    fs.chmodSync(file, 0o600);
    return { token: fs.readFileSync(file, 'utf8').trim(), source: 'file' };
  } catch (error) {
    if (error.code === 'ENOENT') return { token: '', source: 'missing' };
    return { token: '', source: 'unreadable', unsafe: true };
  }
}

// Write `contents` to a sibling temp file (mode 600, exclusivity-checked) and
// hand back its path so the caller can rename it into place atomically.
export function stageTokenFile(file, contents, fs = fsDefault) {
  checkAncestors(file, fs);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  checkAncestors(file, fs);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    const fd = fs.openSync(temporary, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return temporary;
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
}

export function createCredentialStore({ paths, fs = fsDefault }) {
  function read(file) {
    return readTokenFile(file, fs);
  }
  function capture() {
    return { github: read(paths.githubToken), jira: read(paths.jiraToken) };
  }
  function stage(file, contents) {
    return stageTokenFile(file, contents, fs);
  }
  return { capture, stage };
}
