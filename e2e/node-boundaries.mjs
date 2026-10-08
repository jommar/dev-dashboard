import { registerHooks, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const temporaryParent = path.join(repository, 'test', '.settings-tmp');
fs.mkdirSync(temporaryParent, { recursive: true });
const isolatedHome = fs.mkdtempSync(path.join(temporaryParent, 'process-'));
// Test processes inherit no user environment; runtime lookup uses a fixed tool path.
for (const key of Object.keys(process.env)) delete process.env[key];
process.env.PATH = [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
process.env.LANG = 'C.UTF-8';
process.env.TZ = 'UTC';
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.XDG_CONFIG_HOME = path.join(isolatedHome, '.config');
process.env.NVM_DIR = path.join(isolatedHome, '.nvm');
os.homedir = () => isolatedHome;
let syntheticEnvRead = null;

export function withSyntheticEnvRead(moduleUrl, directory, operation) {
  const modulePath = fileURLToPath(moduleUrl);
  const filename = path.resolve(directory, '.env');
  if (
    !modulePath.startsWith(temporaryParent + path.sep) ||
    !/^case-[^/]+\/dashboard\/env\.mjs$/.test(path.relative(temporaryParent, modulePath)) ||
    filename !== path.join(path.dirname(modulePath), '.env') ||
    fs.realpathSync(path.dirname(modulePath)) !== path.dirname(modulePath) ||
    fs.lstatSync(modulePath).isSymbolicLink() ||
    !fs.lstatSync(filename).isFile() ||
    fs.lstatSync(filename).isSymbolicLink()
  ) {
    throw new Error('Test boundary: synthetic loader location required');
  }
  const previous = syntheticEnvRead;
  syntheticEnvRead = filename;
  try {
    return operation();
  } finally {
    syntheticEnvRead = previous;
  }
}

function guard(file, reading = false) {
  if (typeof file !== 'string' && !(file instanceof URL) && !Buffer.isBuffer(file)) return;
  const filename = path.resolve(file instanceof URL ? fileURLToPath(file) : String(file));
  if (
    path.basename(filename) === '.env' &&
    ((reading && filename !== syntheticEnvRead) || !filename.startsWith(temporaryParent + path.sep))
  ) {
    throw new Error('Test boundary: legacy env file reads forbidden');
  }
  if (
    filename.startsWith(path.dirname(repository.slice(0, -1)) + path.sep) &&
    !filename.startsWith(temporaryParent + path.sep) &&
    /[/\\](\.nvmrc|node_modules)([/\\]|$)/.test(filename)
  ) {
    throw new Error('Test boundary: production runtime inspection forbidden');
  }
  if (
    /[/\\]\.config[/\\](github[/\\]token|jira[/\\]token|dev-dashboard[/\\]settings\.json)/.test(
      filename,
    ) &&
    !filename.startsWith(temporaryParent + path.sep)
  ) {
    throw new Error('Test boundary: non-isolated settings or credentials forbidden');
  }
}

function opensForReading(flags = 'r') {
  if (typeof flags === 'number') {
    return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== fs.constants.O_WRONLY;
  }
  return !/^[wa][^+]*$/.test(flags);
}

for (const name of ['createReadStream', 'createWriteStream']) {
  const original = fs[name];
  fs[name] = function (file, ...args) {
    guard(file, name === 'createReadStream');
    return original.call(this, file, ...args);
  };
}

for (const name of [
  'readFileSync',
  'writeFileSync',
  'appendFileSync',
  'openSync',
  'chmodSync',
  'lstatSync',
  'statSync',
  'accessSync',
  'unlinkSync',
  'rmSync',
  'existsSync',
  'mkdirSync',
  'renameSync',
]) {
  const original = fs[name];
  fs[name] = function (file, ...args) {
    guard(file, name === 'readFileSync' || (name === 'openSync' && opensForReading(args[0])));
    if (name === 'renameSync') guard(args[0]);
    return original.call(this, file, ...args);
  };
}
for (const name of [
  'readFile',
  'writeFile',
  'appendFile',
  'open',
  'chmod',
  'lstat',
  'stat',
  'access',
  'unlink',
  'rm',
  'mkdir',
  'rename',
]) {
  const original = fs.promises[name];
  fs.promises[name] = async function (file, ...args) {
    guard(file, name === 'readFile' || (name === 'open' && opensForReading(args[0])));
    if (name === 'rename') guard(args[0]);
    return original.call(this, file, ...args);
  };
  const callbackOriginal = fs[name];
  fs[name] = function (file, ...args) {
    guard(file, name === 'readFile' || (name === 'open' && opensForReading(args[0])));
    if (name === 'rename') guard(args[0]);
    return callbackOriginal.call(this, file, ...args);
  };
}
globalThis.fetch = async () => {
  throw new Error('Test boundary: unexpected outbound request');
};
syncBuiltinESMExports();
process.on('exit', () => {
  fs.rmSync(isolatedHome, { recursive: true, force: true });
  try {
    fs.rmdirSync(temporaryParent);
  } catch {
    /* Other test processes may still own homes. */
  }
});

const envModule = new URL('../backend/env.mjs', import.meta.url).href;

// Factories remain real; only the legacy env loader is intercepted.
registerHooks({
  load(url, context, nextLoad) {
    if (url === envModule) {
      return { format: 'module', source: 'export function loadEnvFile() {}', shortCircuit: true };
    }
    if (
      url.startsWith(new URL('../test/.settings-tmp/', import.meta.url).href) &&
      /^case-[^/]+\/dashboard\/env\.mjs$/.test(path.relative(temporaryParent, fileURLToPath(url)))
    ) {
      const loaded = nextLoad(url, context);
      const source = String(loaded.source).replace(
        'export function loadEnvFile(',
        'function loadSyntheticEnvFile(',
      );
      return {
        ...loaded,
        source:
          source +
          `\nimport { withSyntheticEnvRead } from ${JSON.stringify(import.meta.url)};
        export function loadEnvFile(options = {}) {
          return withSyntheticEnvRead(import.meta.url, options.directory, () => loadSyntheticEnvFile(options));
        }\n`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
