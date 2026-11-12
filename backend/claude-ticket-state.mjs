// claude-ticket-state.mjs — the pure rules behind the Claude launcher: which ticket keys and session
// names are valid, how a ticket's two state files are read, which listed session belongs to a
// ticket, and the one entry (state, blocked actions, a go-to command per phase) its card shows.
//
// Nothing here touches the filesystem or the CLI. Text from the listing or from a state file never
// reaches a command: a go-to command is built only from ids that pass a pattern.

import { createHash } from 'node:crypto';
import { isSessionId } from './slack-watch-store.mjs';

export const INVESTIGATE = 'investigate-and-plan';
export const IMPLEMENT = 'implement-plan';
export const PHASES = [INVESTIGATE, IMPLEMENT];
// Side actions have their own records and sessions; workflow flags, answers and gates ignore them.
export const GROOM = 'groom';
export const REVIEW = 'pr-review-transact';
export const SPEC_REVIEW = 'spec-review';
export const E2E = 'e2e-ticket-check';

const TICKET_KEY = /^[A-Z]{1,10}-\d{1,7}$/;
const QUESTION_ID = /^[A-Za-z0-9_-]{1,32}$/;
const SHORT_ID = /^[0-9a-f]{8}$/;
const QUESTION_LIMIT = 20;
const QUESTION_TEXT_LIMIT = 500;
export const ANSWER_MAX_LENGTH = 2000;
// A session the CLI has not listed yet is still starting for this long after its launch.
const START_WINDOW_MS = 30_000;
// `stopped` is what the CLI lists for a session ended with `claude stop` (no process): finished and
// resumable, so it is treated exactly as `done` wherever the state is read.
const FINISHED_STATES = ['done', 'stopped'];
const KNOWN_STATES = ['working', 'blocked', ...FINISHED_STATES];

const isText = (value) => typeof value === 'string';
// `done` is the session's word that the planning phase is complete; anything but true reads false.
const isDone = (status) => status?.done === true;
// `approved` is the dashboard's record that the user approved the finished plan; only true counts,
// so a status.json without the key reads as not approved.
const isApproved = (status) => status?.approved === true;

export const isTicketKey = (value) => isText(value) && TICKET_KEY.test(value);
export const isQuestionId = (value) => isText(value) && QUESTION_ID.test(value);
export const isShortId = (value) => isText(value) && SHORT_ID.test(value);

// The key and the phase: the two sessions of a ticket have different names. The longest valid key
// gives 39 characters, under the 40 at which the CLI's listing starts to abbreviate a name.
export const sessionName = (key, phase) => `${key}-${phase}`;

const RUNNING_REASONS = { [INVESTIGATE]: 'investigate_running', [IMPLEMENT]: 'implement_running' };

// Why `asked` cannot start while the session of phase `running` works: the same phase is already
// running, and another phase names the one that is.
export const runningBlock = (running, asked) =>
  running === asked ? 'session_running' : RUNNING_REASONS[running];

const isQuestion = (value) =>
  Boolean(value) && typeof value === 'object' && isQuestionId(value.id) && isText(value.question);

// The questions of a parsed status.json that the dashboard reads, as the parsed objects themselves
// so an answer can be set on them without disturbing any other field.
export function readQuestions(status) {
  const questions = Array.isArray(status?.questions) ? status.questions : [];
  return questions.filter(isQuestion).slice(0, QUESTION_LIMIT);
}

// The hash the dashboard records for an answer it saved: the question's id and full text and the
// exact answer, never trimmed. An edit of the question changes it too.
export const answerHash = (id, question, answer) =>
  createHash('sha256').update(`${id}\n${question}\n${answer}`).digest('hex');

// An answer counts only when it is the one the dashboard saved for that question (its hash is in
// a launch.json record): the session can write status.json too, and an answer it wrote itself, or
// an edit of a saved answer or question, reads as no answer.
function answerCheck(launch) {
  const saved = new Set(
    readLaunch(launch).flatMap(({ answered }) =>
      Object.entries(answered).map(([id, hash]) => `${id}:${hash}`),
    ),
  );
  return ({ id, question, answer }) =>
    isText(answer) && saved.has(`${id}:${answerHash(id, question, answer)}`);
}

