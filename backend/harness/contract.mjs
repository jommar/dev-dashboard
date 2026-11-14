// contract.mjs — the shape every harness adapter has (see README "Harness adapter contract").
// `assertHarness` throws on a malformed adapter; the registry runs it on every entry when it loads, so
// a bad adapter fails every run instead of one feature.

export const HARNESS_ID = /^[a-z][a-z0-9-]{0,31}$/;
const TEXT_LIMIT = 40;

// The optional facets and the functions each must have when it is present.
const FACETS = {
  chat: ['buildTurn', 'liveMessages', 'historyItems'],
  usage: ['parseLine'],
  limits: ['specReview'],
};

const isFunction = (value) => typeof value === 'function';

export function assertHarness(harness) {
  const bad = (message) => {
    throw new Error(`Invalid harness ${harness?.id ?? '(no id)'}: ${message}.`);
  };
  if (!harness || typeof harness !== 'object') bad('not an object');
  if (typeof harness.id !== 'string' || !HARNESS_ID.test(harness.id)) bad('id');
  for (const member of ['label', 'name', 'command'])
    if (
      typeof harness[member] !== 'string' ||
      !harness[member] ||
      harness[member].length > TEXT_LIMIT
    )
      bad(member);
  for (const member of ['skill', 'askTool'])
    if (
      typeof harness.prompt?.[member] !== 'string' ||
      !harness.prompt[member] ||
      harness.prompt[member].length > TEXT_LIMIT
    )
      bad(`prompt.${member}`);
  for (const member of ['createSessions', 'homeReadable'])
    if (!isFunction(harness[member])) bad(member);
  for (const member of ['attach', 'resume'])
    if (!isFunction(harness.commands?.[member])) bad(`commands.${member}`);
  for (const [facet, members] of Object.entries(FACETS)) {
    if (harness[facet] === undefined) continue;
    for (const member of members)
      if (!isFunction(harness[facet]?.[member])) bad(`${facet}.${member}`);
  }
}

// The methods of the sessions service `createSessions` returns: all the launcher, chat and Slack
// watcher call. The service is built per server, not at registry load, so the check runs where it is
// built (`createHttpHandler`) and in the conformance suite.
export const SESSION_METHODS = [
  'entries',
  'listSessions',
  'launch',
  'stop',
  'resume',
  'lastActive',
  'transcriptFile',
  'transcriptFiles',
  'recoverSessionIds',
  'beginTurn',
  'isHeld',
];

export function assertSessions(sessions, harnessId) {
  for (const method of SESSION_METHODS)
    if (!isFunction(sessions?.[method]))
      throw new Error(`Invalid harness ${harnessId}: sessions.${method}.`);
  return sessions;
}
