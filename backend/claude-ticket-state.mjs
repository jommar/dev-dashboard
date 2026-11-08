// claude-ticket-state.mjs — the pure rules behind the Claude launcher: which ticket keys and session
// names are valid, how a ticket's two state files are read, which listed session belongs to a
// ticket, and the one entry (state, blocked actions, go-to command) its card shows.
//
// Nothing here touches the filesystem or the CLI. Text from the listing or from a state file never
// reaches a command: a go-to command is built only from ids that pass a pattern.

import { createHash } from 'node:crypto';
import { isSessionId } from './slack-watch-store.mjs';

export const INVESTIGATE = 'investigate-and-plan';
export const IMPLEMENT = 'implement-plan';
export const PHASES = [INVESTIGATE, IMPLEMENT];

const TICKET_KEY = /^[A-Z]{1,10}-\d{1,7}$/;
const QUESTION_ID = /^[A-Za-z0-9_-]{1,32}$/;
const SHORT_ID = /^[0-9a-f]{8}$/;
// The length at which the CLI's listing starts to abbreviate a session name.
const NAME_LIMIT = 40;
const SUMMARY_LIMIT = 200;
const QUESTION_LIMIT = 20;
const QUESTION_TEXT_LIMIT = 500;
export const ANSWER_MAX_LENGTH = 2000;
// A session the CLI has not listed yet is still starting for this long after its launch.
const START_WINDOW_MS = 30_000;
const KNOWN_STATES = ['working', 'blocked', 'done'];

const isText = (value) => typeof value === 'string';

export const isTicketKey = (value) => isText(value) && TICKET_KEY.test(value);
export const isQuestionId = (value) => isText(value) && QUESTION_ID.test(value);
export const isShortId = (value) => isText(value) && SHORT_ID.test(value);

// The key, then a slug of the summary when it leaves one. The summary is untrusted ticket text:
// this is the only place it is used, and only lower-case letters, digits and hyphens survive.
export function sessionName(key, summary) {
  const slug = String(summary ?? '')
    .slice(0, SUMMARY_LIMIT)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_LIMIT - key.length - 1)
    .replace(/-+$/, '');
  return slug ? `${key}-${slug}` : key;
}

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

// The status.json an implement launch writes: the locked shape with the investigate flag set, and
// the questions the dashboard reads, each whole, keeping only the answers it saved. Nothing else
// the session left in the file survives.
export function implementStatus(status, launch) {
  const isSaved = answerCheck(launch);
  return {
    [INVESTIGATE]: true,
    [IMPLEMENT]: false,
    questions: readQuestions(status).map((question) => ({
      id: question.id,
      question: question.question,
      answer: isSaved(question) ? question.answer : null,
    })),
  };
}

// A question is unanswered when its answer is null, missing or blank.
const isUnanswered = ({ answer }) => !(isText(answer) && answer.trim());

// Why implement cannot start from this status.json (null: unreadable), launch.json and plan file,
// or null when it can.
export function implementBlock(status, launch, planPresent) {
  if (status === null) return 'status_unreadable';
  if (status?.[INVESTIGATE] !== true) return 'not_planned';
  if (!planPresent) return 'plan_missing';
  return questionViews(status, launch).some(isUnanswered) ? 'questions_unanswered' : null;
}

// The phases launch.json records, each as { phase, name, launchedAt, id, answered }. An entry that
// is not shaped like a record is ignored, an id that is not a short id is no id, and `answered`
// (question id to the hash of its saved answer) keeps only text values.
export function readLaunch(launch) {
  return PHASES.flatMap((phase) => {
    const record = launch?.[phase];
    if (!record || typeof record !== 'object') return [];
    if (!isText(record.name) || !Number.isFinite(record.launchedAt)) return [];
    const id = isShortId(record.id) ? record.id : null;
    const answered =
      record.answered && typeof record.answered === 'object'
        ? Object.fromEntries(Object.entries(record.answered).filter(([, hash]) => isText(hash)))
        : {};
    return [{ phase, name: record.name, launchedAt: record.launchedAt, id, answered }];
  });
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

// The state and reason of the current phase: the first row of the truth table that matches.
function classify({ record, session, entries, now, flag, unanswered, planPresent }) {
  if (!entries) return { state: 'unknown', reason: 'listing_unavailable' };
  if (session && !KNOWN_STATES.includes(session.state))
    return { state: 'unknown', reason: 'unrecognised_state' };
  if (isRunning(session, record, now))
    return { state: 'working', reason: session ? 'running' : 'starting' };
  if (session?.state === 'blocked') return { state: 'waiting', reason: 'blocked' };
  if (unanswered > 0) return { state: 'waiting', reason: 'questions' };
  if (flag) {
    if (record.phase === INVESTIGATE) {
      return planPresent
        ? { state: 'done', reason: 'plan_ready' }
        : { state: 'failed', reason: 'plan_missing' };
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
  return session.state === 'done' && isSessionId(session.sessionId)
    ? { kind: 'resume', command: `cd ~/pathwise && claude --resume ${session.sessionId}` }
    : null;
}

// The entry for one ticket. `status` and `launch` are the parsed files (null when a file is not a
// JSON object), `entries` is the CLI listing (null when unavailable) and `planPresent` says whether
// the plan file exists.
export function deriveEntry({ status, launch, entries, now, planPresent }) {
  const flags = {
    [INVESTIGATE]: status?.[INVESTIGATE] === true,
    [IMPLEMENT]: status?.[IMPLEMENT] === true,
  };
  const questions = questionViews(status, launch);
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
      })
    : { state: 'none', reason: null };

  const investigate = { unknown: 'listing_unavailable', working: 'session_running' }[state] ?? null;
  const blocks = {
    investigate,
    implement: investigate ?? implementBlock(status, launch, planPresent),
    answer:
      investigate ??
      (status === null ? 'status_unreadable' : questions.length === 0 ? 'no_questions' : null),
  };
  return {
    phase: record?.phase ?? null,
    state,
    reason,
    flags,
    questions,
    unanswered,
    blocks,
    goTo: goToFor(session),
  };
}
