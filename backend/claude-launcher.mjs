// claude-launcher.mjs — starts an investigate-and-plan or implement-plan Claude session for a
// ticket, records what it started, collects the answers the planning session asked for, sends them
// back to that session once every question has one, and lists where every ticket stands.
//
// A ticket's state is two files under `<stateDir>/<KEY>/`: `status.json`, shared with the session
// (the two phase flags, `done` and the questions), and `launch.json`, written only here (which
// session belongs to which phase, and what was last sent to it). The session writes `status.json`
// only while it works and this module only while no session works; every write is a temp file,
// fsync and rename, under one lock per ticket.
//
// Launch prompts, answers, the approval and re-review messages use editable templates.
// Only validated keys, slugs, built paths, question ids, PR numbers and registry ports are interpolated,
// never ticket text.

import fsDefault from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DASHBOARD_DIR } from './config.mjs';
import { writeFileAtomic } from './credentials.mjs';
import { stateOf } from './claude-sessions.mjs';
import { defaultClaudeLog, logClaudeFailure } from './claude-log.mjs';
import { createPromptStore, PROMPT_TEMPLATES } from './claude-prompts.mjs';
import { BROWSER_ID, PORT_FIRST, PORT_LAST } from './browser-devtools.mjs';
import {
  ANSWER_MAX_LENGTH,
  E2E,
  GROOM,
  IMPLEMENT,
  INVESTIGATE,
  PHASES,
  REVIEW,
  SPEC_REVIEW,
  answerHash,
  answersToSend,
  currentRecord,
  deriveEntry,
  approveBlock,
  implementBlock,
  implementStatus,
  isQuestionId,
  isShortId,
  isTicketKey,
  phaseSessions,
  readE2e,
  readGroom,
  readLaunch,
  readQuestions,
  readReview,
  readSpecReview,
  resolveSession,
  rereviewBlock,
  reviewBlock,
  runningBlock,
  sessionName,
  sessionRunning,
  sideActionState,
} from './claude-ticket-state.mjs';

// The built-in prompt texts and the prompts folder belong to the prompt store.
export { CLAUDE_PROMPTS_DIR, PROMPT_TEMPLATES } from './claude-prompts.mjs';

export const CLAUDE_STATE_DIR = path.join(DASHBOARD_DIR, 'claude');

const ANSWER_LIMIT = 20;
// After a stop the session is polled until its entry has no pid: the CLI's stop returns before the
// process is gone, and a resume in that gap starts a copy of the session instead of continuing it.
export const FINISH_POLL_MS = 1_000;
export const FINISH_POLL_LIMIT = 30;
// What the dashboard reads of session-writable state: a bigger file is unreadable, and only this
// many ticket folders are listed.
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_TICKETS = 500;
const PLAN_FILE = '02-plan.md';
const RESET_STATUS = {
  [INVESTIGATE]: false,
  [IMPLEMENT]: false,
  done: false,
  approved: false,
  questions: [],
};

const PROMPT_NAME = {
  [INVESTIGATE]: 'investigate',
  [IMPLEMENT]: 'implement',
  [GROOM]: 'groom',
  [REVIEW]: 'review',
  [SPEC_REVIEW]: 'spec-review',
  [E2E]: 'e2e',
};

