// log.mjs — the one-line `[tag] {json}` failure log of the HTTP layer and the server process, a sibling
// of claude-log.mjs. It goes to stderr like the rest of the backend's diagnostics, as one line with a
// JSON object, so a newline or a control character in a message cannot start a line of its own.
//
// A line carries facts about a failure (route, status, error name and code, a scrubbed first line of
// the message), never a request body, a query, a header, a token or anything a person said. The
// callers choose the fields; `scrubMessage` is the one place a message is made safe to print.

const MESSAGE_LIMIT = 200;

export const defaultLog = (line) => console.error(line);

// The first line of `text`, with tokens, URL userinfo and URL queries hidden, cut to 200 characters. Not a string: ''.
export function scrubMessage(text) {
  if (typeof text !== 'string') return '';
  const line = text
    .split('\n', 1)[0]
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/g, '$1 [token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, '[token]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]+/g, '[token]')
    .replace(/\bxox[a-z]-[A-Za-z0-9%._-]+/g, '[token]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1[token]@')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, '$1');
  return line.slice(0, MESSAGE_LIMIT);
}

// `fields` are the facts of one failure; undefined fields are left out, and anything that goes wrong
// while logging goes nowhere: a broken log must not change a reply or a shutdown.
export function logLine(log, tag, fields) {
  try {
    log(`[${tag}] ${JSON.stringify(fields)}`);
  } catch {
    // Deliberately silent.
  }
}
