// claude-log.mjs — the one line the dashboard logs when a stop or a resume of a Claude session does
// not go through: which step, why, the CLI's exit code and its output (cut short), the session's
// short id and the ticket. It goes to stderr like the rest of the backend's diagnostics, as one
// `[claude] ...` line with a JSON object, so a newline or a control character in CLI output cannot
// start a line of its own.
//
// The notice text is never logged: it is the user's message to the session, and a CLI that echoes
// its arguments would put it in the output, so it is cut out of the output before the line is built.

const OUTPUT_LIMIT = 2048;

// The output, with every copy of `notice` replaced and cut to the limit.
export function cliOutputForLog(output, notice) {
  let text = typeof output === 'string' ? output : '';
  if (typeof notice === 'string' && notice) text = text.replaceAll(notice, '[notice]');
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}…[cut]` : text;
}

export const defaultClaudeLog = (line) => console.error(line);

// `fields` are the facts of one failure, e.g. { step, reason, exitCode, output, session, ticket }.
// Undefined fields are left out, and anything that goes wrong while logging goes nowhere.
export function logClaudeFailure(log, fields) {
  try {
    log(`[claude] ${fields.step} failed ${JSON.stringify(fields)}`);
  } catch {
    // A broken log must not change the outcome of a send.
  }
}
