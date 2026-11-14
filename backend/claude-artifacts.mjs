// claude-artifacts.mjs — read-only access to the Markdown a Claude session leaves for a ticket
// (`02-plan.md`, `02-checklist.md`, `02-spec.md`, `groom.md`, ...), so the dashboard can show it in
// place of a path to open by hand. The files are written by an agent, so they are untrusted input:
// only `.md` files that sit directly in `~/pathwise/.orchestrator/<ticket>/` are listed or read,
// the ticket and file names are checked before any path is built, a symlink (the folder's or the
// file's) is never followed out of that folder, and a file over MAX_ARTIFACT_BYTES is refused.
import fsDefault from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTicketKey } from './claude-ticket-state.mjs';

export const MAX_ARTIFACT_BYTES = 512 * 1024;
export const MAX_ARTIFACTS = 50;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/;
// The plan is what a reader wants first, then the rest by name.
const FIRST = '02-plan.md';

// The one-line outcome a finished e2e check or groom session writes first in its report: a closed
// enum per file, read from the head only. The values are mirrored, by hand and pinned by a test, in
// `ui/claude-verdict.js`; the backend imports nothing from `ui/`.
export const VERDICT_FILES = Object.freeze({
  'e2e.md': Object.freeze({
    label: 'Verdict',
    values: Object.freeze(['PASS', 'FAIL', 'PARTIAL', 'BLOCKED']),
  }),
  'groom.md': Object.freeze({
    label: 'Readiness',
    values: Object.freeze(['READY', 'NEEDS_INFO', 'BLOCKED']),
  }),
});
export const VERDICT_HEAD_BYTES = 512;
const MAX_VERDICTS = 500;

// The value of the first non-empty line of `head` (a Buffer or a string) in file `name`, or null.
// Optional leading `#`, `>`, `*` and spaces are skipped, the label and value must match exactly
// (case-sensitive, the value not followed by a word character), and the text after `BLOCKED:` is
// never read. Anything else, including a NUL byte, is no verdict.
export function parseVerdict(name, head) {
  const rule = Object.hasOwn(VERDICT_FILES, name) ? VERDICT_FILES[name] : null;
  const text = Buffer.isBuffer(head) ? head.toString('utf8') : head;
  if (!rule || typeof text !== 'string' || text.includes('\0')) return null;
  const line = text.split('\n').find((one) => one.trim() !== '');
  const match = new RegExp(
    `^[#>*\\s]*${rule.label}:[ \\t]*(${rule.values.join('|')})(?![A-Za-z0-9_])`,
  ).exec(line ?? '');
  return match ? match[1] : null;
}

const refusal = (code, message, status) => Object.assign(new Error(message), { code, status });
const invalidTicket = () => refusal('INVALID_TICKET', 'Invalid ticket.', 400);
const invalidArtifact = () => refusal('INVALID_ARTIFACT', 'Invalid file name.', 400);
const notFound = () => refusal('ARTIFACT_NOT_FOUND', 'File not found.', 404);

export function createClaudeArtifacts({ home = os.homedir(), fs = fsDefault } = {}) {
  const root = path.join(home, 'pathwise', '.orchestrator');

  // The ticket's folder as a real path inside the root, or null: absent, not a folder, or a link
  // that leaves the root.
  function ticketDirectory(key) {
    const dir = path.join(root, key.toLowerCase());
    try {
      if (!fs.lstatSync(dir).isDirectory()) return null;
      const real = fs.realpathSync(dir);
      return real.startsWith(`${fs.realpathSync(root)}${path.sep}`) ? real : null;
    } catch {
      return null;
    }
  }

  const order = (a, b) =>
    a.name === FIRST ? -1 : b.name === FIRST ? 1 : a.name.localeCompare(b.name);

  function list(key) {
    if (!isTicketKey(key)) throw invalidTicket();
    const dir = ticketDirectory(key);
    if (!dir) return { ok: true, key, files: [] };
    const files = [];
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      // `isFile()` is false for a symlink, so a link named `x.md` is not listed.
      if (!dirent.isFile() || !ARTIFACT_NAME.test(dirent.name)) continue;
      try {
        const { size, mtimeMs } = fs.statSync(path.join(dir, dirent.name));
        files.push({ name: dirent.name, size, updatedAt: new Date(mtimeMs).toISOString() });
      } catch {
        // Gone between the listing and the stat: it is not there.
      }
    }
    return { ok: true, key, files: files.sort(order).slice(0, MAX_ARTIFACTS) };
  }

  function read(key, name) {
    if (!isTicketKey(key)) throw invalidTicket();
    if (typeof name !== 'string' || !ARTIFACT_NAME.test(name)) throw invalidArtifact();
    const dir = ticketDirectory(key);
    if (!dir) throw notFound();
    const file = path.join(dir, name);
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile()) throw notFound();
      if (info.size > MAX_ARTIFACT_BYTES)
        throw refusal('ARTIFACT_TOO_LARGE', 'File is too large to show.', 413);
      return {
        ok: true,
        key,
        name,
        size: info.size,
        updatedAt: new Date(info.mtimeMs).toISOString(),
        text: fs.readFileSync(file, 'utf8'),
      };
    } catch (error) {
      if (error.code === 'ARTIFACT_NOT_FOUND' || error.code === 'ARTIFACT_TOO_LARGE') throw error;
      throw notFound();
    }
  }

  // name -> { stamp, value }: a verdict is read again only when the file's time or size changed.
  const verdicts = new Map();

  // The verdict of a ticket's `e2e.md` or `groom.md`, or null for anything else: the same ticket
  // and link checks as `read`, a regular file only, only the first VERDICT_HEAD_BYTES read (and the
  // file opened without following a link), and never an error.
  function verdict(key, name) {
    if (!isTicketKey(key) || !Object.hasOwn(VERDICT_FILES, name)) return null;
    try {
      const dir = ticketDirectory(key);
      if (!dir) return null;
      const file = path.join(dir, name);
      const info = fs.lstatSync(file);
      if (!info.isFile()) return null;
      const stamp = `${info.mtimeMs}:${info.size}`;
      const cached = verdicts.get(file);
      if (cached?.stamp === stamp) return cached.value;
      const head = Buffer.alloc(VERDICT_HEAD_BYTES);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let length;
      try {
        length = fs.readSync(fd, head, 0, VERDICT_HEAD_BYTES, 0);
      } finally {
        fs.closeSync(fd);
      }
      const value = parseVerdict(name, head.subarray(0, length));
      verdicts.delete(file);
      verdicts.set(file, { stamp, value });
      if (verdicts.size > MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value);
      return value;
    } catch {
      return null;
    }
  }

  return { list, read, verdict };
}