// What the spec review launch enforces on the command line, which no prompt can widen. The built-in
// tools are only these (no Bash, Edit, Write, Grep, Glob, WebFetch or Agent), so the `Read` deny rules
// are the only file limit. The deny list is an explicit list of named toolkit write tools and `Read`
// paths, not an exhaustive one: reads inside the working directory are otherwise unrestricted. The read
// tools, `github_submit_pr_review` and the Slack prepare and confirm pair stay allowed. Other launches
// get none of these flags.
const SPEC_REVIEW_LIMITS = {
  tools: ['Read', 'Skill', 'ToolSearch'],
  disallowedTools: [
    'mcp__toolkit-mcp__github_add_pr_comment',
    'mcp__toolkit-mcp__github_create_pr',
    'mcp__toolkit-mcp__github_create_pr_review_comment',
    'mcp__toolkit-mcp__github_delete_pr_issue_comment',
    'mcp__toolkit-mcp__github_delete_pr_review_comment',
    'mcp__toolkit-mcp__github_dismiss_pr_review',
    'mcp__toolkit-mcp__github_merge_pr',
    'mcp__toolkit-mcp__github_request_pr_reviewers',
    'mcp__toolkit-mcp__github_resolve_review_thread',
    'mcp__toolkit-mcp__github_unresolve_review_thread',
    'mcp__toolkit-mcp__github_update_pr',
    'mcp__toolkit-mcp__github_update_pr_assignees',
    'mcp__toolkit-mcp__github_update_pr_comment',
    'mcp__toolkit-mcp__github_update_pr_labels',
    'mcp__toolkit-mcp__github_update_pr_review_comment',
    'mcp__toolkit-mcp__jira_add_comment',
    'mcp__toolkit-mcp__jira_assign_issue',
    'mcp__toolkit-mcp__jira_create_issue',
    'mcp__toolkit-mcp__jira_delete_comment',
    'mcp__toolkit-mcp__jira_link_issues',
    'mcp__toolkit-mcp__jira_transition_issue',
    'mcp__toolkit-mcp__jira_update_comment',
    'mcp__toolkit-mcp__jira_update_issue',
    'mcp__toolkit-mcp__confluence_create_page',
    'mcp__toolkit-mcp__confluence_update_page',
    'mcp__toolkit-mcp__figma_post_comment',
    'mcp__toolkit-mcp__slack_login',
    'mcp__toolkit-mcp__slack_logout',
    'Read(~/.config/**)',
    'Read(~/.ssh/**)',
    'Read(~/.aws/**)',
    'Read(~/.claude.json)',
    'Read(**/.env*)',
    'Read(**/config.json)',
    'Read(**/config.json.*)',
    'Read(**/.mcp.json)',
    'Read(**/*.sql)',
    'Read(./.worktrees/**)',
    'Read(./.corpus_runs/**)',
    'Read(~/.claude/.credentials.json)',
    'Read(~/.claude/projects/**)',
    'Read(~/.claude/history.jsonl)',
    'Read(~/.bash_history*)',
    'Read(~/.local/share/**)',
    'Read(~/.git-credentials)',
    'Read(~/.npmrc)',
    'Read(~/.netrc)',
    'Read(~/.docker/**)',
    'Read(~/.gnupg/**)',
    'Read(//ezat/**)',
    'Read(**/*.csv)',
    'Read(./TravelTracker/files/**)',
    'Read(**/.playwright/**)',
    'Read(./.playwright-mcp/**)',
    'Read(**/cypress.env.json)',
    'Read(**/auth.json)',
  ],
};

// The launch record a side action refuses its own relaunch on.
const OWN_SESSION_RECORD = { [GROOM]: readGroom, [SPEC_REVIEW]: readSpecReview, [E2E]: readE2e };

