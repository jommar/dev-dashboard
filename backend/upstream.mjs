// upstream.mjs — the one place a Jira, GitHub or Slack failure is classified and remembered.
//
// `classifyResponse` / `classifyError` name a failure `auth`, `rate_limit`, `upstream`, `timeout` or
// `network`. A health record per integration keeps the last outcome (kind, status and time, never a
// URL, header, body or secret) for `GET /api/health`. `upstreamFetch` is the fetch the Jira and GitHub
// modules go through: it adds a timeout when the caller set none, records the outcome, tags a thrown
// failure with its kind and, after a rate limit that carries a retry time, answers further calls for
// that integration without a request until the time has passed (at most 15 minutes); that answer
// carries `coolDown: true`, so the HTTP layer does not log it again (the health record says why).
//
// The caller keeps its own error message: `upstreamError` only adds a code, the kind and a 502 hint to
// the `Error` the caller already builds, so the text tests and people read does not change.

export const INTEGRATIONS = ['github', 'jira', 'slack'];
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_COOL_DOWN_SEC = 900;

const LABELS = { github: 'GitHub', jira: 'Jira', slack: 'Slack' };
const SENTENCES = {
  auth: (label) => `${label} rejected the token.`,
  rate_limit: (label) => `${label} is rate limiting requests.`,
  timeout: (label) => `${label} did not answer in time.`,
  network: (label) => `${label} could not be reached.`,
  upstream: (label) => `${label} is having trouble answering.`,
};

// One fixed sentence for the error envelope; unknown names and kinds read as an upstream problem.
export function upstreamSentence(name, kind) {
  return (SENTENCES[kind] || SENTENCES.upstream)(LABELS[name] || 'An integration');
}

// A header of a Response, of a plain object, or of nothing (a test stub may have no headers).
function header(headers, name) {
  if (!headers) return null;
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  return value === undefined || value === null ? null : String(value);
}

function seconds(value) {
  const number = Number(value);
  return value !== null && Number.isFinite(number) && number > 0 ? Math.ceil(number) : null;
}

// `{ kind, status, retryAfterSec }` for a response that is not ok. 401 and a 403 with no rate-limit
// signal are `auth`; 429 and a 403 that says so (remaining 0 or Retry-After) are `rate_limit`, with
// the retry time from Retry-After or x-ratelimit-reset; anything else is `upstream`.
export function classifyResponse(status, headers, now = Date.now()) {
  const retryHeader = seconds(header(headers, 'retry-after'));
  const resetAt = Number(header(headers, 'x-ratelimit-reset'));
  const exhausted = header(headers, 'x-ratelimit-remaining') === '0';
  const limited = status === 429 || (status === 403 && (exhausted || retryHeader !== null));
  if (limited) {
    const untilReset =
      Number.isFinite(resetAt) && resetAt > 0 ? seconds(resetAt - now / 1000) : null;
    return { kind: 'rate_limit', status, retryAfterSec: retryHeader ?? untilReset };
  }
  if (status === 401 || status === 403) return { kind: 'auth', status, retryAfterSec: null };
  return {
    kind: 'upstream',
    status: Number.isInteger(status) ? status : null,
    retryAfterSec: null,
  };
}

// A thrown fetch failure: a timeout or abort is `timeout`, everything else the transport raises is `network`.
export function classifyError(error) {
  const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
  return { kind: timedOut ? 'timeout' : 'network', status: null, retryAfterSec: null };
}

function statusOf(res) {
  if (Number.isInteger(res?.status)) return res.status;
  return res?.ok === false ? 500 : 200;
}

function isOk(res) {
  return typeof res?.ok === 'boolean' ? res.ok : statusOf(res) < 400;
}

// The `Error` a caller throws for a response that is not ok, still with its own `message`.
export function upstreamError(name, res, message, now = Date.now()) {
  const { kind, retryAfterSec } = classifyResponse(statusOf(res), res?.headers, now);
  return Object.assign(new Error(message), {
    code: 'UPSTREAM_FAILED',
    errors: [kind],
    statusHint: 502,
    upstream: { name, kind, ...(retryAfterSec ? { retryAfterSec } : {}) },
  });
}

// What a failure carries when it came from an upstream call, or null.
export function upstreamOf(error) {
  const upstream = error?.upstream;
  return upstream && typeof upstream.name === 'string' && typeof upstream.kind === 'string'
    ? upstream
    : null;
}

export function createUpstreamHealth({ now = () => Date.now() } = {}) {
  const records = new Map(
    INTEGRATIONS.map((name) => [name, { lastOkAt: null, lastFailure: null }]),
  );
  const blockedUntil = new Map();
  const iso = () => new Date(now()).toISOString();

  function recordOk(name) {
    const record = records.get(name);
    if (!record) return;
    record.lastOkAt = iso();
    record.lastFailure = null;
    blockedUntil.delete(name);
  }

  function recordFailure(name, { kind, status = null, retryAfterSec = null }) {
    const record = records.get(name);
    if (!record) return;
    record.lastFailure = { kind, status, at: iso(), retryAfterSec };
    if (kind === 'rate_limit' && retryAfterSec)
      blockedUntil.set(name, now() + Math.min(retryAfterSec, MAX_COOL_DOWN_SEC) * 1000);
  }

  // Slack, which owns its own fetch, hands over what an answer said.
  function recordResponse(name, status, headers) {
    if (status >= 200 && status < 400) recordOk(name);
    else recordFailure(name, classifyResponse(status, headers, now()));
  }

  function snapshot() {
    return Object.fromEntries(
      INTEGRATIONS.map((name) => {
        const { lastOkAt, lastFailure } = records.get(name);
        const status = !lastFailure && !lastOkAt ? 'unknown' : lastFailure ? 'degraded' : 'ok';
        return [name, { status, lastOkAt, lastFailure: lastFailure && { ...lastFailure } }];
      }),
    );
  }

  function reset() {
    for (const record of records.values())
      Object.assign(record, { lastOkAt: null, lastFailure: null });
    blockedUntil.clear();
  }

  async function upstreamFetch(name, url, init = {}) {
    const until = blockedUntil.get(name);
    if (until !== undefined && until > now()) {
      const retryAfterSec = Math.ceil((until - now()) / 1000);
      throw Object.assign(new Error(`${name} is rate limited: retry in ${retryAfterSec} s`), {
        code: 'UPSTREAM_FAILED',
        errors: ['rate_limit'],
        statusHint: 502,
        coolDown: true,
        upstream: { name, kind: 'rate_limit', retryAfterSec },
      });
    }
    const options = init.signal
      ? init
      : { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    let res;
    try {
      res = await globalThis.fetch(url, options);
    } catch (error) {
      const failure = classifyError(error);
      recordFailure(name, failure);
      try {
        error.upstream = { name, kind: failure.kind };
      } catch {
        // A frozen or non-object error is rethrown as it is.
      }
      throw error;
    }
    if (isOk(res)) recordOk(name);
    else recordFailure(name, classifyResponse(statusOf(res), res.headers, now()));
    return res;
  }

  return { fetch: upstreamFetch, recordOk, recordFailure, recordResponse, snapshot, reset };
}

export const upstreamHealth = createUpstreamHealth();
export const upstreamFetch = (name, url, init) => upstreamHealth.fetch(name, url, init);