// The questions as the card shows them.
function questionViews(status, launch) {
  const isSaved = answerCheck(launch);
  return readQuestions(status).map((question) => ({
    id: question.id,
    question: question.question.slice(0, QUESTION_TEXT_LIMIT),
    answer: isSaved(question) ? question.answer.slice(0, ANSWER_MAX_LENGTH) : null,
  }));
}

// The status.json an implement launch writes: the locked shape with the investigate flag set, `done`
// and `approved` as they were, and the questions the dashboard reads, each whole, keeping only the
// answers it saved. Nothing else the session left in the file survives.
export function implementStatus(status, launch) {
  const isSaved = answerCheck(launch);
  return {
    [INVESTIGATE]: true,
    [IMPLEMENT]: false,
    done: isDone(status),
    approved: isApproved(status),
    questions: readQuestions(status).map((question) => ({
      id: question.id,
      question: question.question,
      answer: isSaved(question) ? question.answer : null,
    })),
  };
}

// A question is unanswered when its answer is null, missing or blank.
const isUnanswered = ({ answer }) => !(isText(answer) && answer.trim());

// Why the plan cannot be approved from this status.json (null: unreadable), launch.json and plan
// file, or null when it can: the plan is ready (planned, the file there, every question answered
// and the answers sent) and the session has marked it `done`. Answers not yet sent to the planning
// session block it, so an answer whose send failed is never approved against a stale `done`.
function planReadyBlock(status, launch, planPresent) {
  if (status === null) return 'status_unreadable';
  if (status?.[INVESTIGATE] !== true) return 'not_planned';
  if (!planPresent) return 'plan_missing';
  if (questionViews(status, launch).some(isUnanswered)) return 'questions_unanswered';
  if (!answersToSend(status, launch).skip) return 'answers_not_sent';
  return isDone(status) ? null : 'plan_not_done';
}

// Why implement cannot start, or null when it can: the plan is ready and the user approved it.
export const implementBlock = (status, launch, planPresent) =>
  planReadyBlock(status, launch, planPresent) ?? (isApproved(status) ? null : 'not_approved');

// Why Approve is refused, or null when it can be sent: the plan is ready, no implement run has
// started and the approval is not already given.
export function approveBlock(status, launch, planPresent) {
  const reason = planReadyBlock(status, launch, planPresent);
  if (reason) return reason;
  const records = readLaunch(launch);
  if (!records.some(({ phase }) => phase === INVESTIGATE)) return 'not_planned';
  if (records.some(({ phase }) => phase === IMPLEMENT)) return 'implement_started';
  return isApproved(status) ? 'already_approved' : null;
}

// Why the saved answers cannot be sent again as they are, or null when they can: the gates of
// `answersToSend` without the one that skips an unchanged set.
export function resendBlock(status, launch) {
  if (status === null) return 'status_unreadable';
  if (readQuestions(status).length === 0) return 'no_questions';
  const { skip } = answersToSend(status, launch, { resend: true });
  return skip === 'incomplete' ? 'questions_unanswered' : (skip ?? null);
}

// The part every launch.json record shares, { name, launchedAt, id }, or null when the value is not
// shaped like a record. An id that is not a short id is no id.
function readRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (!isText(record.name) || !Number.isFinite(record.launchedAt)) return null;
  return {
    name: record.name,
    launchedAt: record.launchedAt,
    id: isShortId(record.id) ? record.id : null,
  };
}

// A map of question id to hash, keeping only the text values.
const textHashes = (hashes) =>
  hashes && typeof hashes === 'object'
    ? Object.fromEntries(Object.entries(hashes).filter(([, hash]) => isText(hash)))
    : {};

