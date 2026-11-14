// claude-code/index.mjs — the Claude Code adapter: the first harness and the default. Its pieces sit in
// this directory; this file only composes them.
import { BIN, buildTurn, commands } from './cli.mjs';
import { historyItems, liveMessages } from './chat-items.mjs';
import { createClaudeSessions, homeReadable } from './sessions.mjs';
import { specReview } from './spec-review.mjs';
import { parseLine } from './usage.mjs';

export default Object.freeze({
  id: 'claude-code',
  label: 'Claude Code',
  name: 'Claude',
  command: BIN,
  prompt: Object.freeze({ skill: 'skill', askTool: 'a question tool' }),
  createSessions: createClaudeSessions,
  homeReadable,
  commands: Object.freeze(commands),
  chat: Object.freeze({ buildTurn, liveMessages, historyItems }),
  usage: Object.freeze({ parseLine }),
  limits: Object.freeze({ specReview }),
});
