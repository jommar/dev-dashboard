// claude-prompts-init.mjs — `npm run claude:prompts` writes the three built-in prompt templates
// (placeholders intact) into the prompts folder as starter files to edit. A file that is already
// there is never overwritten.

import fsDefault from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLAUDE_PROMPTS_DIR, PROMPT_TEMPLATES, promptFileText } from './claude-prompts.mjs';

// One { name, path, status } per starter file, status `wrote` or `kept`.
export async function initPrompts({ dir, fs = fsDefault }) {
  fs.mkdirSync(dir, { recursive: true });
  return Object.entries(PROMPT_TEMPLATES).map(([template, text]) => {
    const name = `${template}.md`;
    const file = path.join(dir, name);
    try {
      // `wx` fails on an existing file, so nothing is ever replaced, even by a racing writer.
      fs.writeFileSync(file, promptFileText(text), { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return { name, path: file, status: 'kept' };
    }
    return { name, path: file, status: 'wrote' };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  for (const { path: file, status } of await initPrompts({ dir: CLAUDE_PROMPTS_DIR }))
    console.log(`${status} ${file}`);
}