// The phases launch.json records, each as { phase, name, launchedAt, id, answered, sent, approved }.
// An entry that is not shaped like a record is ignored, an id that is not a short id is no id,
// `answered` (question id to the hash of its saved answer) keeps only text values, `sent` is what the
// last send to the session recorded, { at, answers } with `answers` shaped like `answered`, or null,
// and `approved` is { at } once Approve was delivered, or null.
export function readLaunch(launch) {
  return PHASES.flatMap((phase) => {
    const base = readRecord(launch?.[phase]);
    if (!base) return [];
    const record = launch[phase];
    const sent =
      record.sent && typeof record.sent === 'object'
        ? { at: record.sent.at, answers: textHashes(record.sent.answers) }
        : null;
    const approved =
      record.approved && typeof record.approved === 'object' ? { at: record.approved.at } : null;
    return [{ phase, ...base, answered: textHashes(record.answered), sent, approved }];
  });
}

// The groom record of launch.json, shaped like a phase record, or null.
export const readGroom = (launch) => readRecord(launch?.[GROOM]);
// The spec review record of launch.json, shaped like a phase record, or null.
export const readSpecReview = (launch) => readRecord(launch?.[SPEC_REVIEW]);
// The e2e check record of launch.json, shaped like a phase record, or null.
export const readE2e = (launch) => readRecord(launch?.[E2E]);
// The review record, with `rereview` ({ at } once a Re-review was delivered to its session, else null).
export function readReview(launch) {
  const base = readRecord(launch?.[REVIEW]);
  if (!base) return null;
  const { rereview } = launch[REVIEW];
  return {
    ...base,
    rereview: rereview && typeof rereview === 'object' ? { at: rereview.at } : null,
  };
}

// The record of the phase launched last: the one the card shows and an answer is saved on.
export const currentRecord = (launch) =>
  readLaunch(launch).reduce(
    (latest, next) => (!latest || next.launchedAt >= latest.launchedAt ? next : latest),
    null,
  );

// The listing entry that is the record's session: the one carrying its id when one is recorded,
// otherwise a same-name entry that started at or after the launch (one started earlier is another
// run). The newest wins. Returns null when none matches.
export function resolveSession(entries, { name, launchedAt, id }) {
  const matches = entries.filter((entry) =>
    id ? entry.id === id : entry.name === name && entry.startedAt >= launchedAt,
  );
  return matches.reduce(
    (newest, entry) => (!newest || entry.startedAt > newest.startedAt ? entry : newest),
    null,
  );
}

// A launch time far in the future (a forged or skewed file) is not a start in progress either.
const isRunning = (session, { launchedAt }, now) =>
  session ? session.state === 'working' : Math.abs(now - launchedAt) < START_WINDOW_MS;

// Whether the record's session works, or was launched too recently to be listed.
export const sessionRunning = (entries, record, now) =>
  isRunning(resolveSession(entries, record), record, now);

// The hash of every question whose saved answer counts, by question id: the shape of `answered`
// and of a send's `answers`.
function savedHashes(status, launch) {
  const isSaved = answerCheck(launch);
  return Object.fromEntries(
    readQuestions(status)
      .filter(isSaved)
      .map(({ id, question, answer }) => [id, answerHash(id, question, answer)]),
  );
}

// Whether the saved answers should go to the planning session: { skip: reason } when not (the first
// of: every question answered, the plan flag set, no implement run, an answer that differs from the
// last send), otherwise { changed } (the ids of the answers that are new or differ from the last
// send) and { hashes } (every question's hash, to record once the send is delivered). A `resend`
// sends the whole set again: an unchanged set is no reason to skip and every id is listed.
export function answersToSend(status, launch, { resend = false } = {}) {
  const questions = questionViews(status, launch);
  if (questions.length === 0 || questions.some(isUnanswered)) return { skip: 'incomplete' };
  if (status?.[INVESTIGATE] !== true) return { skip: 'not_planned' };
  const records = readLaunch(launch);
  if (records.some(({ phase }) => phase === IMPLEMENT)) return { skip: 'implement_started' };
  const sent = records.find(({ phase }) => phase === INVESTIGATE)?.sent?.answers ?? {};
  const hashes = savedHashes(status, launch);
  const changed = Object.keys(hashes).filter((id) => resend || hashes[id] !== sent[id]);
  return changed.length ? { changed, hashes } : { skip: 'unchanged' };
}

