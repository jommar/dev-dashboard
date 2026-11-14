// upstream-health.js — the sentence a board note shows for an integration GET /api/health calls
// degraded. Pure: no React, no clock of its own (`now` is a millisecond epoch the caller passes).

const LABELS = { github: 'GitHub', jira: 'Jira', slack: 'Slack' };

const label = (name) => LABELS[name] ?? String(name);

// " retry in 4 min" / " retry in 30 s" while the wait is not over, else nothing.
function retryClause(failure, now) {
  const at = Date.parse(failure.at);
  if (!Number.isFinite(at) || !Number.isFinite(failure.retryAfterSec)) return '';
  const remainingSec = (at + failure.retryAfterSec * 1000 - now) / 1000;
  if (!(remainingSec > 0)) return '';
  return remainingSec >= 60
    ? `: retry in ${Math.ceil(remainingSec / 60)} min`
    : `: retry in ${Math.ceil(remainingSec)} s`;
}

function sentence(name, failure, now) {
  const who = label(name);
  switch (failure.kind) {
    case 'auth':
      return name === 'slack'
        ? 'Slack rejected the session. Reconnect Slack.'
        : `${who} rejected the token. Check Settings.`;
    case 'rate_limit':
      return `${who} is rate limiting requests${retryClause(failure, now)}.`;
    case 'timeout':
      return `${who} did not answer in time.`;
    case 'network':
      return `${who} could not be reached.`;
    default:
      return `${who} is having trouble answering.`;
  }
}

// The sentence for one integration entry, or null when it is ok, unknown, or not a usable entry.
export function describeUpstream(name, entry, now) {
  if (entry?.status !== 'degraded') return null;
  const failure = entry.lastFailure;
  if (!failure || typeof failure !== 'object') return null;
  return sentence(name, failure, now);
}

// `[{ name, testId, text }]` for each of `names` (a screen's integrations, in order) that the whole
// health body calls degraded; empty for a body that is missing or not what the route sends.
export function degradedNotes(health, names, now) {
  const integrations = health?.integrations;
  if (!integrations || typeof integrations !== 'object' || !Array.isArray(names)) return [];
  return names.flatMap((name) => {
    const text = describeUpstream(name, integrations[name], now);
    return text ? [{ name, testId: `${name}-upstream`, text }] : [];
  });
}
