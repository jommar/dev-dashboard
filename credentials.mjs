import fsDefault from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function credentialIdentity(value) {
  return createHash('sha256')
    .update(value || '')
    .digest('hex');
}

export function createCredentialStore({ paths, fs = fsDefault }) {
  function checkAncestors(file) {
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
  function read(file) {
    try {
      checkAncestors(file);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe credential file');
      fs.chmodSync(file, 0o600);
      return { token: fs.readFileSync(file, 'utf8').trim(), source: 'file' };
    } catch (error) {
      if (error.code === 'ENOENT') return { token: '', source: 'missing' };
      return { token: '', source: 'unreadable', unsafe: true };
    }
  }
  function capture() {
    return { github: read(paths.githubToken), jira: read(paths.jiraToken) };
  }
  function stage(file, contents) {
    checkAncestors(file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    checkAncestors(file);
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
  return { capture, stage };
}