// The state and reason of the current phase: the first row of the truth table that matches.
function classify({ record, session, entries, now, flag, unanswered, planPresent, done, unsent }) {
  if (!entries) return { state: 'unknown', reason: 'listing_unavailable' };
  if (session && !KNOWN_STATES.includes(session.state))
    return { state: 'unknown', reason: 'unrecognised_state' };
  if (isRunning(session, record, now))
    return { state: 'working', reason: session ? 'running' : 'starting' };
  if (session?.state === 'blocked') return { state: 'waiting', reason: 'blocked' };
  if (unanswered > 0) return { state: 'waiting', reason: 'questions' };
  if (flag) {
    if (record.phase === INVESTIGATE) {
      if (!planPresent) return { state: 'failed', reason: 'plan_missing' };
      if (unsent) return { state: 'waiting', reason: 'answers_not_sent' };
      return done
        ? { state: 'done', reason: 'plan_ready' }
        : { state: 'failed', reason: 'plan_not_done' };
    }
    return { state: 'done', reason: 'implemented' };
  }
  return { state: 'failed', reason: session ? 'ended_without_flag' : 'session_missing' };
}

// How to join the session in a terminal. A live or blocked session is attached by its short id; a
// finished one is resumed by its session id, from the directory it started in.
function goToFor(session) {
  if (!session || !KNOWN_STATES.includes(session.state)) return null;
  if (typeof session.pid === 'number' || session.state === 'blocked')
    return isShortId(session.id)
      ? { kind: 'attach', command: `claude attach ${session.id}` }
      : null;
  return FINISHED_STATES.includes(session.state) && isSessionId(session.sessionId)
    ? { kind: 'resume', command: `cd ~/pathwise && claude --resume ${session.sessionId}` }
    : null;
}

// The listing entry each own session resolves to: `{ investigate, implement, review, groom }` (plus
// `e2e` for a ticket with an e2e check record), each the entry its record resolves to, or null. A
// record that is missing, or no listing, resolves to nothing.
export function phaseSessions(launch, entries) {
  const records = readLaunch(launch);
  const resolve = (record) => (record && entries ? resolveSession(entries, record) : null);
  const phase = (name) => resolve(records.find((found) => found.phase === name));
  const e2e = readE2e(launch);
  return {
    investigate: phase(INVESTIGATE),
    implement: phase(IMPLEMENT),
    review: resolve(readReview(launch)),
    groom: resolve(readGroom(launch)),
    ...(e2e && { e2e: resolve(e2e) }),
  };
}

// How to join each own session: `{ investigate, implement, groom }` (plus `e2e` for a ticket with an
// e2e check record), each a goToFor result for the session phaseSessions resolves. Review has none.
function goToAll(launch, entries) {
  return Object.fromEntries(
    Object.entries(phaseSessions(launch, entries))
      .filter(([phase]) => phase !== 'review')
      .map(([phase, session]) => [phase, goToFor(session)]),
  );
}

// Independent sessions finish without writing a workflow flag.
export function sideActionState(record, entries, now) {
  if (!record) return { state: 'none', reason: null };
  if (!entries) return { state: 'unknown', reason: 'listing_unavailable' };
  const session = resolveSession(entries, record);
  if (session && !KNOWN_STATES.includes(session.state))
    return { state: 'unknown', reason: 'unrecognised_state' };
  if (isRunning(session, record, now))
    return { state: 'working', reason: session ? 'running' : 'starting' };
  if (!session) return { state: 'failed', reason: 'session_missing' };
  return session.state === 'blocked'
    ? { state: 'waiting', reason: 'blocked' }
    : { state: 'done', reason: 'finished' };
}

