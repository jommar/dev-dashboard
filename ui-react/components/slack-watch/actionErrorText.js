const SENTENCE_BY_CODE = {
  INVALID_LINK:
    'That link was not accepted. Paste a Slack message or thread link, at most 50 at a time.',
  INVALID_SESSION:
    'That session id is not valid. Choose a session from the list or paste a full session id.',
  WATCH_DISABLED:
    'Watching is off because the Claude home directory cannot be read. Make it readable, then try again.',
  REVISION_CONFLICT: 'The settings changed somewhere else. Reload the page, then try again.',
  INVALID_SETTINGS:
    'The watch settings were not accepted. Use 30 to 3600 seconds and a one-line notice, then save again.',
  PERSISTENCE_FAILED:
    'The dashboard could not save that change. Check that its settings folder can be written, then try again.',
  BODY_TOO_LARGE: 'That request was too large. Add fewer links at a time.',
  INVALID_JSON: 'The dashboard could not read that request. Reload the page, then try again.',
  OPERATION_FAILED:
    'The dashboard server could not finish that. Try again, and check the server log if it keeps failing.',
};

// A code with no sentence, including the client's own UNAVAILABLE, already carries readable text.
export const actionErrorText = ({ code, error }) =>
  Object.hasOwn(SENTENCE_BY_CODE, code) ? SENTENCE_BY_CODE[code] : error;