// Fills `{NAME}` placeholders from `values`. A function replaces them, so a `$` in a value or in the
// template is never a replacement pattern, and a name that is not in `values` stays as written.
const fillTemplate = (template, values) =>
  template.replace(/\{([A-Z_]+)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? values[name] : match,
  );

// The built-in E2E text, with the same validated key/registry-port values the launcher supplies.
export const e2ePrompt = (key, port) =>
  fillTemplate(PROMPT_TEMPLATES.e2e, { KEY: key, SLUG: key.toLowerCase(), PORT: port });

// Why a send that did not go through failed: how a stop that did not stop and a resume that did not
// deliver are reported. A resume that listed no such session routed nothing, so it fails too.
const STOP_FAILURES = { not_idle: 'session_running', not_listed: 'session_not_found' };
const sendFailed = (reason) => ({ status: 'failed', reason });
function resumeFailure({ status, reason }) {
  if (status === 'delivered') return reason === 'not_listed' ? 'session_not_found' : null;
  return status === 'waiting' ? 'live_at_resume' : 'resume_failed';
}

const invalid = (code, message) => Object.assign(new Error(message), { code, status: 400 });
const refused = (reason) =>
  Object.assign(new Error('Claude action refused.'), {
    code: 'CLAUDE_REFUSED',
    status: 409,
    errors: [reason],
  });
export const failed = (reason) =>
  Object.assign(new Error('Claude action failed.'), {
    code: 'CLAUDE_FAILED',
    status: 502,
    errors: [reason],
  });

export function createClaudeLauncher({
  claudeSessions,
  stateDir = CLAUDE_STATE_DIR,
  home = os.homedir(),
  fs = fsDefault,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  promptsDir,
  log = defaultClaudeLog,
  // The DevTools registry, as `{ list, stop }`: there is deliberately no remove, so a browser's
  // signed-in profile is never deleted from here.
  browsers = { list: async () => [], stop: async () => {} },
}) {
  const launchDirectory = path.join(home, 'pathwise');
  const locks = new Map();

  const ticketDir = (key) => path.join(stateDir, key);
  const statusPath = (key) => path.join(ticketDir(key), 'status.json');
  const launchPath = (key) => path.join(ticketDir(key), 'launch.json');
  const planPath = (key) =>
    path.join(launchDirectory, '.orchestrator', key.toLowerCase(), PLAN_FILE);

  // `text` is the file's bytes (null when absent). `value` is its parsed JSON object: undefined
  // when the file is absent, null when it is not a JSON object.
  function readObject(file) {
    let text;
    try {
      if (fs.statSync(file).size > MAX_STATE_BYTES) return { text: null, value: null };
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      return { text: null, value: error.code === 'ENOENT' ? undefined : null };
    }
    try {
      const value = JSON.parse(text);
      const isObject = value && typeof value === 'object' && !Array.isArray(value);
      return { text, value: isObject ? value : null };
    } catch {
      return { text, value: null };
    }
  }

  const writeJson = (file, value) =>
    writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, fs);

  // Puts a file back as `readObject` found it.
  const restore = (file, { text }) =>
    text === null ? fs.rmSync(file, { force: true }) : writeFileAtomic(file, text, fs);

  const planExists = (key) => {
    try {
      return fs.statSync(planPath(key)).isFile();
    } catch {
      return false;
    }
  };

  const promptStore = createPromptStore({ promptsDir, fs });

  // The template named `name`, read now: the user's file or the built-in text. Null when the file is
  // there but cannot be used: it is never replaced by the built-in text.
  function promptTemplate(name) {
    const { source, text } = promptStore.read(name);
    return source === 'unusable' ? null : text;
  }

  // A review message has no status file either: only the key and its lower-case form.
  const rereviewValues = (key) => ({ KEY: key, SLUG: key.toLowerCase() });

  // A groom prompt has no status file, so `{STATUS_FILE}` stays as written in it.
  const promptValues = (key, phase) => ({
    KEY: key,
    SLUG: key.toLowerCase(),
    ...(phase !== GROOM && { STATUS_FILE: statusPath(key) }),
  });

  function ticketKeys() {
    try {
      return fs
        .readdirSync(stateDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory() && isTicketKey(dirent.name))
        .map((dirent) => dirent.name)
        .slice(0, MAX_TICKETS);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  // An absent status.json reads as an empty one; an unreadable one stays null.
  const statusOf = ({ value }) => (value === undefined ? {} : value);

  // The card's entry, from the files as they are now and a listing.
  function ticketEntry(key, entries) {
    const status = statusOf(readObject(statusPath(key)));
    return deriveEntry({
      status,
      launch: readObject(launchPath(key)).value ?? null,
      entries,
      now: now(),
      planPresent: status?.[INVESTIGATE] === true && planExists(key),
    });
  }

  // One launch or answer at a time per ticket, so their reads and writes never interleave.
  function withTicketLock(key, task) {
    const result = (locks.get(key) ?? Promise.resolve()).then(task);
    const settled = result.catch(() => {});
    locks.set(key, settled);
    settled.then(() => {
      if (locks.get(key) === settled) locks.delete(key);
    });
    return result;
  }

  // A decision to write rests on a listing read now; without one the launcher fails closed.
  async function freshListing() {
    const entries = await claudeSessions.entries({ fresh: true });
    if (!entries) throw failed('listing_unavailable');
    return entries;
  }

  // Refuses while a phase's session works, naming which one when it is not the phase asked for. An
  // answer asks for no phase and is refused as `session_running` whichever works.
  const requireNoRunningSession = (entries, launched, asked) => {
    const running = readLaunch(launched.value).find((record) =>
      sessionRunning(entries, record, now()),
    );
    if (running) throw refused(runningBlock(running.phase, asked ?? running.phase));
  };

  // The listed session the CLI just started: the one with the id it printed, else the newest with
  // the launch's name since the launch.
  const startedSession = (entries, printedId, record) =>
    (printedId && entries?.find(({ id }) => id === printedId)) ||
    (entries && resolveSession(entries, record)) ||
    null;

  // The port of a running DevTools browser, else the refusal: not in the registry, or not running
  // on a port in the dashboard's range.
  async function e2ePort(browserId) {
    const browser = (await browsers.list()).find(({ id }) => id === browserId);
    if (!browser) throw refused('browser_not_found');
    const { port } = browser;
    if (
      browser.status !== 'running' ||
      !(Number.isInteger(port) && port >= PORT_FIRST && port <= PORT_LAST)
    )
      throw refused('browser_not_running');
    return port;
  }

  async function launchLocked(key, phase, pr, browserId) {
    const entries = await freshListing();
    const isWorkflow = PHASES.includes(phase);
    // Independent actions never read, write or restore workflow status during launch.
    const status = isWorkflow ? readObject(statusPath(key)) : null;
    const launched = readObject(launchPath(key));
    if (OWN_SESSION_RECORD[phase]) {
      // Only a session of its own phase refuses a launch of that phase, and it refuses nothing else.
      const earlier = OWN_SESSION_RECORD[phase](launched.value);
      if (earlier && sessionRunning(entries, earlier, now())) throw refused('session_running');
    } else if (phase === REVIEW) {
      const review = sideActionState(readReview(launched.value), entries, now());
      const reason = reviewBlock(review, entries);
      if (reason) throw refused(reason);
    } else requireNoRunningSession(entries, launched, phase);
    if (phase === IMPLEMENT) {
      const reason = implementBlock(statusOf(status), launched.value, planExists(key));
      if (reason) throw refused(reason);
    }

    const port = phase === E2E ? await e2ePort(browserId) : undefined;

    // A prompt file that cannot be used refuses the launch before anything is written or started.
    const template = promptTemplate(PROMPT_NAME[phase]);
    if (!template) throw refused('prompt_unreadable');
    // Review, spec review and E2E have no workflow status-file access. Only the matching side
    // action gets its validated PR number or registry port; all other placeholders stay literal.
    const values = [REVIEW, SPEC_REVIEW, E2E].includes(phase)
      ? {
          ...rereviewValues(key),
          ...(phase === SPEC_REVIEW && { PR: pr }),
          ...(phase === E2E && { PORT: port }),
        }
      : promptValues(key, phase);

    const name = sessionName(key, phase);
    const record = { name, launchedAt: now(), id: null, ...(phase === E2E && { browserId }) };
    if (phase === IMPLEMENT) {
      // The answers saved for questions the implement session asked stay answered on a relaunch.
      const earlier = readLaunch(launched.value).find((found) => found.phase === IMPLEMENT);
      if (earlier && Object.keys(earlier.answered).length) record.answered = earlier.answered;
    }
    // Investigate resets only the workflow, retaining side records including extension metadata.
    const kept =
      phase === INVESTIGATE
        ? {
            ...(launched.value?.[GROOM] && { [GROOM]: launched.value[GROOM] }),
            ...(launched.value?.[REVIEW] && { [REVIEW]: launched.value[REVIEW] }),
            ...(launched.value?.[SPEC_REVIEW] && { [SPEC_REVIEW]: launched.value[SPEC_REVIEW] }),
            ...(launched.value?.[E2E] && { [E2E]: launched.value[E2E] }),
          }
        : launched.value;
    const nextLaunch = { ...kept, [phase]: record };
    const nextStatus =
      phase === IMPLEMENT ? implementStatus(status.value, launched.value) : RESET_STATUS;
    const rollback = () => {
      restore(launchPath(key), launched);
      if (status) restore(statusPath(key), status);
      // A first launch that failed leaves no folder, so the list never polls the CLI for it.
      try {
        fs.rmdirSync(ticketDir(key));
      } catch {}
    };

    let result;
    try {
      writeJson(launchPath(key), nextLaunch);
      if (isWorkflow) writeJson(statusPath(key), nextStatus);
      result = await claudeSessions.launch({
        name,
        prompt: fillTemplate(template, values),
        cwd: launchDirectory,
        // Independent actions get no access to the workflow state folder.
        ...(isWorkflow && { addDir: stateDir }),
        ...(phase === SPEC_REVIEW && {
          ...SPEC_REVIEW_LIMITS,
          // The launch directory's MCP config, loaded alone (`--strict-mcp-config`): the servers it names.
          mcpConfig: path.join(launchDirectory, '.mcp.json'),
        }),
      });
    } catch (error) {
      rollback();
      throw error;
    }
    if (result.status !== 'delivered') {
      // After a timeout the session may exist, so the written state stays and the listing decides.
      if (result.reason !== 'timed_out') rollback();
      throw failed(result.reason);
    }

    const listing = await claudeSessions.entries({ fresh: true });
    const found = startedSession(listing, result.id, record)?.id;
    const id = isShortId(found) ? found : null;
    if (id) writeJson(launchPath(key), { ...nextLaunch, [phase]: { ...record, id } });
    return { ok: true, key, phase, name, id, ticket: ticketEntry(key, listing) };
  }

  async function launch({ key, phase, pr, browserId }) {
    if (!isTicketKey(key) || ![...PHASES, GROOM, REVIEW, SPEC_REVIEW, E2E].includes(phase))
      throw invalid('INVALID_TICKET', 'Invalid ticket or phase.');
    if (phase === SPEC_REVIEW && !(Number.isSafeInteger(pr) && pr > 0))
      throw invalid('INVALID_TICKET', 'Invalid pull request number.');
    if (phase === E2E && !(typeof browserId === 'string' && BROWSER_ID.test(browserId)))
      throw invalid('INVALID_TICKET', 'Invalid browser.');
    return withTicketLock(key, () => launchLocked(key, phase, pr, browserId));
  }

  // Asks the ticket's existing review session to review the linked PRs again. It needs a review
  // session that exists and is idle (`rereviewBlock`), is independent of the workflow, and has no
  // status file, so nothing is written before the resume. The time is recorded on the review record
  // only once the message was delivered.
  async function rereviewLocked(key) {
    const entries = await freshListing();
    const launched = readObject(launchPath(key));
    const record = readReview(launched.value);
    const reason = rereviewBlock(sideActionState(record, entries, now()), entries);
    if (reason) throw refused(reason);

    const template = promptTemplate('rereview');
    const result = template
      ? await deliverToSession(key, record, fillTemplate(template, rereviewValues(key)))
      : sendFailed('prompt_unreadable');
    if (result.status === 'sent') {
      writeJson(launchPath(key), {
        ...launched.value,
        [REVIEW]: { ...launched.value[REVIEW], rereview: { at: new Date(now()).toISOString() } },
      });
    }
    const listing =
      result.status === 'sent' ? await claudeSessions.entries({ fresh: true }) : entries;
    return { ok: true, key, send: result, ticket: ticketEntry(key, listing) };
  }

  async function rereview({ key }) {
    if (!isTicketKey(key)) throw invalid('INVALID_TICKET', 'Invalid ticket.');
    return withTicketLock(key, () => rereviewLocked(key));
  }

  // The body's [id, text] pairs: a plain object of at most 20 entries, each a question id and a
  // text of at most 2000 characters. An empty list is no pairs: it saves nothing and retries a send.
  function readAnswers(answers) {
    if (Array.isArray(answers) && answers.length === 0) return [];
    const pairs =
      answers && typeof answers === 'object' && !Array.isArray(answers)
        ? Object.entries(answers)
        : null;
    const isAnswer = ([id, text]) =>
      isQuestionId(id) && typeof text === 'string' && text.length <= ANSWER_MAX_LENGTH;
    if (!pairs || pairs.length > ANSWER_LIMIT || !pairs.every(isAnswer))
      throw invalid('INVALID_ANSWER', 'Invalid answers.');
    return pairs;
  }

  // The one way a message reaches a session the dashboard started: answers, a resend, an approval
  // and a re-review all go through here, so none of them has a stop/wait/resume sequence of its own.
  //
  // A live session is stopped first (`stop` refuses one that is not idle), then its entry is polled
  // until it has no pid, every FINISH_POLL_MS for at most FINISH_POLL_LIMIT tries: a resume while the
  // process is still going down forks a copy of the session. A session that is still live at the cap
  // fails as `live_at_resume`, before `beforeResume` has written anything. The listing is read again
  // right before each decision, and `claudeSessions.resume` reads it once more before it spawns.
  //
  // `record` is the session's launch record (the planning one, or the review one). `beforeResume()`
  // is what the caller writes (status.json) once the session is known to be finished, and `onFailure()` puts it back when the resume did not deliver. Returns
  // { status: 'sent' } or { status: 'failed', reason }; the caller records what it sent only on
  // `sent`. Every failure is logged with the ticket and the session's short id; the failures of
  // `stop` and `resume` carry the CLI's output in their own line (see claude-log.mjs).
  async function deliverToSession(
    key,
    record,
    notice,
    { beforeResume = () => {}, onFailure = () => {} } = {},
  ) {
    const fail = (reason, session, step) => {
      logClaudeFailure(log, { step, reason, session: session?.id, ticket: key });
      return sendFailed(reason);
    };
    const observe = async () => {
      const listing = await claudeSessions.entries({ fresh: true });
      return { listing, session: listing ? resolveSession(listing, record) : null };
    };

    let { listing, session } = await observe();
    if (!listing) return fail('listing_unavailable', null, 'listing');
    if (!session) return fail('session_not_found', null, 'listing');
    const asked = session;
    if (typeof session.pid === 'number') {
      // The sessions module logs a stop that fails, with the CLI's output.
      const stopped = await claudeSessions.stop({ sessionId: session.sessionId, ticket: key });
      if (stopped.status !== 'stopped')
        return sendFailed(STOP_FAILURES[stopped.status] ?? 'resume_failed');
    }
    for (let attempt = 1; ; attempt += 1) {
      ({ listing, session } = await observe());
      if (!listing) return fail('listing_unavailable', asked, 'wait');
      if (!session) return fail('session_not_found', asked, 'wait');
      if (stateOf(session) === 'finished') break;
      if (attempt >= FINISH_POLL_LIMIT) return fail('live_at_resume', session, 'wait');
      await new Promise((resolve) => {
        timers.setTimeout(resolve, FINISH_POLL_MS).unref?.();
      });
    }

    // `done` is reset before the resume, so a session that finishes at once and sets it again is
    // never overwritten afterwards.
    beforeResume();
    const result = await claudeSessions.resume({
      sessionId: session.sessionId,
      notice,
      ticket: key,
    });
    const reason = resumeFailure(result);
    if (!reason) return { status: 'sent' };
    onFailure();
    return sendFailed(reason);
  }

  // Routes the saved answers back to the planning session that asked, when every question has one
  // and they differ from the last send (or `resend` asks for the whole set again). The answers are
  // saved already, so a send that cannot be made only reports why and the next save retries it;
  // nothing is rolled back and `sent` is recorded only once the resume delivered. Answers that
  // differ from the last send revise the plan, so the approval is withdrawn with the send.
  async function sendAnswers(key, { resend = false } = {}) {
    const status = readObject(statusPath(key)).value;
    const launched = readObject(launchPath(key)).value;
    const plan = answersToSend(status, launched, { resend });
    if (plan.skip) return { status: 'skipped', reason: plan.skip };

    // The message is settled first: a message file that cannot be used stops the send before the
    // session is listed, stopped or touched.
    const record = readLaunch(launched).find(({ phase }) => phase === INVESTIGATE);
    const template = promptTemplate('answers');
    if (!template) return sendFailed('prompt_unreadable');
    const notice = fillTemplate(template, {
      ...promptValues(key),
      QUESTION_IDS: plan.changed.join(', '),
      CHANGE: resend ? 'answers (sent again)' : record.sent ? 'changed answers' : 'answers',
    });
    const revised = Object.keys(plan.hashes).some(
      (id) => plan.hashes[id] !== record.sent?.answers[id],
    );

    const nextStatus = { ...status, done: false, ...(revised && { approved: false }) };
    const result = await deliverToSession(key, record, notice, {
      beforeResume: () => writeJson(statusPath(key), nextStatus),
    });
    if (result.status !== 'sent') return result;

    const sent = { at: new Date(now()).toISOString(), answers: plan.hashes };
    const next = { ...launched[INVESTIGATE], sent };
    if (revised) delete next.approved;
    writeJson(launchPath(key), { ...launched, [INVESTIGATE]: next });
    return result;
  }

  // Tells the planning session the user approved its finished plan. Approving asks for a plan that
  // is ready and marked done, so the gate is `approveBlock`. The approved flag goes into status.json
  // with the reset `done`, just before the resume (the session is not working then, which keeps the
  // file single-writer), and the file is put back as it was if the resume did not deliver.
  async function approveLocked(key) {
    const entries = await freshListing();
    const launched = readObject(launchPath(key));
    requireNoRunningSession(entries, launched);
    const status = readObject(statusPath(key));
    const reason = approveBlock(statusOf(status), launched.value, planExists(key));
    if (reason) throw refused(reason);

    const record = readLaunch(launched.value).find(({ phase }) => phase === INVESTIGATE);
    const template = promptTemplate('approve');
    const result = template
      ? await deliverToSession(key, record, fillTemplate(template, promptValues(key)), {
          beforeResume: () =>
            writeJson(statusPath(key), { ...status.value, done: false, approved: true }),
          // Nothing was delivered: the file goes back as it was, never left saying approved.
          onFailure: () => restore(statusPath(key), status),
        })
      : sendFailed('prompt_unreadable');
    if (result.status === 'sent') {
      const approved = { at: new Date(now()).toISOString() };
      writeJson(launchPath(key), {
        ...launched.value,
        [INVESTIGATE]: { ...launched.value[INVESTIGATE], approved },
      });
    }
    const listing =
      result.status === 'sent' ? await claudeSessions.entries({ fresh: true }) : entries;
    return { ok: true, key, send: result, ticket: ticketEntry(key, listing) };
  }

  async function answerLocked(key, pairs, resend) {
    const entries = await freshListing();
    const launched = readObject(launchPath(key));
    requireNoRunningSession(entries, launched);
    const { value } = readObject(statusPath(key));
    if (value === undefined) throw invalid('INVALID_ANSWER', 'The ticket has no status file.');
    if (value === null) throw refused('status_unreadable');

    // Only the answer of a question that exists changes; an empty text clears it. The hash of each
    // saved text goes on the current phase's record, which is what makes it count as answered.
    const questions = readQuestions(value);
    const current = currentRecord(launched.value);
    if (!current || pairs.some(([id]) => !questions.some((question) => question.id === id)))
      throw invalid('INVALID_ANSWER', 'Unknown question or no launch record.');
    const answered = { ...current.answered };
    const texts = new Map(pairs);
    for (const question of questions) {
      if (!texts.has(question.id)) continue;
      const text = texts.get(question.id);
      question.answer = text || null;
      if (text) answered[question.id] = answerHash(question.id, question.question, text);
      else delete answered[question.id];
    }
    // status.json first: if the second write fails the answer stays unrecorded, so unanswered.
    if (pairs.length) {
      writeJson(statusPath(key), value);
      writeJson(launchPath(key), {
        ...launched.value,
        [current.phase]: { ...launched.value[current.phase], answered },
      });
    }
    const send = await sendAnswers(key, { resend });
    // A delivered send has the session working again, which the first listing cannot show.
    const listing =
      send.status === 'sent' ? await claudeSessions.entries({ fresh: true }) : entries;
    return { ok: true, key, send, ticket: ticketEntry(key, listing) };
  }

  // `resend` asks for the saved answers to go again even when they match the last send.
  async function answer({ key, answers, resend = false }) {
    if (!isTicketKey(key)) throw invalid('INVALID_TICKET', 'Invalid ticket.');
    const pairs = readAnswers(answers);
    return withTicketLock(key, () => answerLocked(key, pairs, resend === true));
  }

  async function approve({ key }) {
    if (!isTicketKey(key)) throw invalid('INVALID_TICKET', 'Invalid ticket.');
    return withTicketLock(key, () => approveLocked(key));
  }

  // The launch.json and e2e record of a ticket whose finished e2e session still has its browser to
  // handle, else null. Either marker means it was handled, so it is never tried again.
  function e2eBrowserToStop(key, entries) {
    const launched = readObject(launchPath(key));
    const record = launched.value?.[E2E];
    const pending =
      BROWSER_ID.test(record?.browserId) &&
      record.browserStoppedAt === undefined &&
      record.browserStopFailed === undefined &&
      ['done', 'failed'].includes(ticketEntry(key, entries).e2e.state);
    return pending ? { launched, record } : null;
  }

  // Stops the browser of a finished e2e session once. A browser already stopped or gone needs no
  // stop. A stop that fails is logged and recorded, and the browser stays in the DevTools tab.
  // Under the ticket lock the record is read again, so overlapping lists stop it once and a relaunch
  // in between is never touched.
  const stopE2eBrowser = (key, entries) =>
    withTicketLock(key, async () => {
      const pending = e2eBrowserToStop(key, entries);
      if (!pending) return;
      const { launched, record } = pending;
      let marker;
      try {
        const browser = (await browsers.list()).find(({ id }) => id === record.browserId);
        if (browser?.status === 'running') await browsers.stop(record.browserId);
        marker = { browserStoppedAt: now() };
      } catch (error) {
        logClaudeFailure(log, { step: 'e2e_browser_stop', reason: error.code, ticket: key });
        marker = { browserStopFailed: error.code ?? 'STOP_FAILED' };
      }
      writeJson(launchPath(key), { ...launched.value, [E2E]: { ...record, ...marker } });
    });

  // The newest transcript time of each phase's session, as ISO strings: `{ KEY: { phase: iso } }`,
  // sparse, so a ticket with no time has no key. With no session at all, no transcript is read.
  async function lastActiveOf(keys, entries) {
    const sessionsOf = new Map(
      keys.map((key) => [key, phaseSessions(readObject(launchPath(key)).value ?? null, entries)]),
    );
    const sessions = new Map();
    for (const phases of sessionsOf.values())
      for (const session of Object.values(phases))
        if (session) sessions.set(session.sessionId, session);
    if (!sessions.size) return {};
    const times = await claudeSessions.lastActive([...sessions.values()]);
    const lastActive = {};
    for (const [key, phases] of sessionsOf) {
      const iso = {};
      for (const [phase, session] of Object.entries(phases))
        if (session && times.has(session.sessionId))
          iso[phase] = new Date(times.get(session.sessionId)).toISOString();
      if (Object.keys(iso).length) lastActive[key] = iso;
    }
    return lastActive;
  }

  // Every ticket folder's entry from one shared listing; no folder, no CLI call. This is the one
  // place a finished e2e session is seen, so its browser is stopped here; that never fails the list.
  async function list() {
    const keys = ticketKeys();
    const entries = keys.length ? await claudeSessions.entries() : [];
    const stopping = keys.filter((key) => e2eBrowserToStop(key, entries));
    const settled = await Promise.allSettled(stopping.map((key) => stopE2eBrowser(key, entries)));
    settled.forEach((result, index) => {
      if (result.status === 'rejected')
        logClaudeFailure(log, {
          step: 'e2e_browser_marker',
          reason: result.reason?.code,
          ticket: stopping[index],
        });
    });
    return {
      listing: entries ? 'ok' : 'unavailable',
      updatedAt: now(),
      tickets: Object.fromEntries(keys.map((key) => [key, ticketEntry(key, entries)])),
      lastActive: entries ? await lastActiveOf(keys, entries) : {},
    };
  }

  return { list, launch, answer, approve, rereview };
}