// The block on a side action's own launch: no listing, its own session working, or none.
const ownSessionBlock = (side, entries) =>
  !entries ? 'listing_unavailable' : side.state === 'working' ? 'session_running' : null;

export function reviewBlock(review, entries) {
  if (!entries) return 'listing_unavailable';
  if (review.state === 'unknown') return review.reason;
  return review.state === 'working' ? 'session_running' : null;
}

// Why a Re-review cannot be sent to the ticket's review session, or null when it can: the session
// must exist (a record, and one the listing still shows) and be neither working nor waiting on you.
export function rereviewBlock(review, entries) {
  if (review.state === 'none') return 'no_review_session';
  if (!entries) return 'listing_unavailable';
  if (review.state === 'unknown') return review.reason;
  if (review.state === 'failed') return 'session_not_found';
  return review.state === 'done' ? null : 'session_running';
}

// The entry for one ticket. `status` and `launch` are the parsed files (null when a file is not a
// JSON object), `entries` is the CLI listing (null when unavailable) and `planPresent` says whether
// the plan file exists.
export function deriveEntry({ status, launch, entries, now, planPresent }) {
  const flags = {
    [INVESTIGATE]: status?.[INVESTIGATE] === true,
    [IMPLEMENT]: status?.[IMPLEMENT] === true,
    done: isDone(status),
    approved: isApproved(status),
  };
  const questions = questionViews(status, launch);
  const sendable = !answersToSend(status, launch).skip;
  const unanswered = questions.filter(isUnanswered).length;
  const record = currentRecord(launch);
  const session = record && entries ? resolveSession(entries, record) : null;
  const { state, reason } = record
    ? classify({
        record,
        session,
        entries,
        now,
        flag: flags[record.phase],
        unanswered,
        planPresent,
        done: flags.done,
        unsent: sendable,
      })
    : { state: 'none', reason: null };

  const running = state === 'working' ? record.phase : null;
  const busy = (asked) =>
    state === 'unknown' ? 'listing_unavailable' : running && runningBlock(running, asked);
  const groomRecord = readGroom(launch);
  const groom = sideActionState(groomRecord, entries, now);
  const review = sideActionState(readReview(launch), entries, now);
  const specReviewRecord = readSpecReview(launch);
  const specReview = sideActionState(specReviewRecord, entries, now);
  const e2eRecord = readE2e(launch);
  const e2e = sideActionState(e2eRecord, entries, now);
  const blocks = {
    investigate: busy(INVESTIGATE) || null,
    implement: busy(IMPLEMENT) || implementBlock(status, launch, planPresent),
    // An answer is refused while either phase works.
    answer:
      busy(running) ||
      (status === null ? 'status_unreadable' : questions.length === 0 ? 'no_questions' : null),
    // Resend and Approve go to the planning session, so either phase working refuses them.
    resend: busy(running) || resendBlock(status, launch),
    approve: busy(running) || approveBlock(status, launch, planPresent),
    // Only a groom session of its own blocks grooming; the workflow never does.
    groom: ownSessionBlock(groom, entries),
    review: reviewBlock(review, entries),
    rereview: rereviewBlock(review, entries),
    // The key is there only for a ticket with a spec review record, so the blocks of every other
    // ticket keep the shape they had.
    ...(specReviewRecord && { specReview: ownSessionBlock(specReview, entries) }),
    ...(e2eRecord && { e2e: ownSessionBlock(e2e, entries) }),
  };
  return {
    phase: record?.phase ?? null,
    state,
    reason,
    flags,
    reviewResentAt: readReview(launch)?.rereview?.at ?? null,
    approvedAt: readLaunch(launch).find(({ phase }) => phase === INVESTIGATE)?.approved?.at ?? null,
    questions,
    unanswered,
    unsent: sendable && state !== 'working' && state !== 'unknown',
    groom,
    review,
    specReview,
    e2e,
    blocks,
    goTo: goToAll(launch, entries),
  };
}
