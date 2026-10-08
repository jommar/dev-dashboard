// env.mjs — load dev-dashboard/.env (gitignored) into process.env once, so the
// token works for the server and the CLI without the user exporting it first.
// Only keys not already set are filled in — an explicit env var always wins.
// Parsing is a minimal KEY=VALUE scan; values are used verbatim, so quote-free
// shells-style values are fine.
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// env.mjs lives in <dashboard>/backend/, so the .env file is one level up.
const DASHBOARD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnvFile({
  directory = DASHBOARD_DIR,
  env = process.env,
  fs: filesystem = fs,
} = {}) {
  const result = { ...env };
  const envPath = new URL('./.env', `file://${directory}/`);
  try {
    const text = filesystem.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      )
        value = value.slice(1, -1);
      if (key && !(key in result)) result[key] = value;
    }
  } catch {
    /* no .env — fall through to process.env only */
  }
  return result;
}
