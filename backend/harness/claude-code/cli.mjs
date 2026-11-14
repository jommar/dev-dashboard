// cli.mjs — the Claude Code binary, the argument array of a chat turn and the commands that join a
// session in a terminal. The one place these strings are spelled.

export const BIN = 'claude';

const TURN_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
];

// The process of one chat turn: a fixed argument array that names the session, and the one stdin line
// that carries the message (never an argument, where `ps` would show it).
export const buildTurn = ({ sessionId, resuming, message }) => ({
  command: BIN,
  args: [...TURN_ARGS, ...(resuming ? ['--resume', sessionId] : ['--session-id', sessionId])],
  input: `${JSON.stringify({ type: 'user', message: { role: 'user', content: message } })}\n`,
});

export const commands = {
  attach: (shortId) => `${BIN} attach ${shortId}`,
  resume: (sessionId) => `${BIN} --resume ${sessionId}`,
};
